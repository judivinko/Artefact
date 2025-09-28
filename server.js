// ARTEFACT • Full Server (Express + better-sqlite3) + BONUS sekcija + BONUS CODES 
// =================================================================================
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ----------------- CONFIG -----------------
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";
const TOKEN_NAME = "token";
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || "judi.vinko81@gmail.com").toLowerCase();

const DB_FILE = process.env.DB_PATH || path.join(__dirname, "data", "artefact.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// ----------------- PAYPAL -----------------
const USD_TO_GOLD = 100; // 1 USD = 100 gold
const MIN_USD = 10; // minimalna uplata
const PAYPAL_MODE = (process.env.PAYPAL_MODE || "sandbox").toLowerCase(); // "live" | "sandbox"
const PAYPAL_BASE = PAYPAL_MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_SECRET = process.env.PAYPAL_SECRET || "";

// ----------------- STARTUP: cleanup '0*' images -----------------
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
            try { fs.unlinkSync(full); deleted++; } catch (e) { console.error("[CLEANUP] del err:", full, e); }
          }
        }
      }
    }
    return { checked, deleted, found };
  } catch (e) {
    console.error("[CLEANUP] scan err:", e);
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
  if (r.found.length) console.log("[CLEANUP] Obrisano:", r.found.map(p => p.replace(__dirname, "")).join(" | "));
  else console.log('[CLEANUP] Nije našao fajlove koji počinju sa "0" u /public(/images)');
})();

// ----------------- APP -----------------
const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

// Static + pages
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ----------------- DB -----------------
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

// -------- Helpers --------
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
  const tok = readToken(req);
  if (!tok) return false;
  const r = db.prepare("SELECT is_admin FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin===1);
}
function addMinutes(iso, mins){
  const d = new Date(iso);
  d.setMinutes(d.getMinutes()+mins);
  return d.toISOString();
}

// ★ CHANGED: helper za određivanje je li zahtjev stvarno preko HTTPS-a (iza proxyja)
function isReqSecure(req){
  return !!(req.secure || String(req.headers['x-forwarded-proto']||'').toLowerCase()==='https');
}

// -------- PayPal helpers --------
const fetch = global.fetch || ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));
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

/// ----------------- PAYPAL config + create-order -----------------
app.get("/api/paypal/config", (_req, res) => {
  try {
    const configured = !!PAYPAL_CLIENT_ID;
    return res.status(200).json({
      ok: configured,
      configured,
      client_id: configured ? PAYPAL_CLIENT_ID : null,
      mode: PAYPAL_MODE,
      currency: "USD",
      min_usd: MIN_USD
    });
  } catch (e) {
    return res.status(200).json({ ok:false, configured:false, error:String(e.message||e) });
  }
});


// (Opcionalno, ali korisno) – server-side kreiranje PayPal narudžbe
// body: { amount_usd: number }
// ★ CHANGED: jasni statusi (401 za no-auth, 400 za no-config)
app.post("/api/paypal/create-order", async (req, res) => {
  try{
    let uid;
    try { uid = requireAuth(req); } 
    catch { return res.status(401).json({ ok:false, error:"Not logged in" }); }

    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET){
      return res.status(400).json({ ok:false, error:"PayPal not configured" });
    }
    const amount = Number(req.body?.amount_usd);
    if (!Number.isFinite(amount) || amount < MIN_USD) {
      return res.status(400).json({ ok:false, error:`Minimum is $${MIN_USD}` });
    }

    const access = await paypalToken();
    const resp = await fetch(PAYPAL_BASE + "/v2/checkout/orders", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + access,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          { amount: { currency_code: "USD", value: amount.toFixed(2) } }
        ],
        application_context: {
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
        }
      })
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(400).json({ ok:false, error:"Create order failed", details:data });
    }
    return res.json({ ok:true, id: data.id });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// ----------------- MIGRATIONS -----------------
function ensure(sql){ db.exec(sql); }
function tableExists(name) {
  try { return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name); }
  catch { return false; }
}
function hasColumn(table, col) {
  try {
    const tbl = String(table).replace(/[^A-Za-z0-9_]/g, "");
    const rows = db.prepare(`PRAGMA table_info(${tbl})`).all();
    return rows.some(c => c.name === col);
  } catch { return false; }
}

/* ---------- CORE TABLES (no duplicates) ---------- */
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
  );
`);
ensure(`
  CREATE TABLE IF NOT EXISTS gold_ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta_s INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);
ensure(`
  CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tier INTEGER NOT NULL,
    volatile INTEGER NOT NULL DEFAULT 0,
    bonus_gold INTEGER NOT NULL DEFAULT 0
  );
`);
ensure(`
  CREATE TABLE IF NOT EXISTS user_items(
    user_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id,item_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(item_id) REFERENCES items(id)
  );
`);
ensure(`
  CREATE TABLE IF NOT EXISTS recipes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tier INTEGER NOT NULL,
    output_item_id INTEGER NOT NULL,
    FOREIGN KEY(output_item_id) REFERENCES items(id)
  );
`);
ensure(`
  CREATE TABLE IF NOT EXISTS recipe_ingredients(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipe_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    FOREIGN KEY(recipe_id) REFERENCES recipes(id),
    FOREIGN KEY(item_id) REFERENCES items(id)
  );
`);
ensure(`
  CREATE TABLE IF NOT EXISTS user_recipes(
    user_id INTEGER NOT NULL,
    recipe_id INTEGER NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id,recipe_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(recipe_id) REFERENCES recipes(id)
  );
`);
/* auctions / sales / inventory_escrow će se rješavati u transakciji ispod (create or migrate) */

/* ---- set_bonuses (trajni set bonusi) ---- */
ensure(`
  CREATE TABLE IF NOT EXISTS set_bonuses(
    user_id INTEGER NOT NULL,
    tier INTEGER NOT NULL CHECK(tier IN (2,3,4,5)),
    claimed_at TEXT NOT NULL,
    PRIMARY KEY(user_id, tier),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

/* ---- PayPal uplate (idempot) + bonus_code reference ---- */
ensure(`
  CREATE TABLE IF NOT EXISTS paypal_payments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paypal_order_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    currency TEXT NOT NULL,
    amount REAL NOT NULL,
    credited_silver INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    bonus_code TEXT
  );
`);
if (!hasColumn("paypal_payments", "bonus_code")) {
  try { db.exec(`ALTER TABLE paypal_payments ADD COLUMN bonus_code TEXT;`); } catch {}
}

/* ---- BONUS-CODES: do 5 slotova ---- */
ensure(`
  CREATE TABLE IF NOT EXISTS bonus_codes(
    slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 5),
    code TEXT UNIQUE,
    percent INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    total_credited_silver INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
  );
`);

/* ---------- LEGACY / CREATE-OR-MIGRATE (bez duplikata) ---------- */
db.transaction(() => {
  /* SALES */
  if (!tableExists("sales")) {
    db.exec(`
      CREATE TABLE sales(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        item_id INTEGER,
        recipe_id INTEGER,
        qty INTEGER NOT NULL DEFAULT 1,
        price_s INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'live',
        created_at TEXT NOT NULL,
        sold_at TEXT,
        buyer_user_id INTEGER,
        sold_price_s INTEGER,
        sold_qty INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sales_live ON sales(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sales_seller ON sales(seller_user_id, status);
    `);
  } else {
    if (!hasColumn("sales", "price_s"))        db.exec(`ALTER TABLE sales ADD COLUMN price_s INTEGER NOT NULL DEFAULT 0;`);
    if (!hasColumn("sales", "title"))          db.exec(`ALTER TABLE sales ADD COLUMN title TEXT NOT NULL DEFAULT '';`);
    if (!hasColumn("sales", "status"))         db.exec(`ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'live';`);
    if (!hasColumn("sales", "buyer_user_id"))  db.exec(`ALTER TABLE sales ADD COLUMN buyer_user_id INTEGER;`);
    if (!hasColumn("sales", "sold_at"))        db.exec(`ALTER TABLE sales ADD COLUMN sold_at TEXT;`);
    if (!hasColumn("sales", "sold_price_s"))   db.exec(`ALTER TABLE sales ADD COLUMN sold_price_s INTEGER;`);
    if (!hasColumn("sales", "sold_qty"))       db.exec(`ALTER TABLE sales ADD COLUMN sold_qty INTEGER DEFAULT 0;`);
  }

  /* AUCTIONS */
  if (!tableExists("auctions")) {
    db.exec(`
      CREATE TABLE auctions(
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
      );
      CREATE INDEX IF NOT EXISTS idx_auctions_live ON auctions(status, start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_auctions_seller ON auctions(seller_user_id, status);
    `);
  } else {
    if (!hasColumn("auctions", "winner_user_id"))        db.exec(`ALTER TABLE auctions ADD COLUMN winner_user_id INTEGER;`);
    if (!hasColumn("auctions", "sold_price_s"))          db.exec(`ALTER TABLE auctions ADD COLUMN sold_price_s INTEGER;`);
    if (!hasColumn("auctions", "highest_bid_s"))         db.exec(`ALTER TABLE auctions ADD COLUMN highest_bid_s INTEGER;`);
    if (!hasColumn("auctions", "highest_bidder_user_id"))db.exec(`ALTER TABLE auctions ADD COLUMN highest_bidder_user_id INTEGER;`);
  }

  /* INVENTORY_ESCROW */
  if (!tableExists("inventory_escrow")) {
    db.exec(`
      CREATE TABLE inventory_escrow(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        auction_id INTEGER,
        owner_user_id INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'item',
        item_id INTEGER,
        recipe_id INTEGER,
        qty INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_inventory_escrow_auction ON inventory_escrow(auction_id);
    `);
  } else {
    if (!hasColumn("inventory_escrow", "type"))      db.exec(`ALTER TABLE inventory_escrow ADD COLUMN type TEXT NOT NULL DEFAULT 'item';`);
    if (!hasColumn("inventory_escrow", "auction_id"))db.exec(`ALTER TABLE inventory_escrow ADD COLUMN auction_id INTEGER;`);
  }
})();

/* ----------------- SEED (Items & Recipes, identično kao prije) ----------------- */
function ensureItem(code, name, tier, volatile = 0) {
  const row = db.prepare("SELECT id FROM items WHERE code=?").get(code);
  if (row) {
    db.prepare("UPDATE items SET name=?, tier=?, volatile=? WHERE id=?").run(name, tier, volatile, row.id);
    return row.id;
  }
  db.prepare("INSERT INTO items(code,name,tier,volatile) VALUES (?,?,?,?)").run(code, name, tier, volatile);
  return db.prepare("SELECT id FROM items WHERE code=?").get(code).id;
}
function idByCode(code){
  const r = db.prepare("SELECT id FROM items WHERE code=?").get(code);
  return r && r.id;
}
function ensureRecipe(code, name, tier, outCode, ingCodes) {
  const outId = idByCode(outCode);
  if(!outId) throw new Error("Missing item "+outCode);
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
    const iid = idByCode(c);
    if(!iid) throw new Error("Missing ingredient "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,1)").run(rid,iid);
  }
  return rid;
}

// T1
ensureItem("SCRAP","Scrap",1,1);
const T1 = [["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]];
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
  ["T4_CRYSTAL_LENS","Crystal Lens"],["T4_ENGINE_CORE","Engine Core"],["T4_MIGHT_GATE","Might Gate"],
  ["T4_NOMAD_DWELLING","Nomad Dwelling"],["T4_SECRET_CHEST","Secret Chest"],["T4_SHADOW_BLADE","Shadow Blade"],
  ["T4_STRENGTH_PILLAR","Strength Pillar"],["T4_TRAVELER_SATCHEL","Traveler Satchel"],["T4_VISION_CORE","Vision Core"],
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

// ---- NOVI seed recepata (realistic) ----
const NAME_BY_CODE = Object.fromEntries([
  ["SCRAP","Scrap"], ...T1, ...T2_ITEMS, ...T3_ITEMS, ...T4_ITEMS, ...T5_ITEMS,
]);
const nameFor = c => NAME_BY_CODE[c] || c;

const RECIPES_T2 = {
  T2_BRONZE_DOOR:["BRONZE","BRONZE","BRONZE","IRON"],
  T2_SILVER_GOBLET:["SILVER","SILVER","SILVER","GOLD"],
  T2_GOLDEN_RING:["GOLD","GOLD","GOLD","CRYSTAL"],
  T2_WOODEN_CHEST:["WOOD","WOOD","WOOD","IRON","LEATHER"],
  T2_STONE_PILLAR:["STONE","STONE","STONE","IRON","CRYSTAL"],
  T2_LEATHER_BAG:["LEATHER","LEATHER","LEATHER","CLOTH","IRON"],
  T2_CLOTH_TENT:["CLOTH","CLOTH","CLOTH","WOOD","LEATHER","IRON"],
  T2_CRYSTAL_ORB:["CRYSTAL","CRYSTAL","CRYSTAL","SILVER","GOLD","STONE"],
  T2_OBSIDIAN_KNIFE:["OBSIDIAN","OBSIDIAN","OBSIDIAN","OBSIDIAN","WOOD","LEATHER","STONE"],
  T2_IRON_ARMOR:["IRON","IRON","IRON","IRON","LEATHER","CLOTH","BRONZE"],
};

const RECIPES_T3 = {
  T3_GATE_OF_MIGHT:["T2_BRONZE_DOOR","T2_BRONZE_DOOR","T2_BRONZE_DOOR","T2_BRONZE_DOOR"],
  T3_GOBLET_OF_WISDOM:["T2_SILVER_GOBLET","T2_SILVER_GOBLET","T2_SILVER_GOBLET","T2_CRYSTAL_ORB"],
  T3_RING_OF_GLARE:["T2_GOLDEN_RING","T2_GOLDEN_RING","T2_GOLDEN_RING","T2_CRYSTAL_ORB","T2_SILVER_GOBLET"],
  T3_CHEST_OF_SECRETS:["T2_WOODEN_CHEST","T2_WOODEN_CHEST","T2_WOODEN_CHEST","T2_SILVER_GOBLET","T2_OBSIDIAN_KNIFE"],
  T3_PILLAR_OF_STRENGTH:["T2_STONE_PILLAR","T2_STONE_PILLAR","T2_STONE_PILLAR","T2_STONE_PILLAR","T2_WOODEN_CHEST"],
  T3_TRAVELERS_BAG:["T2_LEATHER_BAG","T2_LEATHER_BAG","T2_LEATHER_BAG","T2_OBSIDIAN_KNIFE","T2_SILVER_GOBLET","T2_GOLDEN_RING"],
  T3_NOMAD_TENT:["T2_CLOTH_TENT","T2_CLOTH_TENT","T2_CLOTH_TENT","T2_CRYSTAL_ORB","T2_WOODEN_CHEST","T2_OBSIDIAN_KNIFE"],
  T3_ORB_OF_VISION:["T2_CRYSTAL_ORB","T2_CRYSTAL_ORB","T2_CRYSTAL_ORB","T2_CRYSTAL_ORB","T2_SILVER_GOBLET","T2_GOLDEN_RING",],
  T3_KNIFE_OF_SHADOW:["T2_OBSIDIAN_KNIFE","T2_OBSIDIAN_KNIFE","T2_OBSIDIAN_KNIFE","T2_OBSIDIAN_KNIFE","T2_LEATHER_BAG","T2_GOLDEN_RING","T2_WOODEN_CHEST"],
  T3_ARMOR_OF_GUARD:["T2_IRON_ARMOR","T2_IRON_ARMOR","T2_IRON_ARMOR","T2_IRON_ARMOR","T2_WOODEN_CHEST","T2_GOLDEN_RING","T2_LEATHER_BAG"],
};

const RECIPES_T4 = {
  T4_CRYSTAL_LENS:["T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_GOBLET_OF_WISDOM","T3_RING_OF_GLARE"],
  T4_ENGINE_CORE:["T3_ARMOR_OF_GUARD","T3_ARMOR_OF_GUARD","T3_ARMOR_OF_GUARD","T3_CHEST_OF_SECRETS","T3_KNIFE_OF_SHADOW"],
  T4_MIGHT_GATE:["T3_GATE_OF_MIGHT","T3_GATE_OF_MIGHT","T3_GATE_OF_MIGHT","T3_GATE_OF_MIGHT","T3_GATE_OF_MIGHT","T3_CHEST_OF_SECRETS"],
  T4_NOMAD_DWELLING:["T3_NOMAD_TENT","T3_NOMAD_TENT","T3_NOMAD_TENT","T3_TRAVELERS_BAG","T3_CHEST_OF_SECRETS","T3_KNIFE_OF_SHADOW"],
  T4_SECRET_CHEST:["T3_CHEST_OF_SECRETS","T3_CHEST_OF_SECRETS","T3_CHEST_OF_SECRETS","T3_ORB_OF_VISION","T3_NOMAD_TENT","T3_KNIFE_OF_SHADOW"],
  T4_SHADOW_BLADE:["T3_KNIFE_OF_SHADOW","T3_KNIFE_OF_SHADOW","T3_KNIFE_OF_SHADOW","T3_KNIFE_OF_SHADOW","T3_CHEST_OF_SECRETS","T3_RING_OF_GLARE","T3_TRAVELERS_BAG"],
  T4_STRENGTH_PILLAR:["T3_PILLAR_OF_STRENGTH","T3_PILLAR_OF_STRENGTH","T3_PILLAR_OF_STRENGTH","T3_PILLAR_OF_STRENGTH","T3_GATE_OF_MIGHT","T3_ARMOR_OF_GUARD","T3_ORB_OF_VISION"],
  T4_TRAVELER_SATCHEL:["T3_TRAVELERS_BAG","T3_TRAVELERS_BAG","T3_TRAVELERS_BAG","T3_TRAVELERS_BAG","T3_NOMAD_TENT","T3_KNIFE_OF_SHADOW","T3_RING_OF_GLARE"],
  T4_VISION_CORE:["T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_GOBLET_OF_WISDOM","T3_RING_OF_GLARE","T3_CHEST_OF_SECRETS","T3_KNIFE_OF_SHADOW"],
  T4_WISDOM_GOBLET:["T3_GOBLET_OF_WISDOM","T3_GOBLET_OF_WISDOM","T3_GOBLET_OF_WISDOM","T3_GOBLET_OF_WISDOM","T3_ORB_OF_VISION","T3_RING_OF_GLARE","T3_CHEST_OF_SECRETS","T3_KNIFE_OF_SHADOW"],
};

const RECIPES_T5 = {
  T5_ANCIENT_RELIC:["T4_SECRET_CHEST","T4_SECRET_CHEST","T4_SECRET_CHEST","T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING","T4_SHADOW_BLADE"],
  T5_SUN_LENS:["T4_CRYSTAL_LENS","T4_CRYSTAL_LENS","T4_CRYSTAL_LENS","T4_VISION_CORE","T4_WISDOM_GOBLET","T4_MIGHT_GATE"],
  T5_GUARDIAN_GATE:["T4_MIGHT_GATE","T4_MIGHT_GATE","T4_MIGHT_GATE","T4_MIGHT_GATE","T4_ENGINE_CORE","T4_STRENGTH_PILLAR","T4_SECRET_CHEST"],
  T5_NOMAD_HALL:["T4_NOMAD_DWELLING","T4_NOMAD_DWELLING","T4_NOMAD_DWELLING","T4_NOMAD_DWELLING","T4_TRAVELER_SATCHEL","T4_SECRET_CHEST","T4_STRENGTH_PILLAR"],
  T5_VAULT:["T4_ENGINE_CORE","T4_ENGINE_CORE","T4_ENGINE_CORE","T4_ENGINE_CORE","T4_MIGHT_GATE","T4_STRENGTH_PILLAR","T4_CRYSTAL_LENS"],
  T5_COLOSSAL_PILLAR:["T4_STRENGTH_PILLAR","T4_STRENGTH_PILLAR","T4_STRENGTH_PILLAR","T4_STRENGTH_PILLAR","T4_ENGINE_CORE","T4_SECRET_CHEST","T4_SHADOW_BLADE","T4_VISION_CORE"],
  T5_WAYFARER_BAG:["T4_TRAVELER_SATCHEL","T4_TRAVELER_SATCHEL","T4_TRAVELER_SATCHEL","T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING","T4_VISION_CORE","T4_CRYSTAL_LENS","T4_WISDOM_GOBLET"],
  T5_EYE_OF_TRUTH:["T4_VISION_CORE","T4_VISION_CORE","T4_VISION_CORE","T4_VISION_CORE","T4_CRYSTAL_LENS","T4_WISDOM_GOBLET","T4_SHADOW_BLADE","T4_SECRET_CHEST"],
  T5_NIGHTFALL_EDGE:["T4_SHADOW_BLADE","T4_SHADOW_BLADE","T4_SHADOW_BLADE","T4_SHADOW_BLADE","T4_VISION_CORE","T4_CRYSTAL_LENS","T4_SECRET_CHEST","T4_NOMAD_DWELLING","T4_TRAVELER_SATCHEL"],
  T5_WISDOM_CHALICE:["T4_WISDOM_GOBLET","T4_WISDOM_GOBLET","T4_WISDOM_GOBLET","T4_WISDOM_GOBLET","T4_VISION_CORE","T4_SECRET_CHEST","T4_TRAVELER_SATCHEL","T4_ENGINE_CORE","T4_NOMAD_DWELLING"],
};

function seedRecipeMap(tier, map){
  for (const [outCode, ingCodes] of Object.entries(map))
    ensureRecipe("R_"+outCode, nameFor(outCode), tier, outCode, ingCodes);
}
seedRecipeMap(2, RECIPES_T2);
seedRecipeMap(3, RECIPES_T3);
seedRecipeMap(4, RECIPES_T4);
seedRecipeMap(5, RECIPES_T5);

// ARTEFACT (nema recept)
ensureItem("ARTEFACT","Artefact",6,0);
// prefiks "R "
try { db.prepare(`UPDATE recipes SET name = 'R ' || name WHERE name NOT LIKE 'R %'`).run(); } catch {}




// ----------------- AUTH -----------------
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:"Bad email" });
    if (!isPass(password)) return res.status(400).json({ ok:false, error:"Password too short" });

    // provjera postoje li već korisnik (case-insensitive)
    const exists = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(String(email||"").toLowerCase());
    if (exists) return res.status(409).json({ ok:false, error:"Email taken" });

    // ★ CHANGED: stabilno hashanje s bcryptjs (sync)
    const hash = bcrypt.hashSync(password, 10);

    db.prepare(`
      INSERT INTO users(email,pass_hash,created_at,is_admin,is_disabled,balance_silver,shop_buy_count,next_recipe_at,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(String(email).toLowerCase(), hash, nowISO(), 0, 0, 0, 0, null, nowISO());

    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"Register failed" });
  }
});

// ★ CHANGED: login sync compare + secure određuje se po stvarnom requestu
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:"Bad email" });

    const u = db.prepare("SELECT * FROM users WHERE lower(email)=lower(?)").get(String(email||"").toLowerCase());
    if (!u) return res.status(404).json({ ok:false, error:"User not found" });
    if (u.is_disabled) return res.status(403).json({ ok:false, error:"Account disabled" });

    const ok = bcrypt.compareSync(password || "", u.pass_hash);
    if (!ok) return res.status(401).json({ ok:false, error:"Wrong password" });

    const token = signToken(u);

    res.cookie(TOKEN_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isReqSecure(req),
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), u.id);

    return res.json({ ok:true, user:{ id: u.id, email: u.email } });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"Login failed" });
  }
});

app.get("/api/logout", (req, res) => {
  const tok = readToken(req);
  if (tok) {
    try { db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), tok.uid); } catch {}
  }

  // ★ CHANGED: čišćenje kolačića dosljedno s loginom
  res.clearCookie(TOKEN_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: isReqSecure(req),
    path: "/"
  });

  return res.json({ ok:true });
});


// ----------------- BONUS CODES (ADMIN) -----------------
function sanitizeCode(raw){
  const s = String(raw||"").trim().toUpperCase();
  return s.replace(/[^A-Z0-9_.-]/g,"").slice(0,32);
}

// GET: list slots (1..5)
app.get("/api/admin/bonus-codes", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"Unauthorized" });
  const rows = db.prepare("SELECT slot, code, percent, is_active, total_credited_silver FROM bonus_codes ORDER BY slot ASC").all();
  const bySlot = {};
  rows.forEach(r => bySlot[r.slot] = r);
  const slots = [];
  for (let i=1;i<=5;i++){
    slots.push(bySlot[i] || { slot:i, code:"", percent:0, is_active:1, total_credited_silver:0 });
  }
  res.json({ ok:true, slots });
});

// POST: save one row {slot, code, percent, is_active}
app.post("/api/admin/bonus-codes", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"Unauthorized" });
  try{
    let { slot, code, percent, is_active } = req.body || {};
    slot = parseInt(slot,10);
    if (!(slot>=1 && slot<=5)) return res.status(400).json({ ok:false, error:"Bad slot" });
    code = sanitizeCode(code || "");
    percent = Math.max(0, Math.min(100, parseInt(percent,10)||0));
    is_active = !!is_active ? 1 : 0;

    const tx = db.transaction(() => {
      // Ako isti code postoji u drugom slotu, očisti ga da bi UNIQUE prošao
      if (code) {
        const dup = db.prepare("SELECT slot FROM bonus_codes WHERE code=? AND slot<>?").get(code, slot);
        if (dup) db.prepare("UPDATE bonus_codes SET code=NULL WHERE slot=?").run(dup.slot);
      }
      // Upsert
      const cur = db.prepare("SELECT slot FROM bonus_codes WHERE slot=?").get(slot);
      if (!cur) {
        db.prepare(`
          INSERT INTO bonus_codes(slot, code, percent, is_active, total_credited_silver, updated_at)
          VALUES (?,?,?,?,0,?)
        `).run(slot, code || null, percent, is_active, nowISO());
      } else {
        db.prepare(`
          UPDATE bonus_codes
             SET code=?, percent=?, is_active=?, updated_at=?
           WHERE slot=?
        `).run(code || null, percent, is_active, nowISO(), slot);
      }
      const out = db.prepare("SELECT slot, code, percent, is_active, total_credited_silver FROM bonus_codes WHERE slot=?").get(slot);
      return out || { slot, code, percent, is_active, total_credited_silver:0 };
    });
    const out = tx();
    res.json({ ok:true, ...out });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// ----------------- PAYPAL confirm (+ bonus_code podrška) -----------------
// ★ CHANGED: jasni statusi (401/400) umjesto generičnih 500
app.post("/api/paypal/confirm", async (req, res) => {
  try{
    let uid;
    try { uid = requireAuth(req); }
    catch { return res.status(401).json({ ok:false, error:"Not logged in" }); }

    if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET){
      return res.status(400).json({ ok:false, error:"PayPal not configured" });
    }
    const { orderId, bonus_code: rawCode } = req.body || {};
    if (!orderId) return res.status(400).json({ ok:false, error:"orderId required" });

    // već obrađeno?
    const already = db.prepare("SELECT credited_silver FROM paypal_payments WHERE paypal_order_id=?").get(String(orderId));
    if (already){
      const bal = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(uid)?.balance_silver ?? 0;
      return res.json({ ok:true, balance_silver: bal, note:"already processed" });
    }

    const token = await paypalToken();
    const order = await paypalGetOrder(token, orderId);
    if (!order || order.status !== "COMPLETED"){
      return res.status(400).json({ ok:false, error:"Payment not completed", status: order?.status || "UNKNOWN" });
    }

    const pu = order.purchase_units && order.purchase_units[0];
    const currency = pu?.amount?.currency_code;
    const paid = Number(pu?.amount?.value);
    if (currency !== "USD" || !Number.isFinite(paid)) return res.status(400).json({ ok:false, error:"Unsupported currency or invalid amount" });
    if (paid < MIN_USD) return res.status(400).json({ ok:false, error: `Minimum is $${MIN_USD}` });

    // base credit
    const addGold = Math.floor(paid * USD_TO_GOLD);
    const baseSilver = addGold * 100;

    // bonus code lookup (case-insensitive)
    const code = sanitizeCode(rawCode || "");
    const slotRow = code
      ? db.prepare("SELECT slot, percent, is_active FROM bonus_codes WHERE upper(code)=?").get(code)
      : null;
    const pct = (slotRow && slotRow.is_active) ? Math.max(0, Math.min(100, (slotRow.percent|0))) : 0;
    const bonusSilver = Math.floor(baseSilver * pct / 100);
    const totalSilverToAdd = baseSilver + bonusSilver;

    // transakcija + idempotencija
    const after = db.transaction(() => {
      const dupe = db.prepare("SELECT 1 FROM paypal_payments WHERE paypal_order_id=?").get(String(orderId));
      if (dupe) {
        const cur = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(uid);
        return cur?.balance_silver ?? 0;
      }
      db.prepare(`
        INSERT INTO paypal_payments(paypal_order_id,user_id,currency,amount,credited_silver,created_at,bonus_code)
        VALUES (?,?,?,?,?,?,?)
      `).run(String(orderId), uid, String(currency), paid, totalSilverToAdd, nowISO(), code || null);

      const cur = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(uid);
      if (!cur) throw new Error("User not found");
      const newBal = (cur.balance_silver | 0) + totalSilverToAdd;
      db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(newBal, uid);

      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(uid, baseSilver, "PAYPAL_TOPUP", String(orderId), nowISO());

      if (bonusSilver > 0) {
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
          .run(uid, bonusSilver, "PAYPAL_BONUS_CODE", code || "", nowISO());
      }

      // zbroji u slotu
      if (slotRow && slotRow.is_active) {
        db.prepare(`
          INSERT INTO bonus_codes(slot, code, percent, is_active, total_credited_silver, updated_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(slot) DO UPDATE SET
            total_credited_silver = total_credited_silver + excluded.total_credited_silver,
            updated_at = excluded.updated_at
        `).run(slotRow.slot, code || null, pct, 1, totalSilverToAdd, nowISO());
      }

      return newBal;
    })();

    return res.json({ ok:true, balance_silver: after });
  }catch(e){
    console.error("[/api/paypal/confirm] error:", e);
    return res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// ----------------- BONUS perks helpers -----------------
function userHasArtefact(userId){
  const r = db.prepare(
    "SELECT 1 FROM user_items ui JOIN items i ON i.id = ui.item_id WHERE ui.user_id=? AND i.code='ARTEFACT' AND ui.qty>0 LIMIT 1"
  ).get(userId);
  return !!r;
}
function getClaimedTiers(userId){
  const rows = db.prepare("SELECT tier FROM set_bonuses WHERE user_id=?").all(userId);
  const set = new Set(rows.map(r=>r.tier|0));
  return { t2:set.has(2), t3:set.has(3), t4:set.has(4), t5:set.has(5) };
}
function perksFromClaimed(claimed){
  const p = { shop_price_s: 100, craft_no_fail: false, auction_fee_bps: 100, min_list_price_s: null, min_recipe_tier: 2 };
  if (claimed.t2) p.shop_price_s = Math.min(p.shop_price_s, 98);
  if (claimed.t3) p.auction_fee_bps = 0;
  if (claimed.t4) { p.shop_price_s = 90; p.craft_no_fail = true; }
  if (claimed.t5) { p.min_list_price_s = 90; p.min_recipe_tier = 3; p.craft_no_fail = true; }
  return p;
}
function getPerks(userId){ return perksFromClaimed(getClaimedTiers(userId)); }

// ----------------- /api/me -----------------
app.get("/api/me", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false });
  const u = db.prepare(
    "SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?"
  ).get(tok.uid);
  if (!u) {
    // ★ CHANGED: dosljedan clearCookie
    res.clearCookie(TOKEN_NAME, { httpOnly: true, sameSite: "lax", secure: isReqSecure(req), path: "/" });
    return res.status(401).json({ ok:false });
  }
  const buysToNext = (u.next_recipe_at==null) ? null : Math.max(0, (u.next_recipe_at || 0) - (u.shop_buy_count || 0));
  const hasArt = userHasArtefact(u.id);
  const claimed = getClaimedTiers(u.id);
  const perks = perksFromClaimed(claimed);
  res.json({ ok:true, user:{
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
  }});
});

// ----------------- ADMIN core -----------------
app.post("/api/admin/set-bonus-gold", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const { code = "ARTEFACT", bonus_gold = 0 } = req.body || {};
  const g = Math.max(0, parseInt(bonus_gold, 10) || 0);
  const row = db.prepare("SELECT id FROM items WHERE code=?").get(String(code));
  if (!row) return res.status(404).json({ ok: false, error: "Item not found" });
  db.prepare("UPDATE items SET bonus_gold=? WHERE code=?").run(g, String(code));
  return res.json({ ok: true, bonus_gold: g });
});

app.get("/api/admin/cleanup-images/dryrun", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"Unauthorized" });
  function scan(rootDir) {
    const hit = [];
    try {
      if (!fs.existsSync(rootDir)) return hit;
      const stack = [rootDir];
      while (stack.length) {
        const dir = stack.pop();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) stack.push(full);
          else if (ent.name.startsWith("0")) hit.push(full.replace(__dirname, ""));
        }
      }
    } catch {}
    return hit;
  }
  const a = scan(path.join(__dirname, "public", "images"));
  const b = scan(path.join(__dirname, "public"));
  const set = Array.from(new Set([...a, ...b]));
  res.json({ ok:true, matches: set });
});

app.post("/api/admin/cleanup-images", (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok:false, error:"Unauthorized" });
  const dirs = [ path.join(__dirname, "public", "images"), path.join(__dirname, "public") ];
  let deleted = 0, checked = 0, found = [];
  for (const rootDir of dirs) {
    try {
      if (!fs.existsSync(rootDir)) continue;
      const stack = [rootDir];
      while (stack.length) {
        const dir = stack.pop();
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            stack.push(full);
          } else {
            checked++;
            if (ent.name.startsWith("0")) {
              found.push(full.replace(__dirname, ""));
              try { fs.unlinkSync(full); deleted++; } catch (e) { console.error("[CLEANUP] err:", full, e); }
            }
          }
        }
      }
    } catch (e) { console.error("[CLEANUP] scan err:", e); }
  }
  res.json({ ok:true, checked, deleted, found });
});

app.get("/api/admin/ping",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  res.json({ok:true});
});

app.get("/api/admin/users",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const rows = db.prepare(
    "SELECT id,email,is_admin,is_disabled,balance_silver,created_at,last_seen,shop_buy_count,next_recipe_at FROM users"
  ).all();
  const users = rows.map(u=>({
    id:u.id,
    email:u.email,
    is_admin:!!u.is_admin,
    is_disabled:!!u.is_disabled,
    gold:Math.floor(u.balance_silver/100),
    silver:u.balance_silver%100,
    created_at:u.created_at,
    last_seen:u.last_seen,
    shop_buy_count:u.shop_buy_count,
    next_recipe_at:u.next_recipe_at
  }));
  res.json({ok:true,users});
});

app.post("/api/admin/adjust-balance",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email,gold=0,silver=0,delta_silver} = req.body||{};
  if (!isEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u = db.prepare("SELECT id,balance_silver FROM users WHERE lower(email)=lower(?)").get(email);
  if (!u) return res.status(404).json({ok:false,error:"User not found"});
  let deltaS = (typeof delta_silver==="number") ? Math.trunc(delta_silver) : (Math.trunc(gold)*100 + Math.trunc(silver));
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
  const items = db.prepare(
    "SELECT i.id,i.code,i.name,i.tier,ui.qty FROM user_items ui JOIN items i ON i.id=ui.item_id WHERE ui.user_id=? AND ui.qty>0 ORDER BY i.tier,i.name"
  ).all(uid);
  const recipes = db.prepare(
    "SELECT r.id,r.code,r.name,r.tier,ur.qty FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id WHERE ur.user_id=? AND ur.qty>0 ORDER BY r.tier,r.name"
  ).all(uid);
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

// ----------------- BONUS status/claim -----------------
function itemCodesByTier(tier){
  const rows = db.prepare("SELECT code FROM items WHERE tier=? ORDER BY code").all(tier|0);
  return rows.map(r=>r.code);
}
function itemIdByCode(code){
  const r = db.prepare("SELECT id FROM items WHERE code=?").get(code);
  return r ? r.id : null;
}
function userHasItemQty(userId, itemId, needQty){
  const r = db.prepare("SELECT qty FROM user_items WHERE user_id=? AND item_id=?").get(userId, itemId);
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
        if (id && userHasItemQty(uid, id, 1)) owned.push(c);
        else missing.push(c);
      }
      tiers[t] = { owned, missing, total: codes.length, claimed: !!claimed['t' + t] };
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
    const already = db.prepare("SELECT 1 FROM set_bonuses WHERE user_id=? AND tier=?").get(uid, tier);
    if (already) return res.status(409).json({ ok:false, error:"Already claimed" });
    const codes = itemCodesByTier(tier);
    if (codes.length !== 10) return res.status(500).json({ ok:false, error:"Tier does not have exactly 10 items" });
    const tx = db.transaction(()=>{
      for (const c of codes){
        const id = itemIdByCode(c);
        if (!id) throw new Error("Missing item "+c);
        const q = db.prepare("SELECT qty FROM user_items WHERE user_id=? AND item_id=?").get(uid, id);
        if (!q || (q.qty|0) <= 0) throw new Error("Missing required item: "+c);
      }
      for (const c of codes){
        const id = itemIdByCode(c);
        db.prepare("UPDATE user_items SET qty = qty - 1 WHERE user_id=? AND item_id=?").run(uid, id);
      }
      db.prepare("INSERT INTO set_bonuses(user_id,tier,claimed_at) VALUES (?,?,?)").run(uid, tier, nowISO());
    });
    tx();
    const claimed = getClaimedTiers(uid);
    res.json({ ok:true, claimed, perks: perksFromClaimed(claimed) });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// ----------------- SHOP (T1) -----------------
const SHOP_T1_COST_S_BASE = 100;
const RECIPE_DROP_MIN = 4;
const RECIPE_DROP_MAX = 8;

function nextRecipeInterval(){
  const min = RECIPE_DROP_MIN, max = RECIPE_DROP_MAX;
  return Math.floor(Math.random()*(max-min+1))+min;
}
function pickWeightedRecipe(minTier=2){
  const list = db.prepare("SELECT id, code, name, tier FROM recipes WHERE tier BETWEEN ? AND 5").all(minTier|0);
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

// ----------------- RECIPES & CRAFT -----------------
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
    const recipe = db.prepare("SELECT id, code, name, tier, output_item_id FROM recipes WHERE id=?").get(id);
    if (!recipe) return res.status(404).json({ ok:false, error:"Recipe not found" });
    const ingredients = db.prepare(`
      SELECT ri.item_id, ri.qty, i.code, i.name, i.tier, COALESCE(ui.qty,0) AS have
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
      const r = db.prepare("SELECT id, name, tier, output_item_id FROM recipes WHERE id=?").get(rid);
      if (!r) throw new Error("Recipe not found.");
      const haveRec = db.prepare("SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?").get(tok.uid, r.id);
      if (!haveRec || haveRec.qty <= 0) throw new Error("You don't own this recipe.");
      const need = db.prepare(`
        SELECT ri.item_id, ri.qty, i.name
        FROM recipe_ingredients ri
        JOIN items i ON i.id = ri.item_id
        WHERE ri.recipe_id = ?
      `).all(r.id);
      let missing = [];
      for (const n of need) {
        const inv = db.prepare("SELECT qty FROM user_items WHERE user_id=? AND item_id=?").get(tok.uid, n.item_id);
        if (!inv || inv.qty < n.qty) missing.push(n.name);
      }
      if (missing.length > 0) throw { code: "MISSING_MATS", missing };
      for (const n of need) db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(n.qty, tok.uid, n.item_id);
      const perks = getPerks(tok.uid);
      const fail = perks.craft_no_fail ? false : (Math.random() < 0.10);
      if (!fail) {
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(tok.uid, r.output_item_id);
        db.prepare("UPDATE user_recipes SET qty=qty-1 WHERE user_id=? AND recipe_id=?").run(tok.uid, r.id);
        const out = db.prepare("SELECT code, name, tier FROM items WHERE id=?").get(r.output_item_id);
        return { result:"success", crafted: out };
      } else {
        const scrap = db.prepare("SELECT id FROM items WHERE code='SCRAP'").get();
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

// ----------------- ARTEFACT craft -----------------
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
      for (const it of picked) db.prepare("UPDATE user_items SET qty=qty-1 WHERE user_id=? AND item_id=?").run(tok.uid, it.id);
      const art = db.prepare("SELECT id, bonus_gold FROM items WHERE code='ARTEFACT'").get();
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

// ----------------- INVENTORY -----------------
app.get("/api/inventory", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });
  try {
    const items = db.prepare(`
      SELECT i.id, i.code, i.name, i.tier, ui.qty
      FROM user_items ui
      JOIN items i ON i.id = ui.item_id
      WHERE ui.user_id = ? AND ui.qty > 0
      ORDER BY i.tier ASC, i.name ASC
    `).all(tok.uid);

    const recipes = db.prepare(`
      SELECT r.id, r.code, r.name, r.tier, ur.qty
      FROM user_recipes ur
      JOIN recipes r ON r.id = ur.recipe_id
      WHERE ur.user_id = ? AND ur.qty > 0
      ORDER BY r.tier ASC, r.name ASC
    `).all(tok.uid);

    const arte = db.prepare(`SELECT bonus_gold FROM items WHERE code='ARTEFACT'`).get();
    const artefactBonusGold = arte ? (arte.bonus_gold|0) : 0;

    res.json({ ok:true, items, recipes, artefactBonusGold });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// ----------------- MARKETPLACE (sales) -----------------

// helper: compile listing row for API responses
function shapeListing(row) {
  return {
    id: row.id,
    seller_user_id: row.seller_user_id,
    kind: row.type === "recipe" ? "recipe" : "item",
    item_id: row.item_id || null,
    recipe_id: row.recipe_id || null,
    code: row.code || null,
    name: row.title || row.name || null,
    tier: row.tier || null,
    qty: row.qty|0,
    price_s: row.price_s|0,
    status: row.status
  };
}

// LIVE listings (with optional ?q= search)
app.get("/api/sales/live", (req, res) => {
  try{
    const q = (req.query.q || "").toString().trim().toLowerCase();
    let rows = db.prepare(`
      SELECT s.*, i.code AS i_code, i.name AS i_name, i.tier AS i_tier,
             r.code AS r_code, r.name AS r_name, r.tier AS r_tier
      FROM sales s
      LEFT JOIN items i   ON s.type='item'   AND i.id = s.item_id
      LEFT JOIN recipes r ON s.type='recipe' AND r.id = s.recipe_id
      WHERE s.status='live'
      ORDER BY s.created_at DESC
    `).all();

    rows = rows.map(r => {
      const name = r.title || (r.type==='item' ? r.i_name : r.r_name) || "";
      const code = (r.type==='item' ? r.i_code : r.r_code) || null;
      const tier = (r.type==='item' ? r.i_tier : r.r_tier) || null;
      return {
        ...shapeListing(r),
        code,
        name,
        tier
      };
    });

    if (q) {
      rows = rows.filter(r => (r.name||"").toLowerCase().includes(q));
    }

    // UI ionako filtrira ARTEFACT/T6, ali i ovdje pazimo:
    rows = rows.filter(r => !(r.kind==="item" && (r.code==="ARTEFACT" || (r.tier|0)>=6)));

    res.json({ ok:true, listings: rows });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// My listings
app.get("/api/sales/mine", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });
  try{
    let rows = db.prepare(`
      SELECT s.*, i.code AS i_code, i.name AS i_name, i.tier AS i_tier,
             r.code AS r_code, r.name AS r_name, r.tier AS r_tier
      FROM sales s
      LEFT JOIN items i   ON s.type='item'   AND i.id = s.item_id
      LEFT JOIN recipes r ON s.type='recipe' AND r.id = s.recipe_id
      WHERE s.seller_user_id = ?
      ORDER BY s.created_at DESC
    `).all(tok.uid);

    rows = rows.map(r => {
      const name = r.title || (r.type==='item' ? r.i_name : r.r_name) || "";
      const code = (r.type==='item' ? r.i_code : r.r_code) || null;
      const tier = (r.type==='item' ? r.i_tier : r.r_tier) || null;
      return {
        ...shapeListing(r),
        code,
        name,
        tier
      };
    });

    res.json({ ok:true, listings: rows });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// Create listing
// body: { kind: "item"|"recipe", id, qty, gold, silver }
app.post("/api/sales/list", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });
  try{
    const { kind, id, qty, gold=0, silver=0 } = req.body || {};
    const k = (kind==="recipe") ? "recipe" : "item";
    const srcId = parseInt(id,10);
    const q = Math.max(1, parseInt(qty,10) || 1);
    let s = Math.max(0, parseInt(silver,10) || 0); if (s>99) s=99;
    const g = Math.max(0, parseInt(gold,10) || 0);
    const price_s = g*100 + s;

    if (!srcId) return res.status(400).json({ ok:false, error:"Bad id" });
    if (price_s <= 0) return res.status(400).json({ ok:false, error:"Price must be > 0" });

    const insert = db.transaction(() => {
      if (k === "item") {
        const item = db.prepare(`
          SELECT i.id AS item_id, i.code, i.name, i.tier, ui.qty
          FROM user_items ui
          JOIN items i ON i.id = ui.item_id
          WHERE ui.user_id=? AND ui.item_id=? AND ui.qty >= ?
        `).get(tok.uid, srcId, q);
        if (!item) throw new Error("Not enough quantity");
        if (item.code === "ARTEFACT" || (item.tier|0) >= 6) throw new Error("Cannot list this item");

        // enforce per-user min price if user has T5 bonus (UI hint)
        const perks = getPerks(tok.uid);
        if (perks.min_list_price_s && price_s < perks.min_list_price_s) {
          throw new Error(`Minimum price is ${perks.min_list_price_s}s`);
        }

        db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(q, tok.uid, item.item_id);
        db.prepare(`
          INSERT INTO sales(seller_user_id,type,item_id,qty,price_s,title,status,created_at)
          VALUES (?,?,?,?,?,'', 'live', ?)
        `).run(tok.uid, "item", item.item_id, q, price_s, nowISO());
      } else {
        const rec = db.prepare(`
          SELECT r.id AS recipe_id, r.code, r.name, r.tier, ur.qty
          FROM user_recipes ur
          JOIN recipes r ON r.id = ur.recipe_id
          WHERE ur.user_id=? AND ur.recipe_id=? AND ur.qty >= ?
        `).get(tok.uid, srcId, q);
        if (!rec) throw new Error("Not enough quantity");

        const perks = getPerks(tok.uid);
        if (perks.min_list_price_s && price_s < perks.min_list_price_s) {
          throw new Error(`Minimum price is ${perks.min_list_price_s}s`);
        }

        db.prepare("UPDATE user_recipes SET qty=qty-? WHERE user_id=? AND recipe_id=?").run(q, tok.uid, rec.recipe_id);
        db.prepare(`
          INSERT INTO sales(seller_user_id,type,recipe_id,qty,price_s,title,status,created_at)
          VALUES (?,?,?,?,?,'', 'live', ?)
        `).run(tok.uid, "recipe", rec.recipe_id, q, price_s, nowISO());
      }
    });
    insert();

    res.json({ ok:true });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// Buy listing
// body: { id }
app.post("/api/sales/buy", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });

  try{
    const { id } = req.body || {};
    const sid = parseInt(id,10);
    if (!sid) return res.status(400).json({ ok:false, error:"Bad id" });

    const result = db.transaction(() => {
      const s = db.prepare(`
        SELECT * FROM sales WHERE id=? AND status='live'
      `).get(sid);
      if (!s) throw new Error("Listing not found");
      if (s.seller_user_id === tok.uid) throw new Error("It's your listing");

      const buyer = db.prepare("SELECT id, balance_silver FROM users WHERE id=?").get(tok.uid);
      const seller = db.prepare("SELECT id, balance_silver FROM users WHERE id=?").get(s.seller_user_id);
      if (!buyer || !seller) throw new Error("User missing");

      const price = s.price_s | 0;
      if (buyer.balance_silver < price) throw new Error("Insufficient funds");

      // Fee (affects seller proceeds). Default 1% (100 bps). If seller has T3 claimed -> 0%.
      const sellerPerks = getPerks(s.seller_user_id);
      const fee_bps = sellerPerks.auction_fee_bps ?? 100; // 100=1%
      const fee = Math.floor(price * (fee_bps / 10000));
      const proceeds = price - fee;

      // money move
      db.prepare("UPDATE users SET balance_silver = balance_silver - ? WHERE id=?").run(price, buyer.id);
      db.prepare("UPDATE users SET balance_silver = balance_silver + ? WHERE id=?").run(proceeds, seller.id);

      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(buyer.id, -price, "MARKET_BUY", String(sid), nowISO());
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(seller.id, proceeds, "MARKET_SELL", String(sid), nowISO());
      if (fee > 0) {
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
          .run(seller.id, -fee, "MARKET_FEE", String(sid), nowISO());
      }

      // transfer goods to buyer + close listing
      if (s.type === "item") {
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,?)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty = qty + excluded.qty
        `).run(buyer.id, s.item_id, s.qty);
      } else {
        db.prepare(`
          INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
          VALUES (?,?,?,0)
          ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty = qty + excluded.qty
        `).run(buyer.id, s.recipe_id, s.qty);
      }

      db.prepare("UPDATE sales SET status='sold', buyer_user_id=?, sold_at=?, sold_price_s=? WHERE id=?")
        .run(buyer.id, nowISO(), price, s.id);

      const afterBuyer  = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(buyer.id).balance_silver;
      const afterSeller = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(seller.id).balance_silver;
      return { buyer_balance_silver: afterBuyer, seller_balance_silver: afterSeller };
    })();

    res.json({ ok:true, ...result });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// Cancel listing (seller only, live -> return to inventory)
app.post("/api/sales/cancel", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });

  try{
    const { id } = req.body || {};
    const sid = parseInt(id,10);
    if (!sid) return res.status(400).json({ ok:false, error:"Bad id" });

    db.transaction(() => {
      const s = db.prepare("SELECT * FROM sales WHERE id=? AND status='live'").get(sid);
      if (!s) throw new Error("Listing not found");
      if (s.seller_user_id !== tok.uid) throw new Error("Not your listing");

      if (s.type === "item") {
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,?)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty = qty + excluded.qty
        `).run(tok.uid, s.item_id, s.qty);
      } else {
        db.prepare(`
          INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
          VALUES (?,?,?,0)
          ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty = qty + excluded.qty
        `).run(tok.uid, s.recipe_id, s.qty);
      }

      db.prepare("UPDATE sales SET status='canceled' WHERE id=?").run(sid);
    })();

    res.json({ ok:true });
  }catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});



// ----------------- DEFAULT ADMIN USER (optional) -----------------
(function ensureDefaultAdmin(){
  if (!DEFAULT_ADMIN_EMAIL) return;
  const have = db.prepare("SELECT id,is_admin FROM users WHERE lower(email)=lower(?)").get(DEFAULT_ADMIN_EMAIL);
  if (!have) {
    const hash = bcrypt.hashSync("changeme", 10);
    db.prepare(`
      INSERT INTO users(email,pass_hash,created_at,is_admin,is_disabled,balance_silver,shop_buy_count,next_recipe_at,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(DEFAULT_ADMIN_EMAIL, hash, new Date().toISOString(), 1, 0, 0, 0, null, new Date().toISOString());
    console.log("[seed] created default admin:", DEFAULT_ADMIN_EMAIL);
  } else if (!have.is_admin) {
    db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(have.id);
    console.log("[seed] elevated admin:", DEFAULT_ADMIN_EMAIL);
  }
})();

//-----helt------
app.get("/health", (_req,res)=> res.json({ ok:true, ts: Date.now() }));


// ----------------- START -----------------
server.listen(PORT, HOST, () => {
  console.log(`ARTEFACT server listening at http://${HOST}:${PORT}`);
});









