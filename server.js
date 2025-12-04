// ARTEFACT • Full Server (Express + better-sqlite3) + BONUS sekcija + BONUS CODES 

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

const USD_TO_GOLD = 1000; 
const MIN_USD = 1; 
const PAYPAL_MODE = (process.env.PAYPAL_MODE || "sandbox").toLowerCase(); // "live" | "sandbox"
const PAYPAL_BASE = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";
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
        if (ent.isDirectory()) {
          stack.push(full);
        } else {
          checked++;
          if (ent.name.startsWith("0")) {
            found.push(full);
            try { fs.unlinkSync(full); deleted++; }
            catch (e) { console.error("[CLEANUP] del err:", full, e); }
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
    r = {
      checked: r1.checked + r2.checked,
      deleted: r1.deleted + r2.deleted,
      found: [...r1.found, ...r2.found]
    };
  }

  console.log(`[CLEANUP] Pregledano: ${r.checked}, obrisano: ${r.deleted}`);

  if (r.found.length)
    console.log("[CLEANUP] Obrisano:", r.found.map(p => p.replace(__dirname, "")).join(" | "));
  else
    console.log('[CLEANUP] Nije našao fajlove koji počinju sa "0" u /public(/images)');
})();

// ----------------- APP -----------------

const app = express();
const server = http.createServer(app);
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

// Static
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

// ----------------- DB -----------------

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

// -------- Helpers --------

const nowISO = () => new Date().toISOString();

function isEmail(x){
  return typeof x === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
}
function isPass(x){
  return typeof x === "string" && x.length >= 6;
}

function signToken(u){
  return jwt.sign({ uid: u.id, email: u.email }, JWT_SECRET, { expiresIn: "7d" });
}

function readToken(req){
  const t = req.cookies && req.cookies[TOKEN_NAME];
  if (!t) return null;
  try { return jwt.verify(t, JWT_SECRET); }
  catch { return null; }
}

function verifyTokenFromCookies(req){
  const tok = readToken(req);
  if (!tok) return null;
  return { uid: tok.uid, email: tok.email };
}

function requireAuth(req){
  const tok = readToken(req);
  if (!tok) throw new Error("Not logged in.");
  const u = db.prepare("SELECT id, is_disabled FROM users WHERE id=?").get(tok.uid);
  if (!u || u.is_disabled) throw new Error("Account disabled");
  return u.id;
}

function isAdmin(req){
  const hdr = String(req.headers["x-admin-key"] || "");
  if (hdr && hdr === ADMIN_KEY) return true;

  const tok = readToken(req);
  if (!tok) return false;

  const r = db.prepare("SELECT is_admin, is_disabled FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin === 1 && r.is_disabled !== 1);
}

function addMinutes(iso, mins){
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + mins);
  return d.toISOString();
}

function isReqSecure(req){
  return !!(
    req.secure ||
    String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https"
  );
}

const fetch = global.fetch || ((...args) =>
  import("node-fetch").then(({ default: f }) => f(...args))
);

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
  if (!res.ok) throw new Error("PayPal token fail: " + JSON.stringify(data));
  return data.access_token;
}

async function paypalGetOrder(accessToken, orderId){
  const res = await fetch(PAYPAL_BASE + "/v2/checkout/orders/" + encodeURIComponent(orderId), {
    headers: { "Authorization": "Bearer " + accessToken }
  });

  const data = await res.json();
  if (!res.ok) throw new Error("PayPal order fail: " + JSON.stringify(data));
  return data;
}


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
    return res.status(200).json({
      ok: false,
      configured: false,
      error: String(e.message || e)
    });
  }
});


app.post("/api/paypal/create-order", async (req, res) => {
  try {
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
          user_action: "PAY_NOW"
        }
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(400).json({
        ok:false,
        error:"Create order failed",
        details:data
      });
    }

    return res.json({ ok:true, id: data.id });

  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// ----------------- MIGRATIONS -----------------

function ensure(sql){ db.exec(sql); }

function tableExists(name) {
  try {
    return !!db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
  } catch {
    return false;
  }
}

function hasColumn(table, col) {
  try {
    const tbl = String(table).replace(/[^A-Za-z0-9_]/g, "");
    const rows = db.prepare(`PRAGMA table_info(${tbl})`).all();
    return rows.some(c => c.name === col);
  } catch {
    return false;
  }
}

/* ---------- CORE TABLES ---------- */
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

ensure(`
  CREATE TABLE IF NOT EXISTS set_bonuses(
    user_id INTEGER NOT NULL,
    tier INTEGER NOT NULL CHECK(tier IN (2,3,4,5)),
    claimed_at TEXT NOT NULL,
    PRIMARY KEY(user_id, tier),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

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
  try { db.exec(`ALTER TABLE paypal_payments ADD COLUMN bonus_code TEXT;`); }
  catch {}
}

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

if (!hasColumn("bonus_codes", "total_credited_silver")) {
  db.exec(`ALTER TABLE bonus_codes ADD COLUMN total_credited_silver INTEGER NOT NULL DEFAULT 0;`);
}
if (!hasColumn("bonus_codes", "updated_at")) {
  db.exec(`ALTER TABLE bonus_codes ADD COLUMN updated_at TEXT;`);
}
if (!hasColumn("bonus_codes", "is_active")) {
  db.exec(`ALTER TABLE bonus_codes ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`);
}
if (!hasColumn("bonus_codes", "percent")) {
  db.exec(`ALTER TABLE bonus_codes ADD COLUMN percent INTEGER NOT NULL DEFAULT 0;`);
}

// (Opcionalno, ali korisno) — ako je netko ručno stavio negativne postotke ili >100, normaliziraj:
try {
  db.exec(`UPDATE bonus_codes SET percent = CASE WHEN percent < 0 THEN 0 WHEN percent > 100 THEN 100 ELSE percent END`);
} catch {}

db.transaction(() => {

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
    if (!hasColumn("auctions", "winner_user_id"))         db.exec(`ALTER TABLE auctions ADD COLUMN winner_user_id INTEGER;`);
    if (!hasColumn("auctions", "sold_price_s"))           db.exec(`ALTER TABLE auctions ADD COLUMN sold_price_s INTEGER;`);
    if (!hasColumn("auctions", "highest_bid_s"))          db.exec(`ALTER TABLE auctions ADD COLUMN highest_bid_s INTEGER;`);
    if (!hasColumn("auctions", "highest_bidder_user_id")) db.exec(`ALTER TABLE auctions ADD COLUMN highest_bidder_user_id INTEGER;`);
  }

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
    if (!hasColumn("inventory_escrow", "type"))       db.exec(`ALTER TABLE inventory_escrow ADD COLUMN type TEXT NOT NULL DEFAULT 'item';`);
    if (!hasColumn("inventory_escrow", "auction_id")) db.exec(`ALTER TABLE inventory_escrow ADD COLUMN auction_id INTEGER;`);
  }
 
  /* ===== ADS TABLE ===== */
  if (!tableExists("ads")) {
    db.exec(`
      CREATE TABLE ads(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_ads_user ON ads(user_id);
      CREATE INDEX IF NOT EXISTS idx_ads_created ON ads(created_at DESC);
    `);
  }

});

/* ----------------- SEED (Items & Recipes,----------------- */

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
  if (!outId) throw new Error("Missing item "+outCode);

  const r = db.prepare("SELECT id FROM recipes WHERE code=?").get(code);
  let rid;

  if (!r){
    db.prepare("INSERT INTO recipes(code,name,tier,output_item_id) VALUES (?,?,?,?)")
      .run(code,name,tier,outId);
    rid = db.prepare("SELECT id FROM recipes WHERE code=?").get(code).id;
  } else {
    db.prepare("UPDATE recipes SET name=?, tier=?, output_item_id=? WHERE id=?")
      .run(name,tier,outId,r.id);
    rid = r.id;
    db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id=?").run(rid);
  }

  for (const c of ingCodes){
    const iid = idByCode(c);
    if (!iid) throw new Error("Missing ingredient "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,1)")
      .run(rid,iid);
  }

  return rid;
}

// T1
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

const NAME_BY_CODE = Object.fromEntries([
  ["SCRAP","Scrap"],
  ...T1,
  ...T2_ITEMS,
  ...T3_ITEMS,
  ...T4_ITEMS,
  ...T5_ITEMS,
]);

const nameFor = c => NAME_BY_CODE[c] || c;

const RECIPES_T2 = {
  T2_BRONZE_DOOR:["BRONZE","BRONZE","BRONZE","BRONZE"],
  T2_SILVER_GOBLET:["SILVER","SILVER","SILVER","GOLD"],
  T2_GOLDEN_RING:["GOLD","GOLD","GOLD","CRYSTAL"],
  T2_WOODEN_CHEST:["WOOD","WOOD","WOOD","IRON","LEATHER"],
  T2_STONE_PILLAR:["STONE","STONE","STONE","STONE","CRYSTAL"],
  T2_LEATHER_BAG:["LEATHER","LEATHER","LEATHER","CLOTH","IRON"],
  T2_CLOTH_TENT:["CLOTH","CLOTH","CLOTH","WOOD","LEATHER","CLOTH"],
  T2_CRYSTAL_ORB:["CRYSTAL","CRYSTAL","CRYSTAL","SILVER","GOLD","STONE"],
  T2_OBSIDIAN_KNIFE:["OBSIDIAN","OBSIDIAN","OBSIDIAN","OBSIDIAN","WOOD","LEATHER","STONE"],
  T2_IRON_ARMOR:["IRON","IRON","IRON","IRON","LEATHER","CLOTH","BRONZE"]
};

const RECIPES_T3 = {
  T3_GATE_OF_MIGHT:["T2_BRONZE_DOOR","T2_BRONZE_DOOR","T2_BRONZE_DOOR","T2_BRONZE_DOOR"],
  T3_GOBLET_OF_WISDOM:["T2_SILVER_GOBLET","T2_SILVER_GOBLET","T2_SILVER_GOBLET","T2_CRYSTAL_ORB"],
  T3_RING_OF_GLARE:["T2_GOLDEN_RING","T2_GOLDEN_RING","T2_GOLDEN_RING","T2_CRYSTAL_ORB","T2_SILVER_GOBLET"],
  T3_CHEST_OF_SECRETS:["T2_WOODEN_CHEST","T2_WOODEN_CHEST","T2_WOODEN_CHEST","T2_SILVER_GOBLET","T2_OBSIDIAN_KNIFE"],
  T3_PILLAR_OF_STRENGTH:["T2_STONE_PILLAR","T2_STONE_PILLAR","T2_STONE_PILLAR","T2_STONE_PILLAR","T2_WOODEN_CHEST"],
  T3_TRAVELERS_BAG:["T2_LEATHER_BAG","T2_LEATHER_BAG","T2_LEATHER_BAG","T2_OBSIDIAN_KNIFE","T2_SILVER_GOBLET","T2_GOLDEN_RING"],
  T3_NOMAD_TENT:["T2_CLOTH_TENT","T2_CLOTH_TENT","T2_CLOTH_TENT","T2_CRYSTAL_ORB","T2_WOODEN_CHEST","T2_OBSIDIAN_KNIFE"],
  T3_ORB_OF_VISION:["T2_CRYSTAL_ORB","T2_CRYSTAL_ORB","T2_CRYSTAL_ORB","T2_CRYSTAL_ORB","T2_SILVER_GOBLET","T2_GOLDEN_RING"],
  T3_KNIFE_OF_SHADOW:["T2_OBSIDIAN_KNIFE","T2_OBSIDIAN_KNIFE","T2_OBSIDIAN_KNIFE","T2_OBSIDIAN_KNIFE","T2_LEATHER_BAG","T2_GOLDEN_RING","T2_WOODEN_CHEST"],
  T3_ARMOR_OF_GUARD:["T2_IRON_ARMOR","T2_IRON_ARMOR","T2_IRON_ARMOR","T2_IRON_ARMOR","T2_WOODEN_CHEST","T2_GOLDEN_RING","T2_LEATHER_BAG"]
};

const RECIPES_T4 = {
  T4_CRYSTAL_LENS:["T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_GOBLET_OF_WISDOM","T3_RING_OF_GLARE"],
  T4_ENGINE_CORE:["T3_ARMOR_OF_GUARD","T3_ARMOR_OF_GUARD","T3_ARMOR_OF_GUARD","T3_CHEST_OF_SECRETS","T3_KNIFE_OF_SHADOW"],
  T4_MIGHT_GATE:["T3_GATE_OF_MIGHT","T3_GATE_OF_MIGHT","T3_GATE_OF_MIGHT","T3_GATE_OF_MIGHT","T3_GATE_OF_MIGHT","T3_CHEST_OF_SECRETS"],
  T4_NOMAD_DWELLING:["T3_NOMAD_TENT","T3_NOMAD_TENT","T3_NOMAD_TENT","T3_TRAVELERS_BAG","T3_CHEST_OF_SECRETS","T3_KNIFE_OF_SHADOW"],
  T4_SECRET_CHEST:["T3_CHEST_OF_SECRETS","T3_CHEST_OF_SECRETS","T3_CHEST_OF_SECRETS","T3_ORB_OF_VISION","T3_NOMAD_TENT","T3_KNIFE_OF_SHADOW"],
  T4_SHADOW_BLADE:["T3_KNIFE_OF_SHADOW","T3_KNIFE_OF_SHADOW","T3_KNIFE_OF_SHADOW","T3_KNIFE_OF_SHADOW","T3_CHEST_OF_SECRETS","T3_RING_OF_GLARE","T3_TRAVELERS_BAG"],
  T4_STRENGTH_PILLAR:["T3_PILLAR_OF_STRENGTH","T3_PILLAR_OF_STRENGTH","T3_PILLAR_OF_STRENGTH","T3_PILLAR_OF_STRENGTH","T3_PILLAR_OF_STRENGTH","T3_PILLAR_OF_STRENGTH","T3_ORB_OF_VISION"],
  T4_TRAVELER_SATCHEL:["T3_TRAVELERS_BAG","T3_TRAVELERS_BAG","T3_TRAVELERS_BAG","T3_TRAVELERS_BAG","T3_NOMAD_TENT","T3_KNIFE_OF_SHADOW","T3_RING_OF_GLARE"],
  T4_VISION_CORE:["T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_ORB_OF_VISION","T3_GOBLET_OF_WISDOM","T3_RING_OF_GLARE","T3_CHEST_OF_SECRETS","T3_KNIFE_OF_SHADOW"],
  T4_WISDOM_GOBLET:["T3_GOBLET_OF_WISDOM","T3_GOBLET_OF_WISDOM","T3_GOBLET_OF_WISDOM","T3_GOBLET_OF_WISDOM","T3_ORB_OF_VISION","T3_RING_OF_GLARE","T3_CHEST_OF_SECRETS","T3_KNIFE_OF_SHADOW"]
};

const RECIPES_T5 = {
  T5_ANCIENT_RELIC:["T4_SECRET_CHEST","T4_SECRET_CHEST","T4_SECRET_CHEST","T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING","T4_SHADOW_BLADE"],
  T5_SUN_LENS:["T4_CRYSTAL_LENS","T4_CRYSTAL_LENS","T4_CRYSTAL_LENS","T4_VISION_CORE","T4_WISDOM_GOBLET","T4_CRYSTAL_LENS"],
  T5_GUARDIAN_GATE:["T4_MIGHT_GATE","T4_MIGHT_GATE","T4_MIGHT_GATE","T4_MIGHT_GATE","T4_ENGINE_CORE","T4_STRENGTH_PILLAR","T4_SECRET_CHEST"],
  T5_NOMAD_HALL:["T4_NOMAD_DWELLING","T4_NOMAD_DWELLING","T4_NOMAD_DWELLING","T4_NOMAD_DWELLING","T4_TRAVELER_SATCHEL","T4_SECRET_CHEST","T4_SHADOW_BLADE"],
  T5_VAULT:["T4_ENGINE_CORE","T4_ENGINE_CORE","T4_ENGINE_CORE","T4_ENGINE_CORE","T4_MIGHT_GATE","T4_STRENGTH_PILLAR","T4_CRYSTAL_LENS"],
  T5_COLOSSAL_PILLAR:["T4_STRENGTH_PILLAR","T4_STRENGTH_PILLAR","T4_STRENGTH_PILLAR","T4_STRENGTH_PILLAR","T4_ENGINE_CORE","T4_SECRET_CHEST","T4_SHADOW_BLADE","T4_VISION_CORE"],
  T5_WAYFARER_BAG:["T4_TRAVELER_SATCHEL","T4_TRAVELER_SATCHEL","T4_TRAVELER_SATCHEL","T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING","T4_VISION_CORE","T4_CRYSTAL_LENS","T4_WISDOM_GOBLET"],
  T5_EYE_OF_TRUTH:["T4_VISION_CORE","T4_VISION_CORE","T4_VISION_CORE","T4_VISION_CORE","T4_CRYSTAL_LENS","T4_WISDOM_GOBLET","T4_SHADOW_BLADE","T4_SECRET_CHEST"],
  T5_NIGHTFALL_EDGE:["T4_SHADOW_BLADE","T4_SHADOW_BLADE","T4_SHADOW_BLADE","T4_SHADOW_BLADE","T4_VISION_CORE","T4_CRYSTAL_LENS","T4_SECRET_CHEST","T4_NOMAD_DWELLING","T4_TRAVELER_SATCHEL"],
  T5_WISDOM_CHALICE:["T4_WISDOM_GOBLET","T4_WISDOM_GOBLET","T4_WISDOM_GOBLET","T4_WISDOM_GOBLET","T4_VISION_CORE","T4_SECRET_CHEST","T4_TRAVELER_SATCHEL","T4_ENGINE_CORE","T4_NOMAD_DWELLING"]
};

function seedRecipeMap(tier, map){
  for (const [outCode, ingCodes] of Object.entries(map))
    ensureRecipe("R_"+outCode, nameFor(outCode), tier, outCode, ingCodes);
}

seedRecipeMap(2, RECIPES_T2);
seedRecipeMap(3, RECIPES_T3);
seedRecipeMap(4, RECIPES_T4);
seedRecipeMap(5, RECIPES_T5);

ensureItem("ARTEFACT","Artefact",6,0);

try {
  db.prepare(`UPDATE recipes SET name = 'R ' || name WHERE name NOT LIKE 'R %'`).run();
} catch {}

// ----------------- AUTH -----------------

app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!isEmail(email)) return res.status(400).json({ ok:false, error:"Bad email" });
    if (!isPass(password)) return res.status(400).json({ ok:false, error:"Password too short" });
    
    const exists = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(String(email||"").toLowerCase());
    if (exists) return res.status(409).json({ ok:false, error:"Email taken" });
    
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


function sanitizeCode(raw){
  const s = String(raw||"").trim().toUpperCase();
  return s.replace(/[^A-Z0-9_.-]/g,"").slice(0,32);
}

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
      if (code) {
        const dup = db.prepare("SELECT slot FROM bonus_codes WHERE code=? AND slot<>?").get(code, slot);
        if (dup) db.prepare("UPDATE bonus_codes SET code=NULL WHERE slot=?").run(dup.slot);
      }
      
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
    const pu = order?.purchase_units?.[0];
    const captureAmt = pu?.payments?.captures?.[0]?.amount;
    const orderAmt   = pu?.amount;
    const amt        = captureAmt || orderAmt;
    
    const currency = amt?.currency_code;
    const paid     = Number(amt?.value);
    if (currency !== "USD" || !Number.isFinite(paid)) {
      return res.status(400).json({ ok:false, error: "Unsupported currency or invalid amount" });
    }
    
    if (paid < MIN_USD) {
      return res.status(400).json({ ok:false, error: `Minimum is $${MIN_USD}` });
    }


    const addGold = Math.floor(paid * USD_TO_GOLD);
    const baseSilver = addGold * 100;
    
    const code = sanitizeCode(rawCode || "");
    const slotRow = code
      ? db.prepare("SELECT slot, percent, is_active FROM bonus_codes WHERE upper(code)=?").get(code)
      : null;
    const pct = (slotRow && slotRow.is_active) ? Math.max(0, Math.min(100, (slotRow.percent|0))) : 0;
    const bonusSilver = Math.floor(baseSilver * pct / 100);
    const totalSilverToAdd = baseSilver + bonusSilver;
    
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

app.get("/api/me", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false });

  const u = db.prepare(
    "SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?"
  ).get(tok.uid);

  if (!u) {
    res.clearCookie(TOKEN_NAME, {
      httpOnly: true,
      sameSite: "lax",
      secure: isReqSecure(req),
      path: "/"
    });
    return res.status(401).json({ ok:false });
  }

  const buysToNext =
    (u.next_recipe_at == null)
      ? null
      : Math.max(0, (u.next_recipe_at || 0) - (u.shop_buy_count || 0));

  const hasArt = userHasArtefact(u.id);
  const claimed = getClaimedTiers(u.id);
  const perks = perksFromClaimed(claimed);

  return res.json({
    ok:true,
    user:{
      id: u.id,
      email: u.email,
      is_admin: !!u.is_admin,
      balance_silver: u.balance_silver,
      gold: Math.floor(u.balance_silver / 100),
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

// ----------------- TRANSFER GOLD -----------------

app.post("/api/transfer-gold", (req, res) => {
  try {
    const senderId = requireAuth(req);
    const { email, gold } = req.body || {};

    if (!isEmail(email))
      return res.status(400).json({ ok:false, error:"Bad email" });

    const g = Math.trunc(gold);
    if (!(g > 0))
      return res.status(400).json({ ok:false, error:"Gold must be > 0" });

    if (!userHasArtefact(senderId))
      return res.status(403).json({ ok:false, error:"Artefact required" });

    const recipient = db.prepare(
      "SELECT id, is_disabled FROM users WHERE lower(email)=lower(?)"
    ).get(String(email).toLowerCase());

    if (!recipient || recipient.is_disabled)
      return res.status(404).json({ ok:false, error:"Recipient not found" });

    if (recipient.id === senderId)
      return res.status(400).json({ ok:false, error:"Cannot send to yourself" });

    const deltaS = g * 100;

    const out = db.transaction(() => {
      const s = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(senderId);
      if (!s || (s.balance_silver|0) < deltaS)
        throw new Error("Insufficient funds");

      db.prepare(`
        UPDATE users SET balance_silver = balance_silver - ?
        WHERE id=?
      `).run(deltaS, senderId);

      db.prepare(`
        UPDATE users SET balance_silver = balance_silver + ?
        WHERE id=?
      `).run(deltaS, recipient.id);

      const now = nowISO();

      db.prepare(`
        INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at)
        VALUES (?,?,?,?,?)
      `).run(senderId, -deltaS, "TRANSFER_OUT", String(recipient.id), now);

      db.prepare(`
        INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at)
        VALUES (?,?,?,?,?)
      `).run(recipient.id, deltaS, "TRANSFER_IN", String(senderId), now);

      const after = db.prepare("SELECT balance_silver FROM users WHERE id=?")
        .get(senderId).balance_silver;

      return { balance_silver: after };
    })();

    res.json({ ok:true, ...out });

  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// ----------------- ADS SYSTEM -----------------

ensure(`
  CREATE TABLE IF NOT EXISTS ads(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    price_s INTEGER NOT NULL DEFAULT 10000,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

app.get("/api/ads/list", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.id, a.text, a.price_s, u.email
      FROM ads a
      JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC
      LIMIT 200
    `).all();
    res.json({ ok:true, ads: rows });
  } catch {
    res.status(500).json({ ok:false, error:"Failed to load ads" });
  }
});

app.post("/api/ads/create", (req, res) => {
  try {
    const uid = requireAuth(req);
    const text = String(req.body?.text || "").trim();
    if (!text) return res.json({ ok:false, error:"Empty text" });

    const cost_s = 100 * 100;

    const out = db.transaction(() => {
      const u = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(uid);
      if (!u || u.balance_silver < cost_s)
        return { ok:false, error:"Not enough gold" };

      const newBal = u.balance_silver - cost_s;
      db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(newBal, uid);

      db.prepare(`
        INSERT INTO ads(user_id,text,price_s,created_at)
        VALUES (?,?,?,?)
      `).run(uid, text, cost_s, nowISO());

      const count = db.prepare(`SELECT COUNT(*) AS c FROM ads`).get().c;

      if (count > 50) {
        const del = count - 50;
        db.prepare(`
          DELETE FROM ads
          WHERE id IN (SELECT id FROM ads ORDER BY id ASC LIMIT ?)
        `).run(del);
      }

      return { ok:true, balance_silver:newBal };
    })();

    res.json(out);

  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});


// ----------------- ADMIN core -----------------

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
        const r2 = db.prepare("UPDATE user_items SET qty = qty - 1 WHERE user_id=? AND item_id=? AND qty > 0").run(uid, id);
        if (r2.changes === 0) throw new Error("Missing required item: " + c);
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
const SHOP_T1_COST_S_BASE = 10;
const RECIPE_DROP_MIN = 5;
const RECIPE_DROP_MAX = 10;

function nextRecipeInterval(){
  return Math.floor(Math.random() * (RECIPE_DROP_MAX - RECIPE_DROP_MIN + 1)) + RECIPE_DROP_MIN;
}

function pickWeightedRecipe(minTier = 2){
  const list = db.prepare(
    "SELECT id, code, name, tier FROM recipes WHERE tier BETWEEN ? AND ?"
  ).all(minTier, 5);

  if (!list.length) return null;

  const byTier = {};
  for (const r of list) (byTier[r.tier] ||= []).push(r);

  const roll = Math.floor(Math.random() * 1000) + 1;
  let tier = (roll <= 13 ? 5 : roll <= 50 ? 4 : roll <= 200 ? 3 : 2);

  if (tier < minTier) tier = minTier;
  while (tier >= minTier && !byTier[tier]) tier--;

  const arr = byTier[tier] || byTier[minTier];
  return arr[Math.floor(Math.random() * arr.length)];
}


// ----------------- BUY T1 -----------------
app.post("/api/shop/buy-t1", (req, res) => {
  const uTok = verifyTokenFromCookies(req);
  if (!uTok) return res.status(401).json({ ok:false, error:"Not logged in." });

  const qty = Math.max(1, parseInt(req.body?.qty || "1", 10));

  try {
    const result = db.transaction(() => {

      const user = db.prepare(`
        SELECT id, balance_silver, shop_buy_count, next_recipe_at
        FROM users
        WHERE id=?
      `).get(uTok.uid);

      if (!user) throw new Error("Session expired.");

      const costSingle = SHOP_T1_COST_S_BASE * 10;
      const totalCost  = costSingle * qty;

      if (user.balance_silver < totalCost)
        throw new Error("Insufficient funds.");

      // plati
      db.prepare(`
        UPDATE users SET balance_silver = balance_silver - ?
        WHERE id=?
      `).run(totalCost, user.id);

      db.prepare(`
        INSERT INTO gold_ledger(user_id, delta_s, reason, ref, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, -totalCost, "SHOP_BUY_T1", null, nowISO());

      // T1 bez SCRAP
      const t1 = db.prepare(
        "SELECT id, code, name FROM items WHERE tier=1 AND volatile=0"
      ).all();

      if (t1.length === 0)
        throw new Error("No T1 items");

      // random itemi
      for (let i = 0; i < qty; i++) {
        const pick = t1[Math.floor(Math.random() * t1.length)];
        db.prepare(`
          INSERT INTO user_items(user_id, item_id, qty)
          VALUES (?, ?, 1)
          ON CONFLICT(user_id, item_id)
          DO UPDATE SET qty = qty + 1
        `).run(user.id, pick.id);
      }

      // recipe drop
      let nextAt = user.next_recipe_at;
      const newBuyCount = (user.shop_buy_count || 0) + qty;

      if (nextAt == null) {
        nextAt = newBuyCount + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(nextAt, user.id);
      }

      db.prepare("UPDATE users SET shop_buy_count=? WHERE id=?").run(newBuyCount, user.id);

      let gotRecipe = null;

      if (newBuyCount >= nextAt) {
        const pick = pickWeightedRecipe();
        if (pick) {
          db.prepare(`
            INSERT INTO user_recipes(user_id, recipe_id, qty, attempts)
            VALUES (?, ?, 1, 0)
            ON CONFLICT(user_id, recipe_id)
            DO UPDATE SET qty = qty + 1
          `).run(user.id, pick.id);
          gotRecipe = pick;
        }

        const next = newBuyCount + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(next, user.id);
      }

      const bal = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(user.id).balance_silver;

      return { balance_silver: bal, gotRecipe };
    })();

    res.json({ ok:true, ...result });

  } catch (err) {
    res.status(400).json({ ok:false, error:String(err.message || err) });
  }
});

// ----------------- SHOP INFO -----------------
app.get("/api/shop/info", (req, res) => {
  try {
    const tok = readToken(req);
    if (!tok) return res.status(401).json({ ok:false });

    const u = db.prepare(`
      SELECT balance_silver, shop_buy_count, next_recipe_at
      FROM users WHERE id=?
    `).get(tok.uid);

    if (!u) return res.json({ ok:false });

    res.json({
      ok: true,
      balance_silver: u.balance_silver,
      shop_buy_count: u.shop_buy_count,
      next_recipe_at: u.next_recipe_at
    });

  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});



//                     DAILY QUESTS — BACKEND

const QUESTS = [
  { code:"TAB_SHOP",       reward_g:20 },
  { code:"TAB_CRAFT",      reward_g:20 },
  { code:"TAB_MARKET",     reward_g:20 },
  { code:"TAB_INV",        reward_g:20 },
  { code:"TAB_BONUS",      reward_g:20 },
  { code:"TAB_ADS",        reward_g:20 },

  { code:"CRAFT_T2",       reward_g:20 },
  { code:"CRAFT_T3",       reward_g:30 },
  { code:"CRAFT_T4",       reward_g:40 },
  { code:"CRAFT_T5",       reward_g:50 },

  { code:"AUC_T2",         reward_g:20 },
  { code:"AUC_T3",         reward_g:30 },
  { code:"AUC_T4",         reward_g:40 },
  { code:"AUC_T5",         reward_g:50 },

  { code:"BUY_AUC_T2",     reward_g:20 },
  { code:"BUY_AUC_T3",     reward_g:30 },
  { code:"BUY_AUC_T4",     reward_g:40 },
  { code:"BUY_AUC_T5",     reward_g:50 },

  { code:"BUY_MATERIAL",   reward_g:10 },

  { code:"RECIPE_T2",      reward_g:20 },
  { code:"RECIPE_T3",      reward_g:30 },
  { code:"RECIPE_T4",      reward_g:40 },
  { code:"RECIPE_T5",      reward_g:50 },

  { code:"CRAFT_ARTEFACT", reward_g:10000 },

  { code:"SHOP_SPEND_100", reward_g:50 },

  { code:"ADS_FIRST",      reward_g:100 },


  { code:"BUY_USD_1",      reward_g:1000 },
  { code:"BUY_USD_10",     reward_g:10000 },
  { code:"BUY_USD_50",     reward_g:50000 }
];

const QUEST_MAP = {
  "shop-click":   "TAB_SHOP",
  "craft-click":  "TAB_CRAFT",
  "market-click": "TAB_MARKET",
  "inv-click":    "TAB_INV",
  "bonus-click":  "TAB_BONUS",
  "ads-click":    "TAB_ADS",

  "ads-first": "ADS_FIRST",

  "craft-t2": "CRAFT_T2",
  "craft-t3": "CRAFT_T3",
  "craft-t4": "CRAFT_T4",
  "craft-t5": "CRAFT_T5",

  "sell-t2": "AUC_T2",
  "sell-t3": "AUC_T3",
  "sell-t4": "AUC_T4",
  "sell-t5": "AUC_T5",

  "buy-t2": "BUY_AUC_T2",
  "buy-t3": "BUY_AUC_T3",
  "buy-t4": "BUY_AUC_T4",
  "buy-t5": "BUY_AUC_T5",

  "buy-mat": "BUY_MATERIAL",

  "rec-t2": "RECIPE_T2",
  "rec-t3": "RECIPE_T3",
  "rec-t4": "RECIPE_T4",
  "rec-t5": "RECIPE_T5",

  "artifact": "CRAFT_ARTEFACT",

  "shop-spend": "SHOP_SPEND_100",

  "buy-gold-1":  "BUY_USD_1",
  "buy-gold-10": "BUY_USD_10",
  "buy-gold-50": "BUY_USD_50"
};


// =======================================================
// SQL tabela
// =======================================================
ensure(`
  CREATE TABLE IF NOT EXISTS user_quests(
    user_id INTEGER NOT NULL,
    quest_code TEXT NOT NULL,
    done_at TEXT NOT NULL,
    PRIMARY KEY(user_id, quest_code, done_at),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

function todayKey(){
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const dd = String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${dd}`;
}


// =======================================================
// GET DAILY LIST
// =======================================================
app.get("/api/quests/daily", (req, res) => {
  try{
    const uid = requireAuth(req);
    const day = todayKey();

    const rows = db.prepare(`
      SELECT quest_code FROM user_quests
      WHERE user_id=? AND done_at=?
    `).all(uid, day);

    const doneSet = new Set(rows.map(r => r.quest_code));

    const list = QUESTS.map(q => ({
      code: q.code,
      reward_g: q.reward_g,
      done: doneSet.has(q.code)
    }));

    res.json({ ok:true, day, quests:list });

  } catch(err){
    res.json({ ok:false, error:"not_logged_in" });
  }
});


// =======================================================
// TRIGGER QUEST EVENT
// =======================================================
app.post("/api/quests/event", (req, res) => {
  try{
    const uid = requireAuth(req);
    const incoming = req.body?.code;

    if (!incoming)
      return res.json({ ok:false, error:"missing_code" });

    const code = QUEST_MAP[incoming];

    if (!code)
      return res.json({ ok:false, error:"unknown_code" });

    const q = QUESTS.find(x => x.code === code);
    if (!q)
      return res.json({ ok:false, error:"undefined_quest" });

    const day = todayKey();

    // već uradjen?
    const row = db.prepare(`
      SELECT 1 FROM user_quests
      WHERE user_id=? AND quest_code=? AND done_at=?
    `).get(uid, code, day);

    if (row)
      return res.json({ ok:true, already:true });

    db.prepare(`
      INSERT INTO user_quests(user_id,quest_code,done_at)
      VALUES (?,?,?)
    `).run(uid, code, day);

    const addSilver = q.reward_g * 100;

    const cur = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(uid)?.balance_silver || 0;
    const newBal = cur + addSilver;

    db.prepare(`UPDATE users SET balance_silver=? WHERE id=?`)
      .run(newBal, uid);

    db.prepare(`
      INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at)
      VALUES (?,?,?,?,?)
    `).run(uid, addSilver, "QUEST", code, nowISO());

    res.json({ ok:true, reward_g:q.reward_g });

  } catch(err){
    res.json({ ok:false, error:"server_error" });
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
    const recipe = db.prepare(`
      SELECT id, code, name, tier, output_item_id
      FROM recipes
      WHERE id=?
    `).get(id);

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

  const rid = parseInt(req.body?.recipe_id, 10);
  if (!rid) return res.status(400).json({ ok:false, error:"Missing recipe_id" });

  try {
    const result = db.transaction(() => {

      const r = db.prepare(`
        SELECT id, name, tier, output_item_id
        FROM recipes
        WHERE id=?
      `).get(rid);

      if (!r) throw new Error("Recipe not found.");

      const haveRec = db.prepare(`
        SELECT qty FROM user_recipes
        WHERE user_id=? AND recipe_id=?
      `).get(tok.uid, r.id);

      if (!haveRec || haveRec.qty <= 0)
        throw new Error("You don't own this recipe.");

      const need = db.prepare(`
        SELECT ri.item_id, ri.qty, i.name
        FROM recipe_ingredients ri
        JOIN items i ON i.id = ri.item_id
        WHERE ri.recipe_id=?
      `).all(r.id);

      let missing = [];
      for (const n of need) {
        const inv = db.prepare(`
          SELECT qty FROM user_items
          WHERE user_id=? AND item_id=?
        `).get(tok.uid, n.item_id);

        if (!inv || inv.qty < n.qty)
          missing.push(n.name);
      }

      if (missing.length) throw { code:"MISSING_MATS", missing };

      for (const n of need)
        db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?")
          .run(n.qty, tok.uid, n.item_id);

      const perks = getPerks(tok.uid);
      const fail = perks.craft_no_fail ? false : (Math.random() < 0.10);

      if (!fail) {
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id)
          DO UPDATE SET qty=qty+1
        `).run(tok.uid, r.output_item_id);

        db.prepare(`
          UPDATE user_recipes SET qty=qty-1
          WHERE user_id=? AND recipe_id=?
        `).run(tok.uid, r.id);

        const out = db.prepare(`
          SELECT code, name, tier FROM items WHERE id=?
        `).get(r.output_item_id);

        return { result:"success", crafted: out };
      } else {
        const scrap = db.prepare("SELECT id FROM items WHERE code='SCRAP'").get();
        if (scrap) {
          db.prepare(`
            INSERT INTO user_items(user_id,item_id,qty)
            VALUES (?,?,1)
            ON CONFLICT(user_id,item_id)
            DO UPDATE SET qty=qty+1
          `).run(tok.uid, scrap.id);
        }
        return { result:"fail", scrap:true };
      }

    })();

    res.json({ ok:true, ...result });

  } catch(e) {
    if (e && e.code === "MISSING_MATS") {
      return res.status(400).json({
        ok:false,
        error:"Not all required materials are available.",
        missing:e.missing
      });
    }
    res.status(400).json({ ok:false, error:String(e.message || e) });
  }
});

// ----------------- ARTEFACT CRAFT -----------------

app.post("/api/craft/artefact", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });

  try {
    const result = db.transaction(() => {

      const have = db.prepare(`
        SELECT i.id, i.code, i.name, i.tier, ui.qty
        FROM items i
        JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
        WHERE i.tier=5 AND ui.qty>0
        ORDER BY i.name
      `).all(tok.uid);

      if (!have || have.length < 10)
        throw new Error("Need 10 distinct T5 items.");

      const picked = have.slice(0, 10);

      for (const it of picked)
        db.prepare(`
          UPDATE user_items SET qty=qty-1
          WHERE user_id=? AND item_id=?
        `).run(tok.uid, it.id);

      const art = db.prepare(`
        SELECT id FROM items WHERE code='ARTEFACT'
      `).get();

      if (!art) throw new Error("ARTEFACT item missing (seed).");

      db.prepare(`
        INSERT INTO user_items(user_id,item_id,qty)
        VALUES (?, ?, 1)
        ON CONFLICT(user_id,item_id)
        DO UPDATE SET qty=qty+1
      `).run(tok.uid, art.id);

      return { crafted:"Artefact" };
    })();

    res.json({ ok:true, crafted: result.crafted });

  } catch(e) {
    res.status(400).json({ ok:false, error:String(e.message || e) });
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

    res.json({ ok:true, items, recipes });

  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});

// -----------------------------------------------------
// MARKETPLACE
// -----------------------------------------------------

function shapeListing(row) {
  return {
    id: row.id,
    seller_user_id: row.seller_user_id,
    kind: row.type === "recipe" ? "recipe" : "item",
    item_id: row.item_id || null,
    recipe_id: row.recipe_id || null,
    code: row.code || null,
    name: row.name || null,
    tier: row.tier || null,
    qty: row.qty|0,
    price_s: row.price_s|0,
    status: row.status
  };
}


// ------------------ LIVE LISTINGS ------------------

app.get("/api/sales/live", (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();

    let rows = db.prepare(`
      SELECT s.*,
             i.code AS i_code, i.name AS i_name, i.tier AS i_tier,
             r.code AS r_code, r.name AS r_name, r.tier AS r_tier
      FROM sales s
      LEFT JOIN items   i ON s.type='item'   AND i.id = s.item_id
      LEFT JOIN recipes r ON s.type='recipe' AND r.id = s.recipe_id
      WHERE s.status='live'
      ORDER BY s.id DESC
      LIMIT 500
    `).all();

    rows = rows.map(r => {
      const code = r.type==="item" ? r.i_code : r.r_code;
      const name = r.type==="item" ? r.i_name : r.r_name;
      const tier = r.type==="item" ? r.i_tier : r.r_tier;
      return {
        ...shapeListing(r),
        code,
        name,
        tier
      };
    });

    // search
    if (q) {
      rows = rows.filter(r => (r.name||"").toLowerCase().includes(q));
    }

    // no ARTEFACT / no tier >=6
    rows = rows.filter(r =>
      !(r.kind==="item" && (r.code==="ARTEFACT" || (r.tier|0)>=6))
    );

    res.json({ ok:true, listings:rows });

  } catch(e){
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});


// ------------------ MY LISTINGS ------------------

app.get("/api/sales/mine", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });

  try {
    let rows = db.prepare(`
      SELECT s.*,
             i.code AS i_code, i.name AS i_name, i.tier AS i_tier,
             r.code AS r_code, r.name AS r_name, r.tier AS r_tier
      FROM sales s
      LEFT JOIN items   i ON s.type='item'   AND i.id = s.item_id
      LEFT JOIN recipes r ON s.type='recipe' AND r.id = s.recipe_id
      WHERE s.seller_user_id = ?
      ORDER BY s.id DESC
    `).all(tok.uid);

    rows = rows.map(r => {
      const code = r.type==="item" ? r.i_code : r.r_code;
      const name = r.type==="item" ? r.i_name : r.r_name;
      const tier = r.type==="item" ? r.i_tier : r.r_tier;
      return {
        ...shapeListing(r),
        code,
        name,
        tier
      };
    });

    res.json({ ok:true, listings:rows });

  } catch(e){
    res.status(500).json({ ok:false, error:String(e.message||e) });
  }
});


// ------------------ CREATE LISTING ------------------

app.post("/api/sales/create", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });

  try {
    const { kind, id, qty, gold=0, silver=0 } = req.body || {};
    const k = (kind==="recipe") ? "recipe" : "item";

    const srcId = parseInt(id,10);
    const q = Math.max(1, parseInt(qty,10) || 1);

    let s = Math.max(0, parseInt(silver,10) || 0);
    if (s>99) s=99;
    const g = Math.max(0, parseInt(gold,10) || 0);

    const price_s = g*100 + s;

    if (!srcId) return res.json({ ok:false, error:"Bad id" });
    if (price_s <= 0) return res.json({ ok:false, error:"Price must be > 0" });

    db.transaction(() => {

      if (k==="item") {
        const item = db.prepare(`
          SELECT i.id AS item_id, i.code, i.name, i.tier, ui.qty
          FROM user_items ui
          JOIN items i ON i.id = ui.item_id
          WHERE ui.user_id=? AND ui.item_id=? AND ui.qty>=?
        `).get(tok.uid, srcId, q);

        if (!item) throw new Error("Not enough items");

        if (item.code==="ARTEFACT" || (item.tier|0)>=6)
          throw new Error("Cannot list this item");

        db.prepare(`
          UPDATE user_items SET qty=qty-?
          WHERE user_id=? AND item_id=?
        `).run(q, tok.uid, item.item_id);

        db.prepare(`
          INSERT INTO sales(seller_user_id,type,item_id,qty,price_s,title,status,created_at)
          VALUES (?,?,?,?,?,'','live',?)
        `).run(tok.uid, "item", item.item_id, q, price_s, nowISO());

      } else {
        const rec = db.prepare(`
          SELECT r.id AS recipe_id, r.code, r.name, r.tier, ur.qty
          FROM user_recipes ur
          JOIN recipes r ON r.id = ur.recipe_id
          WHERE ur.user_id=? AND ur.recipe_id=? AND ur.qty>=?
        `).get(tok.uid, srcId, q);

        if (!rec) throw new Error("Not enough recipes");

        db.prepare(`
          UPDATE user_recipes SET qty=qty-?
          WHERE user_id=? AND recipe_id=?
        `).run(q, tok.uid, rec.recipe_id);

        db.prepare(`
          INSERT INTO sales(seller_user_id,type,recipe_id,qty,price_s,title,status,created_at)
          VALUES (?,?,?,?,?,'','live',?)
        `).run(tok.uid, "recipe", rec.recipe_id, q, price_s, nowISO());
      }

    })();

    res.json({ ok:true });

  } catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});


// ------------------ BUY LISTING ------------------

app.post("/api/sales/buy", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });

  try {
    const sid = parseInt(req.body?.id,10);
    if (!sid) return res.json({ ok:false, error:"Bad id" });

    const result = db.transaction(() => {
      const s = db.prepare(`
        SELECT * FROM sales
        WHERE id=? AND status='live'
      `).get(sid);

      if (!s) throw new Error("Listing not found");
      if (s.seller_user_id === tok.uid)
        throw new Error("Cannot buy your own listing");

      const buyer = db.prepare(`
        SELECT id,balance_silver FROM users WHERE id=?
      `).get(tok.uid);

      const seller = db.prepare(`
        SELECT id,balance_silver FROM users WHERE id=?
      `).get(s.seller_user_id);

      const price = s.price_s|0;
      if (buyer.balance_silver < price)
        throw new Error("Insufficient funds");

      // SELLER FEE
      const sellerPerks = getPerks(s.seller_user_id);
      const fee_bps = sellerPerks.auction_fee_bps ?? 100; // 1%
      const fee = Math.floor(price * (fee_bps/10000));
      const proceeds = price - fee;

      // money
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?")
        .run(price, buyer.id);

      db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?")
        .run(proceeds, seller.id);

      // ledger
      db.prepare(`
        INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at)
        VALUES (?,?,?,?,?)
      `).run(buyer.id, -price, "MARKET_BUY", String(sid), nowISO());

      db.prepare(`
        INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at)
        VALUES (?,?,?,?,?)
      `).run(seller.id, proceeds, "MARKET_SELL", String(sid), nowISO());

      if (fee>0){
        db.prepare(`
          INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at)
          VALUES (?,?,?,?,?)
        `).run(seller.id, -fee, "MARKET_FEE", String(sid), nowISO());
      }

      // goods → buyer
      if (s.type==="item") {
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,?)
          ON CONFLICT(user_id,item_id)
          DO UPDATE SET qty=qty+excluded.qty
        `).run(buyer.id, s.item_id, s.qty);
      } else {
        db.prepare(`
          INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
          VALUES (?,?,?,0)
          ON CONFLICT(user_id,recipe_id)
          DO UPDATE SET qty=qty+excluded.qty
        `).run(buyer.id, s.recipe_id, s.qty);
      }

      db.prepare(`
        UPDATE sales
        SET status='sold', buyer_user_id=?, sold_at=?, sold_price_s=?
        WHERE id=?
      `).run(buyer.id, nowISO(), price, s.id);

      const afterBuyer = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(buyer.id).balance_silver;
      return { balance_silver: afterBuyer };
    })();

    res.json({ ok:true, ...result });

  } catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});


// ------------------ CANCEL LISTING ------------------

app.post("/api/sales/cancel", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error:"Not logged in." });

  try {
    const sid = parseInt(req.body?.id,10);
    if (!sid) return res.json({ ok:false, error:"Bad id" });

    db.transaction(() => {
      const s = db.prepare(`
        SELECT * FROM sales WHERE id=? AND status='live'
      `).get(sid);

      if (!s) throw new Error("Listing not found");
      if (s.seller_user_id !== tok.uid)
        throw new Error("Not your listing");

      if (s.type==="item") {
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,?)
          ON CONFLICT(user_id,item_id)
          DO UPDATE SET qty=qty+excluded.qty
        `).run(tok.uid, s.item_id, s.qty);
      } else {
        db.prepare(`
          INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
          VALUES (?,?,?,0)
          ON CONFLICT(user_id,recipe_id)
          DO UPDATE SET qty=qty+excluded.qty
        `).run(tok.uid, s.recipe_id, s.qty);
      }

      db.prepare("UPDATE sales SET status='canceled' WHERE id=?")
        .run(sid);
    });

    res.json({ ok:true });

  } catch(e){
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});


// ----------------- ADS BUY COURSE -----------------

app.post("/api/ads/buy-course", (req, res) => {
  try {
    const uid = requireAuth(req);
    const cost_s = 100000 * 100;

    const out = db.transaction(() => {
      const u = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(uid);
      if (!u || u.balance_silver < cost_s)
        return { ok:false, error:"Not enough gold" };

      const newBal = u.balance_silver - cost_s;
      db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(newBal, uid);

      return { ok:true, balance_silver:newBal };
    })();

    if (!out.ok) return res.json(out);

    const access_code =
      "COURSE-" + Math.random().toString(36).slice(2,8).toUpperCase();

    res.json({
      ok:true,
      balance_silver: out.balance_silver,
      access_code
    });

  } catch (e) {
    res.status(500).json({ ok:false, error:"Failed to buy course" });
  }
});



// ----------------- DEFAULT ADMIN USER (optional) -----------------

(function ensureDefaultAdmin(){
  if (!DEFAULT_ADMIN_EMAIL) return;

  const have = db.prepare(
    "SELECT id, is_admin FROM users WHERE lower(email)=lower(?)"
  ).get(DEFAULT_ADMIN_EMAIL);

  if (!have) {
    const hash = bcrypt.hashSync("changeme", 10);

    db.prepare(`
      INSERT INTO users(email,pass_hash,created_at,is_admin,is_disabled,balance_silver,shop_buy_count,next_recipe_at,last_seen)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      DEFAULT_ADMIN_EMAIL,
      hash,
      new Date().toISOString(),
      1,
      0,
      0,
      0,
      null,
      new Date().toISOString()
    );

    console.log("[seed] created default admin:", DEFAULT_ADMIN_EMAIL);

  } else if (!have.is_admin) {

    db.prepare("UPDATE users SET is_admin=1 WHERE id=?")
      .run(have.id);

    console.log("[seed] elevated admin:", DEFAULT_ADMIN_EMAIL);
  }
})();

//-----helt------

app.get("/health", (_req,res)=> res.json({ ok:true, ts: Date.now() }));

app.get(/^\/(?!api\/).*/, (_req, res) => 
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ----------------- START -----------------

server.listen(PORT, HOST, () => {
  console.log(`ARTEFACT server listening at http://${HOST}:${PORT}`);
});









