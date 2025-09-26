// ==============================================
// ARTEFACT • Full Server (Express + better-sqlite3)
// + BONUS sekcija + PayPal + Bonus kodovi (5 slotova)
// ==============================================

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ---------- Konfiguracija
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";
const TOKEN_NAME = "token";
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || "judi.vinko81@gmail.com").toLowerCase();

const DB_FILE = process.env.DB_PATH || path.join(__dirname, "data", "artefact.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE, { verbose: console.log });

/* ===== PAYPAL CONFIG ===== */
const USD_TO_GOLD = 100;                             // 1 USD = 100 gold
const MIN_USD = 10;                                  // minimalna uplata
const PAYPAL_MODE = (process.env.PAYPAL_MODE || "sandbox").toLowerCase(); // "live" | "sandbox"
const PAYPAL_BASE = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_SECRET    = process.env.PAYPAL_SECRET    || "";

// ---------- Auto-cleanup slika koje počinju sa "0" (pri startu; rekurzivno + logs)
function deleteFilesStartingWith0(rootDir) {
  try {
    if (!fs.existsSync(rootDir)) return { checked: 0, deleted: 0, found: [] };
    const stack = [rootDir];
    let deleted = 0, checked = 0;
    const found = [];
    while (stack.length) {
      const dir = stack.pop();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else {
          checked++;
          if (ent.name.startsWith("0")) {
            found.push(full);
            try { fs.unlinkSync(full); deleted++; }
            catch (e) { console.error("[CLEANUP] Greška brisanja:", full, e); }
          }
        }
      }
    }
    return { checked, deleted, found };
  } catch (e) {
    console.error("[CLEANUP] Greška skeniranja:", e);
    return { checked: 0, deleted: 0, found: [] };
  }
}

(() => {
  const dirImages = path.join(__dirname, "public", "images");
  const dirPublic = path.join(__dirname, "public");
  const r1 = deleteFilesStartingWith0(dirImages);
  let r = r1;
  if (r1.deleted === 0 && r1.checked === 0) {
    const r2 = deleteFilesStartingWith0(dirPublic);
    r = { checked: r1.checked + r2.checked, deleted: r1.deleted + r2.deleted, found: [...r1.found, ...r2.found] };
  }
  console.log(`[CLEANUP] Pregledano: ${r.checked}, obrisano: ${r.deleted}`);
  if (r.found.length) {
    console.log("[CLEANUP] Obrisano:", r.found.map(p => p.replace(__dirname, "")).join(" | "));
  } else {
    console.log("[CLEANUP] Nije našao fajlove koji počinju sa " + JSON.stringify("0") + " u /public(/images)");
  }
})();

// ---------- App
const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

// Static
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));



// ===== Helpers (generic) =====
const nowISO = () => new Date().toISOString();
function isEmail(x){ return typeof x==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x); }
function isPass(x){ return typeof x==="string" && x.length>=6; }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function readToken(req){
  const t = req.cookies && req.cookies[TOKEN_NAME];
  if(!t) return null;
  try{ return jwt.verify(t, JWT_SECRET); }catch{ return null; }
}
function verifyTokenFromCookies(req) {
  const tok = readToken(req);
  if (!tok) return null;
  return { uid: tok.uid, email: tok.email };
}
function requireAuth(req) {
  const tok = readToken(req);
  if (!tok) throw new Error("Not logged in.");
  const u = db.prepare("SELECT id,is_disabled FROM users WHERE id=?").get(tok.uid);
  if (!u || u.is_disabled) throw new Error("Account disabled");
  return u.id;
}
function isAdmin(req){
  const hdr = (req.headers["x-admin-key"] || req.headers["X-Admin-Key"] || "").toString();
  if (hdr && hdr === ADMIN_KEY) return true;
  const tok = readToken(req); if (!tok) return false;
  const r = db.prepare("SELECT is_admin FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin===1);
}
function addMinutes(iso, mins){
  const d = new Date(iso); d.setMinutes(d.getMinutes()+mins); return d.toISOString();
}

/* ===== PayPal helpers ===== */
// Node 18+ ima globalni fetch
async function paypalToken(){
  const res = await fetch(PAYPAL_BASE + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(PAYPAL_CLIENT_ID + ":" + PAYPAL_SECRET).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  if(!res.ok) throw new Error("PayPal token fail: " + JSON.stringify(data));
  return data.access_token;
}
async function paypalGetOrder(accessToken, orderId){
  const res = await fetch(PAYPAL_BASE + "/v2/checkout/orders/" + encodeURIComponent(orderId), {
    headers: { "Authorization": "Bearer " + accessToken }
  });
  const data = await res.json();
  if(!res.ok) throw new Error("PayPal order fail: " + JSON.stringify(data));
  return data;
}
// ---------- DB lokacija + instanca (JEDINA)
const DB_FILE = process.env.DB_PATH || path.join(__dirname, "data", "artefact.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

console.log("[DB] Using file:", DB_FILE);


// ====== DB MIGRATIONS ======
function ensure(sql){ db.exec(sql); }
function tableExists(name) {
  try { return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name); }
  catch { return false; }
}
function hasColumn(table, col) {
  try { return !!db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === col); }
  catch { return false; }
}

ensure(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  balance_silver INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  shop_buy_count INTEGER NOT NULL DEFAULT 0,
  next_recipe_at INTEGER
);`);

ensure(`
CREATE TABLE IF NOT EXISTS gold_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta_s INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);`);

ensure(`
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  volatile INTEGER NOT NULL DEFAULT 0,
  bonus_gold INTEGER NOT NULL DEFAULT 0
);`);

ensure(`
CREATE TABLE IF NOT EXISTS user_items(
  user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,item_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(item_id) REFERENCES items(id)
);`);

ensure(`
CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  output_item_id INTEGER NOT NULL,
  FOREIGN KEY(output_item_id) REFERENCES items(id)
);`);

ensure(`
CREATE TABLE IF NOT EXISTS recipe_ingredients(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  FOREIGN KEY(recipe_id) REFERENCES recipes(id),
  FOREIGN KEY(item_id) REFERENCES items(id)
);`);

ensure(`
CREATE TABLE IF NOT EXISTS user_recipes(
  user_id INTEGER NOT NULL,
  recipe_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,recipe_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(recipe_id) REFERENCES recipes(id)
);`);

ensure(`
CREATE TABLE IF NOT EXISTS inventory_escrow(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER,
  owner_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);`);

ensure(`
CREATE TABLE IF NOT EXISTS auctions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  start_price_s INTEGER NOT NULL DEFAULT 0,
  buy_now_price_s INTEGER,
  fee_bps INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'live',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  winner_user_id INTEGER,
  sold_price_s INTEGER,
  highest_bid_s INTEGER,
  highest_bidder_user_id INTEGER
);`);

// ====== BONUS: tablica za trajne set-bonuse ======
ensure(`
CREATE TABLE IF NOT EXISTS set_bonuses(
  user_id INTEGER NOT NULL,
  tier INTEGER NOT NULL CHECK(tier IN (2,3,4,5)),
  claimed_at TEXT NOT NULL,
  PRIMARY KEY(user_id, tier),
  FOREIGN KEY(user_id) REFERENCES users(id)
);`);

// ====== PayPal uplate ======
ensure(`
CREATE TABLE IF NOT EXISTS paypal_payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paypal_order_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  credited_silver INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);`);
if (!hasColumn("paypal_payments","bonus_code")) {
  db.exec(`ALTER TABLE paypal_payments ADD COLUMN bonus_code TEXT;`);
}
if (!hasColumn("paypal_payments","bonus_percent")) {
  db.exec(`ALTER TABLE paypal_payments ADD COLUMN bonus_percent INTEGER;`);
}
if (!hasColumn("paypal_payments","bonus_extra_silver")) {
  db.exec(`ALTER TABLE paypal_payments ADD COLUMN bonus_extra_silver INTEGER;`);
}

// ====== BONUS CODES (5 slotova) ======
ensure(`
CREATE TABLE IF NOT EXISTS bonus_codes(
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 5),
  code TEXT NOT NULL UNIQUE,
  percent INTEGER NOT NULL DEFAULT 0 CHECK(percent BETWEEN 0 AND 100),
  total_credited_silver INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);`);

for (let i = 1; i <= 5; i++) {
  const row = db.prepare("SELECT 1 FROM bonus_codes WHERE id=?").get(i);
  if (!row) {
    db.prepare(`
      INSERT INTO bonus_codes(id, code, percent, total_credited_silver, is_active)
      VALUES (?,?,?,?,1)
    `).run(i, `SLOT${i}`, 0, 0);
  }
}

// --- seed helpers ---
function ensureItem(code, name, tier, volatile = 0) {
  const row = db.prepare("SELECT id FROM items WHERE code=?").get(code);
  if (row) {
    db.prepare("UPDATE items SET name=?, tier=?, volatile=? WHERE id=?").run(name, tier, volatile, row.id);
    return row.id;
  }
  db.prepare("INSERT INTO items(code,name,tier,volatile) VALUES (?,?,?,?)").run(code, name, tier, volatile);
  return db.prepare("SELECT id FROM items WHERE code=?").get(code).id;
}
function idByCode(code){ const r=db.prepare("SELECT id FROM items WHERE code=?").get(code); return r&&r.id; }
function ensureRecipe(code, name, tier, outCode, ingCodes) {
  const outId = idByCode(outCode); if(!outId) throw new Error("Missing item "+outCode);
  const r = db.prepare("SELECT id FROM recipes WHERE code=?").get(code);
  let rid;
  if (!r){
    db.prepare("INSERT INTO recipes(code,name,tier,output_item_id) VALUES (?,?,?,?)").run(code,name,tier,outId);
    rid = db.prepare("SELECT id FROM recipes WHERE code=?").get(code).id;
  } else {
    db.prepare("UPDATE recipes SET name=?, tier=?, output_item_id=? WHERE id=?").run(name,tier,outId,r.id);
    rid = r.id;
    db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id=?").run(rid);
  }
  for(const c of ingCodes){
    const iid = idByCode(c); if(!iid) throw new Error("Missing ingredient "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,1)").run(rid,iid);
  }
  return rid;
}


// Items & Recipes (seed)
ensureItem("SCRAP","Scrap",1,1);
const T1 = [
  ["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]
];
for (const [c,n] of T1) ensureItem(c,n,1,0);

// T2
const T2_ITEMS = [
  ["T2_BRONZE_DOOR","Bronze Door"],["T2_SILVER_GOBLET","Silver Goblet"],["T2_GOLDEN_RING","Golden Ring"],
  ["T2_WOODEN_CHEST","Wooden Chest"],["T2_STONE_PILLAR","Stone Pillar"],["T2_LEATHER_BAG","Leather Bag"],
  ["T2_CLOTH_TENT","Cloth Tent"],["T2_CRYSTAL_ORB","Crystal Orb"],["T2_OBSIDIAN_KNIFE","Obsidian Knife"],["T2_IRON_ARMOR","Iron Armor"]
];
for (const [code,name] of T2_ITEMS) ensureItem(code,name,2,0);

// T3
const T3_ITEMS = [
  ["T3_GATE_OF_MIGHT","Gate of Might"],["T3_GOBLET_OF_WISDOM","Goblet of Wisdom"],["T3_RING_OF_GLARE","Ring of Glare"],
  ["T3_CHEST_OF_SECRETS","Chest of Secrets"],["T3_PILLAR_OF_STRENGTH","Pillar of Strength"],["T3_TRAVELERS_BAG","Traveler's Bag"],
  ["T3_NOMAD_TENT","Nomad Tent"],["T3_ORB_OF_VISION","Orb of Vision"],["T3_KNIFE_OF_SHADOW","Knife of Shadow"],["T3_ARMOR_OF_GUARD","Armor of Guard"]
];
for (const [code,name] of T3_ITEMS) ensureItem(code,name,3,0);

// T4
const T4_ITEMS = [
  ["T4_CRYSTAL_LENS","Crystal Lens"],
  ["T4_ENGINE_CORE","Engine Core"],
  ["T4_MIGHT_GATE","Might Gate"],
  ["T4_NOMAD_DWELLING","Nomad Dwelling"],
  ["T4_SECRET_CHEST","Secret Chest"],
  ["T4_SHADOW_BLADE","Shadow Blade"],
  ["T4_STRENGTH_PILLAR","Strength Pillar"],
  ["T4_TRAVELER_SATCHEL","Traveler Satchel"],
  ["T4_VISION_CORE","Vision Core"],
  ["T4_WISDOM_GOBLET","Wisdom Goblet"]
];
for (const [code,name] of T4_ITEMS) ensureItem(code,name,4,0);

// T5
const T5_ITEMS = [
  ["T5_ANCIENT_RELIC","Ancient Relic"],["T5_SUN_LENS","Sun Lens"],["T5_GUARDIAN_GATE","Guardian Gate"],["T5_NOMAD_HALL","Nomad Hall"],
  ["T5_VAULT","Royal Vault"],["T5_COLOSSAL_PILLAR","Colossal Pillar"],["T5_WAYFARER_BAG","Wayfarer Bag"],["T5_EYE_OF_TRUTH","Eye of Truth"],
  ["T5_NIGHTFALL_EDGE","Nightfall Edge"],["T5_WISDOM_CHALICE","Wisdom Chalice"]
];
for (const [code,name] of T5_ITEMS) ensureItem(code,name,5,0);

// ---------- helpers lokalni za seed recepata ----------
const takeRotated = (pool, count, offset) => {
  if (!pool.length) return [];
  const start = offset % pool.length;
  const rotated = pool.slice(start).concat(pool.slice(0, start));
  const out = [];
  for (const c of rotated) {
    if (!out.includes(c)) out.push(c);
    if (out.length >= count) break;
  }
  return out;
};
const T1_CODES = T1.map(([c])=>c);
const T2_CODES = T2_ITEMS.map(([c])=>c);
const T3_CODES = T3_ITEMS.map(([c])=>c);
const T4_CODES = T4_ITEMS.map(([c])=>c);

const P_T2 = [4,4,4, 5,5,5, 6,6, 7,7];
const P_T3 = [4,4, 5,5,5, 6,6,6, 7,7];
const P_T4 = [5,5, 6,6,6, 7,7,7, 8,8];
const P_T5 = [6,6, 7,7,7, 8,8,8, 9,9];

// seed recepata
T2_ITEMS.forEach(([outCode, outName], i) => {
  const need = P_T2[i];
  const ings = takeRotated(T1_CODES, Math.min(need, T1_CODES.length), i);
  ensureRecipe("R_"+outCode, outName, 2, outCode, ings);
});
T3_ITEMS.forEach(([outCode, outName], i) => {
  const need = P_T3[i];
  const ings = takeRotated(T2_CODES, Math.min(need, T2_CODES.length), i);
  ensureRecipe("R_"+outCode, outName, 3, outCode, ings);
});
T4_ITEMS.forEach(([outCode, outName], i) => {
  const need = P_T4[i];
  const ings = takeRotated(T3_CODES, Math.min(need, T3_CODES.length), i);
  ensureRecipe("R_"+outCode, outName, 4, outCode, ings);
});
T5_ITEMS.forEach(([outCode, outName], i) => {
  const need = P_T5[i];
  const ings = takeRotated(T4_CODES, Math.min(need, T4_CODES.length), i);
  ensureRecipe("R_"+outCode, outName, 5, outCode, ings);
});

ensureItem("ARTEFACT","Artefact",6,0);
try { db.prepare(`UPDATE recipes SET name = 'R ' || name WHERE name NOT LIKE 'R %'`).run(); } catch {}

// ---------- AUTH
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:"Bad email" });
    if (!isPass(password)) return res.status(400).json({ ok:false, error:"Password too short" });
    const exists = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email);
    if (exists) return res.status(409).json({ ok:false, error:"Email taken" });
    const hash = await bcrypt.hash(password, 10);
    db.prepare(`
      INSERT INTO users(email,pass_hash,created_at,is_admin,is_disabled,balance_silver,shop_buy_count,next_recipe_at,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(email.toLowerCase(), hash, nowISO(), 0, 0, 0, 0, null, nowISO());
    res.json({ ok:true });
  } catch {
    res.status(500).json({ ok:false, error:"Register failed" });
  }
});

app.post("/api/login", async (req,res)=>{
  try {
    const {email,password} = req.body||{};
    const u = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase());
    if (!u) return res.status(404).json({ok:false,error:"User not found"});
    if (u.is_disabled) return res.status(403).json({ok:false,error:"Account disabled"});
    const ok = await bcrypt.compare(password||"", u.pass_hash);
    if (!ok) return res.status(401).json({ok:false,error:"Wrong password"});
    const token  = signToken(u);
    const isProd = process.env.NODE_ENV === "production";
    res.cookie(TOKEN_NAME, token, {
      httpOnly: true, sameSite: "lax", secure: isProd, path: "/", maxAge: 7*24*60*60*1000
    });
    db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), u.id);
    return res.json({ok:true, user:{id:u.id,email:u.email}});
  } catch {
    return res.status(500).json({ok:false,error:"Login failed"});
  }
});

app.get("/api/logout", (req, res) => {
  const tok = readToken(req);
  if (tok) db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), tok.uid);
  res.clearCookie(TOKEN_NAME, {
    httpOnly: true, sameSite: "lax",
    secure: (process.env.NODE_ENV==="production"||process.env.RENDER==="true"),
    path: "/"
  });
  return res.json({ ok:true });
});

// ===== PAYPAL: potvrda uplate + BONUS KOD =====
app.post("/api/paypal/confirm", async (req, res) => {
  try{
    const uid = requireAuth(req);

    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET){
      return res.status(500).json({ ok:false, error:"PayPal not configured" });
    }

    const { orderId, bonus_code } = req.body || {};
    if (!orderId) return res.status(400).json({ ok:false, error:"orderId required" });

    // Idempotent check
    const already = db.prepare(`
      SELECT credited_silver FROM paypal_payments WHERE paypal_order_id=?
    `).get(String(orderId));
    if (already){
      const bal = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(uid)?.balance_silver ?? 0;
      return res.json({ ok:true, balance_silver: bal, note:"already processed" });
    }

    // PayPal verifikacija
    const token = await paypalToken();
    const order = await paypalGetOrder(token, orderId);
    if (!order || order.status !== "COMPLETED"){
      return res.status(400).json({ ok:false, error:"Payment not completed", status: order?.status || "UNKNOWN" });
    }

    // Iznos i valuta
    const pu = order.purchase_units && order.purchase_units[0];
    const currency = pu?.amount?.currency_code;
    const paid = Number(pu?.amount?.value);

    if (currency !== "USD" || !Number.isFinite(paid)){
      return res.status(400).json({ ok:false, error:"Unsupported currency or invalid amount" });
    }
    if (paid < MIN_USD){
      return res.status(400).json({ ok:false, error:`Minimum is $${MIN_USD}` });
    }

    // Base kredit
    const addGold   = Math.floor(paid * USD_TO_GOLD);
    const baseSilver = addGold * 100;

    // BONUS KOD (ako je aktivan)
    let usedCode = null, usedPercent = 0, extraSilver = 0;
    const codeStr = (bonus_code||"").trim();
    if (codeStr) {
      const row = db.prepare(`
        SELECT id, code, percent, is_active FROM bonus_codes
        WHERE is_active=1 AND lower(code)=lower(?)
      `).get(codeStr);
      if (row && row.percent > 0) {
        usedCode = row.code;
        usedPercent = Math.min(100, Math.max(0, row.percent|0));
        extraSilver = Math.floor(baseSilver * usedPercent / 100);
      }
    }

    const totalSilver = baseSilver + extraSilver;

    // Transakcija
    const after = db.transaction(() => {
      const dupe = db.prepare(`SELECT 1 FROM paypal_payments WHERE paypal_order_id=?`).get(String(orderId));
      if (dupe) {
        const cur = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(uid);
        return cur?.balance_silver ?? 0;
      }

      db.prepare(`
        INSERT INTO paypal_payments(paypal_order_id,user_id,currency,amount,credited_silver,created_at,bonus_code,bonus_percent,bonus_extra_silver)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(String(orderId), uid, String(currency), paid, totalSilver, nowISO(), usedCode, usedPercent, extraSilver);

      if (usedCode && usedPercent > 0) {
        db.prepare(`
          UPDATE bonus_codes
             SET total_credited_silver = total_credited_silver + ?
           WHERE lower(code)=lower(?)
        `).run(totalSilver, usedCode);
      }

      const cur = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(uid);
      if (!cur) throw new Error("User not found");
      const newBal = (cur.balance_silver | 0) + totalSilver;

      db.prepare(`UPDATE users SET balance_silver=? WHERE id=?`).run(newBal, uid);
      db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
        .run(uid, totalSilver, "PAYPAL_TOPUP", String(orderId), nowISO());

      return newBal;
    })();

    return res.json({
      ok:true,
      balance_silver: after,
      bonus_applied: !!usedCode,
      bonus_code: usedCode || null,
      bonus_percent: usedPercent,
      bonus_extra_silver: extraSilver
    });
  }catch(e){
    console.error("[/api/paypal/confirm] error:", e);
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// ===== BONUS helpers =====
function userHasArtefact(userId){
  const r = db.prepare(`
    SELECT 1
    FROM user_items ui
    JOIN items i ON i.id = ui.item_id
    WHERE ui.user_id=? AND i.code='ARTEFACT' AND ui.qty>0
    LIMIT 1
  `).get(userId);
  return !!r;
}
function getClaimedTiers(userId){
  const rows = db.prepare(`SELECT tier FROM set_bonuses WHERE user_id=?`).all(userId);
  const set = new Set(rows.map(r=>r.tier|0));
  return { t2:set.has(2), t3:set.has(3), t4:set.has(4), t5:set.has(5) };
}
function perksFromClaimed(claimed){
  const p = {
    shop_price_s: 100,
    craft_no_fail: false,
    auction_fee_bps: 100,
    min_list_price_s: null,
    min_recipe_tier: 2
  };
  if (claimed.t2) p.shop_price_s = Math.min(p.shop_price_s, 98);
  if (claimed.t3) p.auction_fee_bps = 0;
  if (claimed.t4) { p.shop_price_s = 90; p.craft_no_fail = true; }
  if (claimed.t5) { p.min_list_price_s = 90; p.min_recipe_tier = 3; p.craft_no_fail = true; }
  return p;
}
function getPerks(userId){
  const c = getClaimedTiers(userId);
  return perksFromClaimed(c);
}

// Extend /api/me (perks, artefact)
app.get("/api/me", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false });
  const u = db.prepare(`
    SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at
    FROM users WHERE id=?`).get(tok.uid);
  if (!u) {
    res.clearCookie(TOKEN_NAME, {
      httpOnly: true, sameSite: "lax",
      secure: (process.env.NODE_ENV==="production"||process.env.RENDER==="true"),
      path: "/"
    });
    return res.status(401).json({ ok:false });
  }
  const buysToNext = (u.next_recipe_at==null) ? null
                    : Math.max(0, (u.next_recipe_at || 0) - (u.shop_buy_count || 0));
  const hasArt = userHasArtefact(u.id);
  const claimed = getClaimedTiers(u.id);
  const perks = perksFromClaimed(claimed);
  res.json({
    ok:true,
    user:{
      id: u.id,
      email: u.email,
      is_admin: !!u.is_admin,
      balance_silver: u.balance_silver,
      gold: Math.floor(u.balance_silver/100),
      silver: (u.balance_silver % 100),
      shop_buy_count: u.shop_buy_count,
      next_recipe_at: u.next_recipe_at,
      buys_to_next: buysToNext,
      has_artefact: hasArt,
      claimed_sets: claimed,
      perks
    }
  });
});

// ===== ADMIN (ping, users, adjust, inventory, disable)
app.get("/api/admin/ping",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  res.json({ok:true});
});

app.get("/api/admin/users",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const rows = db.prepare(`
    SELECT id,email,is_admin,is_disabled,balance_silver,
           created_at,last_seen,shop_buy_count,next_recipe_at
    FROM users`).all();
  const users = rows.map(u=>({
    id: u.id,
    email: u.email,
    is_admin: !!u.is_admin,
    is_disabled: !!u.is_disabled,
    gold: Math.floor(u.balance_silver/100),
    silver: u.balance_silver % 100,
    created_at: u.created_at,
    last_seen: u.last_seen,
    shop_buy_count: u.shop_buy_count,
    next_recipe_at: u.next_recipe_at
  }));
  res.json({ok:true,users});
});

app.post("/api/admin/adjust-balance",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email,gold=0,silver=0,delta_silver} = req.body||{};
  if (!isEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u = db.prepare("SELECT id,balance_silver FROM users WHERE lower(email)=lower(?)").get(email);
  if (!u) return res.status(404).json({ok:false,error:"User not found"});
  let deltaS = (typeof delta_silver==="number") ? Math.trunc(delta_silver)
              : (Math.trunc(gold)*100 + Math.trunc(silver));
  if (!Number.isFinite(deltaS) || deltaS===0) return res.status(400).json({ok:false,error:"No change"});
  const tx = db.transaction(()=>{
    const after = u.balance_silver + deltaS;
    if (after < 0) throw new Error("Insufficient");
    db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after, u.id);
    db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
      .run(u.id, deltaS, "ADMIN_ADJUST", String(email), nowISO());
  });
  try{ tx(); }catch(e){ return res.status(400).json({ok:false,error:String(e.message||e)}); }
  const bal = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
  res.json({ok:true,balance_silver:bal});
});

app.get("/api/admin/user/:id/inventory",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const uid = parseInt(req.params.id,10);
  const items = db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ui.qty
    FROM user_items ui
    JOIN items i ON i.id=ui.item_id
    WHERE ui.user_id=? AND ui.qty>0
    ORDER BY i.tier,i.name`).all(uid);
  const recipes = db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty
    FROM user_recipes ur
    JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0
    ORDER BY r.tier,r.name`).all(uid);
  res.json({ok:true,items,recipes});
});

app.post("/api/admin/disable-user",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const { email, disabled } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email);
  if (!u) return res.status(404).json({ok:false,error:"User not found"});
  db.prepare("UPDATE users SET is_disabled=? WHERE id=?").run(disabled ? 1 : 0, u.id);
  res.json({ ok:true });
});

// ===== ADMIN: Artefact bonus gold set (samo jedna ruta)
app.post("/api/admin/set-bonus-gold", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const { code = "ARTEFACT", bonus_gold = 0 } = req.body || {};
  const g = Math.max(0, parseInt(bonus_gold, 10) || 0);
  const row = db.prepare(`SELECT id FROM items WHERE code=?`).get(String(code));
  if (!row) return res.status(404).json({ ok: false, error: "Item not found" });
  db.prepare(`UPDATE items SET bonus_gold=? WHERE code=?`).run(g, String(code));
  return res.json({ ok: true, bonus_gold: g });
});

// ===== ADMIN: Bonus kodovi (5 slotova)
app.get("/api/admin/bonus-codes", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"Unauthorized" });
  const rows = db.prepare(`
    SELECT id, code, percent, total_credited_silver, is_active
    FROM bonus_codes
    ORDER BY id ASC
  `).all();
  // frontend očekuje "codes"
  res.json({ ok:true, codes: rows });
});

app.post("/api/admin/bonus-codes", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"Unauthorized" });
  const { slot, code, percent, is_active } = req.body || {};
  const id = parseInt(slot, 10);
  if (!(id >= 1 && id <= 5)) return res.status(400).json({ ok:false, error:"slot must be 1..5" });
  const pct = Math.max(0, Math.min(100, parseInt(percent,10) || 0));
  const c = String(code || "").trim();
  if (!c) return res.status(400).json({ ok:false, error:"code required" });
  const active = is_active ? 1 : 0;

  try{
    // jedinstven kod (osim u istom slotu)
    const clash = db.prepare(`SELECT id FROM bonus_codes WHERE lower(code)=lower(?) AND id<>?`).get(c, id);
    if (clash) return res.status(409).json({ ok:false, error:"Code already used on a different slot" });

    db.prepare(`
      UPDATE bonus_codes
         SET code=?, percent=?, is_active=?
       WHERE id=?
    `).run(c, pct, active, id);

    const row = db.prepare(`
      SELECT id, code, percent, total_credited_silver, is_active
      FROM bonus_codes WHERE id=?
    `).get(id);

    // frontend očekuje total_credited_silver + slot
    res.json({ ok:true, total_credited_silver: row.total_credited_silver, slot: row });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// ===== BONUS: status i claim =====
function itemCodesByTier(tier){
  const rows = db.prepare(`SELECT code FROM items WHERE tier=? ORDER BY code`).all(tier|0);
  return rows.map(r=>r.code);
}
function itemIdByCode(code){
  const r = db.prepare(`SELECT id FROM items WHERE code=?`).get(code);
  return r ? r.id : null;
}
function userHasItemQty(userId, itemId, needQty){
  const r = db.prepare(`SELECT qty FROM user_items WHERE user_id=? AND item_id=?`).get(userId, itemId);
  return (r && (r.qty|0) >= (needQty|0));
}

app.get("/api/bonus/status", (req,res)=>{
  try{
    const uid = requireAuth(req);
    const hasArt = userHasArtefact(uid);
    const claimed = getClaimedTiers(uid);

    const tiers = {};
    for (const t of [2,3,4,5]){
      const codes = itemCodesByTier(t);
      const owned = [];
      const missing = [];
      for (const c of codes){
        const id = itemIdByCode(c);
        if (id && userHasItemQty(uid, id, 1)) owned.push(c); else missing.push(c);
      }
      tiers[t] = { owned, missing, total: codes.length, claimed: !!claimed[`t${t}`] };
    }
    res.json({ ok:true, has_artefact: hasArt, claimed, tiers, perks: perksFromClaimed(claimed) });
  }catch(e){
    res.status(401).json({ ok:false, error:String(e.message||e) });
  }
});

app.post("/api/bonus/claim",(req,res)=>{
  try{
    const uid = requireAuth(req);
    if (!userHasArtefact(uid)) return res.status(403).json({ ok:false, error:"Artefact required" });
    const tier = parseInt(req.body && req.body.tier,10);
    if (![2,3,4,5].includes(tier)) return res.status(400).json({ ok:false, error:"Bad tier" });

    const already = db.prepare(`SELECT 1 FROM set_bonuses WHERE user_id=? AND tier=?`).get(uid, tier);
    if (already) return res.status(409).json({ ok:false, error:"Already claimed" });

    const codes = itemCodesByTier(tier);
    if (codes.length !== 10) return res.status(500).json({ ok:false, error:"Tier does not have exactly 10 items" });

    const tx = db.transaction(()=>{
      for (const c of codes){
        const id = itemIdByCode(c);
        if (!id) throw new Error("Missing item "+c);
        const q = db.prepare(`SELECT qty FROM user_items WHERE user_id=? AND item_id=?`).get(uid, id);
        if (!q || (q.qty|0) <= 0) throw new Error("Missing required item: "+c);
      }
      for (const c of codes){
        const id = itemIdByCode(c);
        db.prepare(`UPDATE user_items SET qty = qty - 1 WHERE user_id=? AND item_id=?`).run(uid, id);
      }
      db.prepare(`INSERT INTO set_bonuses(user_id,tier,claimed_at) VALUES (?,?,?)`).run(uid, tier, nowISO());
    });
    tx();

    const claimed = getClaimedTiers(uid);
    res.json({ ok:true, claimed, perks: perksFromClaimed(claimed) });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});


// =============== SHOP (T1) — respektira BONUS
const SHOP_T1_COST_S_BASE = 100;
const RECIPE_DROP_MIN = 4;
const RECIPE_DROP_MAX = 8;
function nextRecipeInterval(){
  const min = RECIPE_DROP_MIN, max = RECIPE_DROP_MAX;
  return Math.floor(Math.random()*(max-min+1))+min;
}
function pickWeightedRecipe(minTier=2){
  const list = db.prepare(`SELECT id, code, name, tier FROM recipes WHERE tier BETWEEN ? AND 5`).all(minTier|0);
  if (!list.length) return null;
  const byTier = {};
  for (const r of list){ (byTier[r.tier] ||= []).push(r); }
  const roll = Math.floor(Math.random()*1000)+1;
  let tier = (roll <= 13 ? 5 : roll <= 50 ? 4 : roll <= 200 ? 3 : 2);
  if (tier < minTier) tier = minTier;
  while (tier >= minTier && !byTier[tier]) tier--;
  const arr = byTier[tier] || byTier[minTier];
  return arr[Math.floor(Math.random()*arr.length)];
}

app.post("/api/shop/buy-t1",(req,res)=>{
  const uTok = verifyTokenFromCookies(req);
  if(!uTok) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const result = db.transaction(()=>{
      const user = db.prepare("SELECT id,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(uTok.uid);
      if(!user) throw new Error("Session expired.");

      const perks = getPerks(user.id);
      const cost = perks.shop_price_s ?? SHOP_T1_COST_S_BASE;

      if(user.balance_silver < cost) throw new Error("Insufficient funds.");
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(cost,user.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(user.id,-cost,"SHOP_BUY_T1",null,nowISO());

      let nextAt = user.next_recipe_at;
      if (nextAt == null){
        nextAt = user.shop_buy_count + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(nextAt,user.id);
      }
      const newBuyCount = (user.shop_buy_count||0)+1;
      db.prepare("UPDATE users SET shop_buy_count=? WHERE id=?").run(newBuyCount,user.id);

      const willDropRecipe = newBuyCount >= nextAt;
      let gotItem = null;
      let gotRecipe = null;
      if (willDropRecipe){
        const pick = pickWeightedRecipe(perks.min_recipe_tier || 2);
        if (pick){
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
            VALUES (?,?,1,0)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty = qty + 1
          `).run(user.id, pick.id);
          gotRecipe = { code: pick.code, name: pick.name, tier: pick.tier };
        }
        const next = newBuyCount + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(next, user.id);
      } else {
        const t1 = db.prepare("SELECT id, code, name FROM items WHERE tier=1").all();
        const pick = t1[Math.floor(Math.random()*t1.length)];
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty = qty + 1
        `).run(user.id, pick.id);
        gotItem = { code: pick.code, name: pick.name, tier: 1 };
      }
      const bal = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(user.id).balance_silver;
      return { balance_silver: bal, gotItem, gotRecipe };
    })();
    res.json({ ok:true, ...result });
  }catch(e){
    res.status(400).json({ok:false,error:String(e.message||e)});
  }
});

// =============== RECIPES & CRAFTING — respektira BONUS
app.get("/api/recipes/list", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });
  try {
    const rows = db.prepare(`
      SELECT r.id, r.code, r.name, r.tier, ur.qty
      FROM user_recipes ur
      JOIN recipes r ON r.id = ur.recipe_id
      WHERE ur.user_id = ? AND ur.qty > 0
      ORDER BY r.tier ASC, r.name ASC
    `).all(tok.uid);
    res.json({ ok:true, recipes: rows });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.get("/api/recipes/ingredients/:id", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok:false, error:"Bad id" });
  try {
    const recipe = db.prepare(`SELECT id, code, name, tier, output_item_id FROM recipes WHERE id=?`).get(id);
    if (!recipe) return res.status(404).json({ ok:false, error:"Recipe not found" });
    const ingredients = db.prepare(`
      SELECT ri.item_id, ri.qty, i.code, i.name, i.tier,
             COALESCE(ui.qty,0) AS have
      FROM recipe_ingredients ri
      JOIN items i ON i.id = ri.item_id
      LEFT JOIN user_items ui ON ui.item_id = ri.item_id AND ui.user_id = ?
      WHERE ri.recipe_id = ?
      ORDER BY i.tier, i.name
    `).all(tok.uid, id);
    res.json({ ok:true, recipe, ingredients });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.post("/api/craft/do", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });
  const { recipe_id } = req.body || {};
  const rid = parseInt(recipe_id, 10);
  if (!rid) return res.status(400).json({ ok:false, error:"Missing recipe_id" });
  try{
    const result = db.transaction(() => {
      const r = db.prepare(`SELECT id, name, tier, output_item_id FROM recipes WHERE id=?`).get(rid);
      if (!r) throw new Error("Recipe not found.");
      const haveRec = db.prepare(`SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?`).get(tok.uid, r.id);
      if (!haveRec || haveRec.qty <= 0) throw new Error("You don't own this recipe.");
      const need = db.prepare(`
        SELECT ri.item_id, ri.qty, i.name
        FROM recipe_ingredients ri
        JOIN items i ON i.id = ri.item_id
        WHERE ri.recipe_id = ?`).all(r.id);

      let missing = [];
      for (const n of need) {
        const inv = db.prepare(`SELECT qty FROM user_items WHERE user_id=? AND item_id=?`).get(tok.uid, n.item_id);
        if (!inv || inv.qty < n.qty) missing.push(n.name);
      }
      if (missing.length > 0) throw { code: "MISSING_MATS", missing };

      for (const n of need) {
        db.prepare(`UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?`).run(n.qty, tok.uid, n.item_id);
      }

      const perks = getPerks(tok.uid);
      const fail = perks.craft_no_fail ? false : (Math.random() < 0.10);

      if (!fail) {
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(tok.uid, r.output_item_id);
        db.prepare(`UPDATE user_recipes SET qty=qty-1 WHERE user_id=? AND recipe_id=?`).run(tok.uid, r.id);
        const out = db.prepare(`SELECT code, name, tier FROM items WHERE id=?`).get(r.output_item_id);
        return { result:"success", crafted: out };
      } else {
        const scrap = db.prepare(`SELECT id FROM items WHERE code='SCRAP'`).get();
        if (scrap) {
          db.prepare(`
            INSERT INTO user_items(user_id,item_id,qty)
            VALUES (?,?,1)
            ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
          `).run(tok.uid, scrap.id);
        }
        return { result:"fail", scrap:true };
      }
    })();
    res.json({ ok:true, ...result });
  } catch(e){
    if (e && e.code === "MISSING_MATS") {
      return res.status(400).json({ ok:false, error:"Not all required materials are available.", missing:e.missing });
    }
    res.status(400).json({ ok:false, error:String(e.message || e) });
  }
});

// ===== ARTEFACT helpers
function addInv(userId, itemId, recipeId, qty) {
  const q = Math.max(1, parseInt(qty,10) || 1);
  if (itemId) {
    db.prepare(`
      INSERT INTO user_items(user_id,item_id,qty)
      VALUES (?,?,?)
      ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty
    `).run(userId, itemId, q);
  } else if (recipeId) {
    db.prepare(`
      INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
      VALUES (?,?,?,0)
      ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty
    `).run(userId, recipeId, q);
  } else {
    throw new Error("Nothing to add");
  }
}

// Craft ARTEFACT (10× DISTINCT T5)
app.post("/api/craft/artefact", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error: "Not logged in." });
  try {
    const result = db.transaction(() => {
      const have = db.prepare(`
        SELECT i.id, i.code, i.name, i.tier, ui.qty
        FROM items i
        JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
        WHERE i.tier=5 AND ui.qty>0
        ORDER BY i.name
      `).all(tok.uid);
      if (!have || have.length < 10) throw new Error("Need 10 distinct T5 items.");
      const picked = have.slice(0, 10);
      for (const it of picked) {
        db.prepare(`UPDATE user_items SET qty=qty-1 WHERE user_id=? AND item_id=?`).run(tok.uid, it.id);
      }
      const art = db.prepare(`SELECT id, bonus_gold FROM items WHERE code='ARTEFACT'`).get();
      if (!art) throw new Error("ARTEFACT item missing (seed).");
      addInv(tok.uid, art.id, null, 1);
      const bonus = art.bonus_gold | 0;
      return { crafted: "Artefact", bonus_gold: bonus };
    })();
    res.json({ ok:true, crafted: result.crafted, bonus_gold: result.bonus_gold });
  } catch(e) {
    res.status(400).json({ ok:false, error: String(e.message || e) });
  }
});

// =============== INVENTORY (full + artefact bonus)
app.get("/api/inventory",(req,res)=>{
  const uTok = verifyTokenFromCookies(req);
  if(!uTok) return res.status(401).json({ok:false,error:"Not logged in."});
  const items = db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,COALESCE(ui.qty,0) qty
    FROM items i
    JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ui.qty>0
    ORDER BY i.tier ASC, i.name ASC
  `).all(uTok.uid);
  const recipes = db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,COALESCE(ur.qty,0) qty
    FROM recipes r
    JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
    WHERE ur.qty>0
    ORDER BY r.tier ASC, r.name ASC
  `).all(uTok.uid);
  const art = db.prepare(`SELECT bonus_gold FROM items WHERE code='ARTEFACT'`).get();
  const artefactBonusGold = (art?.bonus_gold | 0);
  res.json({ok:true, items, recipes, artefactBonusGold});
});

// ================= SALES (Marketplace) — respektira BONUS
function mapListing(a) {
  return {
    id: a.id,
    kind: a.type,
    item_id: a.item_id,
    recipe_id: a.recipe_id,
    qty: a.qty,
    price_s: a.buy_now_price_s,
    seller_user_id: a.seller_user_id,
    status: a.status,
    start_time: a.start_time,
    end_time: a.end_time,
    name: a.name ?? null,
    tier: a.tier ?? null,
    code: a.code ?? null
  };
}

app.get("/api/sales/live", (req, res) => {
  try {
    const q = (req.query && String(req.query.q || "").trim().toLowerCase()) || "";
    const rows = db.prepare(`
      SELECT a.*,
             COALESCE(i.name, r.name)  AS name,
             COALESCE(i.tier, r.tier)  AS tier,
             COALESCE(i.code, r.code)  AS code
      FROM auctions a
      LEFT JOIN items   i ON a.type='item'   AND i.id=a.item_id
      LEFT JOIN recipes r ON a.type='recipe' AND r.id=a.recipe_id
      WHERE a.status='live'
      ORDER BY a.id DESC
      LIMIT 500
    `).all();
    let result = rows;
    if (q) result = rows.filter(a => (a.name || "").toLowerCase().includes(q));
    res.json({ ok:true, listings: result.map(mapListing) });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.get("/api/sales/mine", (req, res) => {
  try {
    const uid = requireAuth(req);
    const rows = db.prepare(`
      SELECT a.*,
             COALESCE(i.name, r.name)  AS name,
             COALESCE(i.tier, r.tier)  AS tier,
             COALESCE(i.code, r.code)  AS code
      FROM auctions a
      LEFT JOIN items   i ON a.type='item'   AND i.id=a.item_id
      LEFT JOIN recipes r ON a.type='recipe' AND r.id=a.recipe_id
      WHERE a.seller_user_id=? AND a.status='live'
      ORDER BY a.id DESC
      LIMIT 500
    `).all(uid);
    res.json({ ok:true, listings: rows.map(mapListing) });
  } catch (e) {
    res.status(401).json({ ok:false, error: String(e.message || e) });
  }
});

app.post("/api/sales/list", (req, res) => {
  try {
    const uid = requireAuth(req);
    const { kind, id, qty, gold = 0, silver = 0 } = req.body || {};
    if (!(kind === "item" || kind === "recipe")) throw new Error("Bad kind.");
    const targetId = parseInt(id, 10);
    if (!targetId) throw new Error("Bad id.");
    const qn = Math.max(1, parseInt(qty, 10) || 1);
    let price = (Math.max(0, parseInt(gold, 10) || 0) * 100) + (Math.max(0, parseInt(silver, 10) || 0) % 100);

    const perks = getPerks(uid);
    if (perks.min_list_price_s && price < perks.min_list_price_s) {
      return res.status(400).json({ ok:false, error:`Min price is ${perks.min_list_price_s}s (T5 bonus)` });
    }

    if (price <= 0) throw new Error("Price must be > 0.");
    let listingFeeS = Math.floor(price / 100);
    if (perks.auction_fee_bps === 0) listingFeeS = 0;

    const out = db.transaction(()=>{
      if (listingFeeS > 0) {
        const bal = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(uid);
        if (!bal || bal.balance_silver < listingFeeS) throw new Error("Insufficient funds for listing fee.");
        db.prepare(`UPDATE users SET balance_silver=balance_silver-? WHERE id=?`).run(listingFeeS, uid);
        db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
          .run(uid, -listingFeeS, "SALE_LIST_FEE", null, nowISO());
      }
      if (kind === "item") {
        const row = db.prepare(`SELECT COALESCE(qty,0) qty FROM user_items WHERE user_id=? AND item_id=?`).get(uid, targetId);
        if (!row || row.qty < qn) throw new Error("Not enough items.");
        db.prepare(`UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?`).run(qn, uid, targetId);
      } else {
        const row = db.prepare(`SELECT COALESCE(qty,0) qty FROM user_recipes WHERE user_id=? AND recipe_id=?`).get(uid, targetId);
        if (!row || row.qty < qn) throw new Error("Not enough recipes.");
        db.prepare(`UPDATE user_recipes SET qty=qty-? WHERE user_id=? AND recipe_id=?`).run(qn, uid, targetId);
      }
      const ins = db.prepare(`
        INSERT INTO auctions
          (seller_user_id,type,item_id,recipe_id,qty,
           start_price_s,buy_now_price_s,fee_bps,status,start_time,end_time)
        VALUES (?,?,?,?,?,
                ?,?,100,'live',?,?)
      `).run(
        uid,
        kind,
        kind === "item" ? targetId : null,
        kind === "recipe" ? targetId : null,
        qn,
        price,
        price,
        nowISO(),
        addMinutes(nowISO(), 7 * 24 * 60)
      );
      db.prepare(`
        INSERT INTO inventory_escrow(auction_id,owner_user_id,type,item_id,recipe_id,qty,created_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(
        ins.lastInsertRowid,
        uid,
        kind,
        kind === "item" ? targetId : null,
        kind === "recipe" ? targetId : null,
        qn,
        nowISO()
      );
      return { id: ins.lastInsertRowid, status: "live", price_s: price, qty: qn, listing_fee_s: listingFeeS };
    })();
    res.json({ ok:true, listing: out });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e.message || e) });
  }
});

app.post("/api/sales/cancel", (req, res) => {
  try {
    const uid = requireAuth(req);
    const id = parseInt(req.body && req.body.id, 10);
    if (!id) throw new Error("Missing id.");
    const out = db.transaction(() => {
      const a = db.prepare(`SELECT * FROM auctions WHERE id=?`).get(id);
      if (!a) throw new Error("Not found.");
      if (a.seller_user_id !== uid) throw new Error("Forbidden.");
      if (a.status !== "live") throw new Error("Not live.");
      const esc = db.prepare(`SELECT * FROM inventory_escrow WHERE auction_id=?`).get(id);
      if (!esc) throw new Error("Missing escrow.");
      addInv(uid, esc.item_id, esc.recipe_id, esc.qty);
      db.prepare(`UPDATE auctions SET status='canceled' WHERE id=?`).run(id);
      db.prepare(`DELETE FROM inventory_escrow WHERE auction_id=?`).run(id);
      return { id, status: "canceled" };
    })();
    res.json({ ok:true, listing: out });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e.message || e) });
  }
});

app.post("/api/sales/buy", (req, res) => {
  try {
    const buyerId = requireAuth(req);
    const id = parseInt(req.body && req.body.id, 10);
    if (!id) throw new Error("Missing id.");
    const out = db.transaction(() => {
      const a = db.prepare(`SELECT * FROM auctions WHERE id=?`).get(id);
      if (!a) throw new Error("Not found.");
      if (a.status !== "live") throw new Error("Not live.");
      if (!a.buy_now_price_s) throw new Error("Not a buy-now listing.");
      if (a.seller_user_id === buyerId) throw new Error("You can't buy your own listing.");
      const price = a.buy_now_price_s;
      const buyer = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(buyerId);
      if (!buyer || buyer.balance_silver < price) throw new Error("Insufficient funds.");
      const esc = db.prepare(`SELECT * FROM inventory_escrow WHERE auction_id=?`).get(id);
      if (!esc) throw new Error("Missing escrow.");
      const fee = Math.floor((a.fee_bps || 100) * price / 10000);
      const net = price - fee;
      db.prepare(`UPDATE users SET balance_silver=balance_silver-? WHERE id=?`).run(price, buyerId);
      db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
        .run(buyerId, -price, "SALE_BUY", String(id), nowISO());
      db.prepare(`UPDATE users SET balance_silver=balance_silver+? WHERE id=?`).run(net, a.seller_user_id);
      db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
        .run(a.seller_user_id, net, "SALE_EARN", String(id), nowISO());
      addInv(buyerId, esc.item_id, esc.recipe_id, esc.qty);
      db.prepare(`
        UPDATE auctions
        SET status='paid', winner_user_id=?, sold_price_s=?, end_time=?, highest_bid_s=?, highest_bidder_user_id=?
        WHERE id=?
      `).run(buyerId, price, nowISO(), price, buyerId, id);
      db.prepare(`DELETE FROM inventory_escrow WHERE auction_id=?`).run(id);
      return { id, paid_s: price };
    })();
    res.json({ ok:true, result: out });
  } catch (e) {
    res.status(400).json({ ok:false, error: String(e.message || e) });
  }
});

app.get("/api/sales/ping", (_req,res)=>res.json({ok:true}));

// ===== HEALTH
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: nowISO() });
});

// =============== START
server.listen(PORT, HOST, () => {
  console.log(`ARTEFACT server listening on http://${HOST}:${PORT}`);
});










