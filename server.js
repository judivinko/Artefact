// ==============================================
// ARTEFACT • Full Server (Express + better-sqlite3)
// Auth (register/login/logout/me)
// Shop T1 -> random T1 or recipe drop (T2–T5 weighted)
// Crafting (fail 10% osim ARTEFACT; ARTEFACT = 10 distinct T5)
// Sales (fixed-price preko "auctions"): list, live, mine, buy, cancel (+escrow)
// Admin helpers (ping, users, adjust, disable, inventory)
// DB na disku (env DB_PATH). Admin UI na /admin (admin.html ne diramo)
// ==============================================

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ---------- Config
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";
const TOKEN_NAME = "token";
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || "judi.vinko81@gmail.com").toLowerCase();

const DB_FILE = process.env.DB_PATH || path.join(__dirname, "data", "artefact.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// ---------- App
const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
app.use(express.json());
app.use(cookieParser());

// Static
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html"))); // admin.html se ne dira

//---ARTEFACT BONUS GOLD (ADMIN)
app.post("/api/admin/set-bonus-gold", (req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});

  const { code="ARTEFACT", bonus_gold=0 } = req.body || {};
  const g = Math.max(0, parseInt(bonus_gold,10) || 0);

  const row = db.prepare(`SELECT id FROM items WHERE code=?`).get(String(code));
  if (!row) return res.status(404).json({ok:false,error:"Item not found"});

  db.prepare(`UPDATE items SET bonus_gold=? WHERE code=?`).run(g, String(code));
  return res.json({ ok:true, bonus_gold:g });
});

// Root i Admin HTML
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "admin.html"))
);

// SPA fallback za sve ne-API GET rute (npr. direktan refresh na /sales, /inv, …)
app.get(/^\/(?!api\/).*/, (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ---------- DB
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

// ====== DB MIGRATIONS (SALES + ESCROW) START ======
function tableExists(name) {
  try { return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name); }
  catch { return false; }
}
function hasColumn(table, col) {
  try { return !!db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === col); }
  catch { return false; }
}

db.transaction(() => {
  // Legacy 'sales' (može postojati — držimo kompatibilnost)
  if (!tableExists("sales")) {
    db.exec(`
      CREATE TABLE sales(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_user_id INTEGER NOT NULL,
        type TEXT NOT NULL,            -- 'item' | 'recipe'
        item_id INTEGER,
        recipe_id INTEGER,
        qty INTEGER NOT NULL DEFAULT 1,
        price_s INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'live',  -- 'live' | 'sold' | 'canceled'
        created_at TEXT NOT NULL,
        sold_at TEXT,
        buyer_user_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sales_live ON sales(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sales_seller ON sales(seller_user_id, status);
    `);
  } else {
    if (!hasColumn("sales", "price_s"))       db.exec(`ALTER TABLE sales ADD COLUMN price_s INTEGER NOT NULL DEFAULT 0;`);
    if (!hasColumn("sales", "title"))         db.exec(`ALTER TABLE sales ADD COLUMN title TEXT NOT NULL DEFAULT '';`);
    if (!hasColumn("sales", "status"))        db.exec(`ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'live';`);
    if (!hasColumn("sales", "buyer_user_id")) db.exec(`ALTER TABLE sales ADD COLUMN buyer_user_id INTEGER;`);
    if (!hasColumn("sales", "sold_at"))       db.exec(`ALTER TABLE sales ADD COLUMN sold_at TEXT;`);
  }

  // Auctions (koristimo za marketplace)
  if (!tableExists("auctions")) {
    db.exec(`
      CREATE TABLE auctions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seller_user_id INTEGER NOT NULL,
        type TEXT NOT NULL,              -- 'item' | 'recipe'
        item_id INTEGER,
        recipe_id INTEGER,
        qty INTEGER NOT NULL DEFAULT 1,
        start_price_s INTEGER NOT NULL DEFAULT 0,
        buy_now_price_s INTEGER,
        fee_bps INTEGER NOT NULL DEFAULT 100, -- 1% default
        status TEXT NOT NULL DEFAULT 'live',  -- 'live' | 'paid' | 'canceled'
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
  }

  // Escrow
  if (!tableExists("inventory_escrow")) {
    db.exec(`
      CREATE TABLE inventory_escrow(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        auction_id INTEGER,
        owner_user_id INTEGER NOT NULL,
        type TEXT NOT NULL DEFAULT 'item',  -- 'item' | 'recipe'
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
})();
// ====== DB MIGRATIONS (SALES + ESCROW) END ======


// ---------- Helpers
const nowISO = () => new Date().toISOString();
function isEmail(x){ return typeof x==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x); }
function isPass(x){ return typeof x==="string" && x.length>=6; }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function readToken(req){
  const t = req.cookies && req.cookies[TOKEN_NAME];
  if(!t) return null;
  try{ return jwt.verify(t, JWT_SECRET); }catch{ return null; }
}
function requireAuth(req) {
  const tok = readToken(req);
  if (!tok) throw new Error("Not logged in.");
  const u = db.prepare("SELECT id,is_disabled FROM users WHERE id=?").get(tok.uid);
  if (!u || u.is_disabled) throw new Error("Account disabled");
  return u.id;
}
function verifyTokenFromCookies(req) {
  const tok = readToken(req);
  if (!tok) return null;
  return { uid: tok.uid, email: tok.email };
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

// ---------- Schema
function ensure(sql){ db.exec(sql); }

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
  volatile INTEGER NOT NULL DEFAULT 0
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

// Escrow & Auctions
ensure(`
CREATE TABLE IF NOT EXISTS inventory_escrow(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER,
  owner_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,          -- 'item' | 'recipe'
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);`);

ensure(`
CREATE TABLE IF NOT EXISTS sales(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,          -- 'item' | 'recipe'
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT '',
  price_s INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live',
  created_at TEXT NOT NULL
);`);

// Defensive migrations
function hasCol(tab, col){
  try{ return db.prepare(`PRAGMA table_info(${tab})`).all().some(c=>c.name===col); }catch{ return false; }
}
if (!hasCol("sales","title"))   db.prepare(`ALTER TABLE sales ADD COLUMN title TEXT NOT NULL DEFAULT ''`).run();
if (!hasCol("sales","price_s")) db.prepare(`ALTER TABLE sales ADD COLUMN price_s INTEGER NOT NULL DEFAULT 0`).run();
if (!hasCol("sales","status"))  db.prepare(`ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'live'`).run();
if (!hasCol("inventory_escrow","auction_id")) db.prepare(`ALTER TABLE inventory_escrow ADD COLUMN auction_id INTEGER`).run();
if (!hasCol("items","bonus_gold")) db.prepare(`ALTER TABLE items ADD COLUMN bonus_gold INTEGER NOT NULL DEFAULT 0`).run();
//---MIGRATE: PREFIX "R " ZA SVE RECEPTE KOJI JE NEMAJU
try {
  db.prepare(`
    UPDATE recipes
    SET name = 'R ' || name
    WHERE name NOT LIKE 'R %'
  `).run();
} catch {}


// ---------- Seed helpers
function ensureItem(code, name, tier, volatile=0){
  const r = db.prepare("SELECT id FROM items WHERE code=?").get(code);
  if (r) { db.prepare("UPDATE items SET name=?, tier=?, volatile=? WHERE id=?").run(name,tier,volatile,r.id); return r.id; }
  db.prepare("INSERT INTO items(code,name,tier,volatile) VALUES (?,?,?,?)").run(code,name,tier,volatile);
  return db.prepare("SELECT id FROM items WHERE code=?").get(code).id;
}
function idByCode(code){ const r=db.prepare("SELECT id FROM items WHERE code=?").get(code); return r&&r.id; }
function ensureRecipe(code,name,tier,outCode,ingCodes){
  const outId = idByCode(outCode); if(!outId) throw new Error("Missing item "+outCode);
  const r = db.prepare("SELECT id FROM recipes WHERE code=?").get(code);
  let rid;
  if (!r){
    db.prepare("INSERT INTO recipes(code,name,tier,output_item_id) VALUES (?,?,?,?)").run(code,name,tier,outId);
    rid = db.prepare("SELECT id FROM recipes WHERE code=?").get(code).id;
  }else{
    db.prepare("UPDATE recipes SET name=?, tier=?, output_item_id=? WHERE id=?").run(name,tier,outId,r.id);
    rid = r.id;
    db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id=?").run(rid);
  }
  for(const c of ingCodes){
    const iid = idByCode(c); if(!iid) throw new Error("Missing ingredient "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,?)").run(rid,iid,1);
  }
  return rid;
}

// ---------- Items & Recipes  (ARTEFACT: recipes bez petlji, imena s "R ") ----------
ensureItem("SCRAP","Scrap",1,1);

// T1 materials (10)
const T1 = [
  ["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]
];
for (const [c,n] of T1) ensureItem(c,n,1,0);

// T2 items (samo itemi)
const T2_ITEMS = [
  ["T2_BRONZE_DOOR","Nor Bronze Door"],
  ["T2_SILVER_GOBLET","Nor Silver Goblet"],
  ["T2_GOLDEN_RING","Nor Golden Ring"],
  ["T2_WOODEN_CHEST","Nor Wooden Chest"],
  ["T2_STONE_PILLAR","Nor Stone Pillar"],
  ["T2_LEATHER_BAG","Nor Leather Bag"],
  ["T2_CLOTH_TENT","Nor Cloth Tent"],
  ["T2_CRYSTAL_ORB","Nor Crystal Orb"],
  ["T2_OBSIDIAN_KNIFE","Nor Obsidian Knife"],
  ["T2_IRON_ARMOR","Nor Iron Armor"]
];
for (const [code,name] of T2_ITEMS) ensureItem(code,name,2,0);

// T3 items (samo itemi)
const T3_ITEMS = [
  ["T3_GATE_OF_MIGHT","Nor Gate of Might"],
  ["T3_GOBLET_OF_WISDOM","Nor Goblet of Wisdom"],
  ["T3_RING_OF_GLARE","Nor Ring of Glare"],
  ["T3_CHEST_OF_SECRETS","Nor Chest of Secrets"],
  ["T3_PILLAR_OF_STRENGTH","Nor Pillar of Strength"],
  ["T3_TRAVELERS_BAG","Nor Traveler's Bag"],
  ["T3_NOMAD_TENT","Nor Nomad Tent"],
  ["T3_ORB_OF_VISION","Nor Orb of Vision"],
  ["T3_KNIFE_OF_SHADOW","Nor Knife of Shadow"],
  ["T3_ARMOR_OF_GUARD","Nor Armor of Guard"]
];
for (const [code,name] of T3_ITEMS) ensureItem(code,name,3,0);

// T4 items (samo itemi)
const T4_ITEMS = [
  ["T4_ENGINE_CORE","Nor Engine Core"],
  ["T4_CRYSTAL_LENS","Nor Crystal Lens"],
  ["T4_MIGHT_GATE","Nor Reinforced Gate"],
  ["T4_WISDOM_GOBLET","Nor Enruned Goblet"],
  ["T4_SECRET_CHEST","Nor Sealed Chest"],
  ["T4_STRENGTH_PILLAR","Nor Monument Pillar"],
  ["T4_TRAVELER_SATCHEL","Nor Traveler Satchel"],
  ["T4_NOMAD_DWELLING","Nor Nomad Dwelling"],
  ["T4_VISION_CORE","Nor Vision Core"],
  ["T4_SHADOW_BLADE","Nor Shadow Blade"]
];
for (const [code,name] of T4_ITEMS) ensureItem(code,name,4,0);

// T5 items (samo itemi)
const T5_ITEMS = [
  ["T5_ANCIENT_RELIC","Nor Ancient Relic"],
  ["T5_SUN_LENS","Nor Sun Lens"],
  ["T5_GUARDIAN_GATE","Nor Guardian Gate"],
  ["T5_WISDOM_CHALICE","Nor Wisdom Chalice"],
  ["T5_VAULT","Nor Royal Vault"],
  ["T5_COLOSSAL_PILLAR","Nor Colossal Pillar"],
  ["T5_WAYFARER_BAG","Nor Wayfarer Bag"],
  ["T5_NOMAD_HALL","Nor Nomad Hall"],
  ["T5_EYE_OF_TRUTH","Nor Eye of Truth"],
  ["T5_NIGHTFALL_EDGE","Nor Nightfall Edge"]
];
for (const [code,name] of T5_ITEMS) ensureItem(code,name,5,0);

// ===== Recepti T2 (bez petlji, imena s "R ")
ensureRecipe("R_T2_BRONZE_DOOR","R Nor Bronze Door",2,"T2_BRONZE_DOOR",["BRONZE","IRON","WOOD","STONE"]);
ensureRecipe("R_T2_SILVER_GOBLET","R Nor Silver Goblet",2,"T2_SILVER_GOBLET",["SILVER","GOLD","CRYSTAL","CLOTH"]);
ensureRecipe("R_T2_GOLDEN_RING","R Nor Golden Ring",2,"T2_GOLDEN_RING",["GOLD","SILVER","CRYSTAL","LEATHER"]);
ensureRecipe("R_T2_WOODEN_CHEST","R Nor Wooden Chest",2,"T2_WOODEN_CHEST",["WOOD","STONE","LEATHER","IRON","CLOTH"]);
ensureRecipe("R_T2_STONE_PILLAR","R Nor Stone Pillar",2,"T2_STONE_PILLAR",["STONE","WOOD","IRON","CLOTH"]);
ensureRecipe("R_T2_LEATHER_BAG","R Nor Leather Bag",2,"T2_LEATHER_BAG",["LEATHER","CLOTH","WOOD","SILVER"]);
ensureRecipe("R_T2_CLOTH_TENT","R Nor Cloth Tent",2,"T2_CLOTH_TENT",["CLOTH","LEATHER","WOOD","STONE","IRON"]);
ensureRecipe("R_T2_CRYSTAL_ORB","R Nor Crystal Orb",2,"T2_CRYSTAL_ORB",["CRYSTAL","GOLD","CLOTH","WOOD","LEATHER"]);
ensureRecipe("R_T2_OBSIDIAN_KNIFE","R Nor Obsidian Knife",2,"T2_OBSIDIAN_KNIFE",["OBSIDIAN","CRYSTAL","IRON","BRONZE"]);
ensureRecipe("R_T2_IRON_ARMOR","R Nor Iron Armor",2,"T2_IRON_ARMOR",["IRON","BRONZE","LEATHER","CLOTH","STONE"]);

// ===== Recepti T3
ensureRecipe("R_T3_GATE_OF_MIGHT","R Nor Gate of Might",3,"T3_GATE_OF_MIGHT",["T2_BRONZE_DOOR","T2_SILVER_GOBLET","T2_GOLDEN_RING","T2_WOODEN_CHEST"]);
ensureRecipe("R_T3_GOBLET_OF_WISDOM","R Nor Goblet of Wisdom",3,"T3_GOBLET_OF_WISDOM",["T2_SILVER_GOBLET","T2_GOLDEN_RING","T2_STONE_PILLAR","T2_LEATHER_BAG"]);
ensureRecipe("R_T3_RING_OF_GLARE","R Nor Ring of Glare",3,"T3_RING_OF_GLARE",["T2_GOLDEN_RING","T2_WOODEN_CHEST","T2_STONE_PILLAR","T2_CRYSTAL_ORB"]);
ensureRecipe("R_T3_CHEST_OF_SECRETS","R Nor Chest of Secrets",3,"T3_CHEST_OF_SECRETS",["T2_WOODEN_CHEST","T2_STONE_PILLAR","T2_LEATHER_BAG","T2_CLOTH_TENT"]);
ensureRecipe("R_T3_PILLAR_OF_STRENGTH","R Nor Pillar of Strength",3,"T3_PILLAR_OF_STRENGTH",["T2_STONE_PILLAR","T2_LEATHER_BAG","T2_CLOTH_TENT"]);
ensureRecipe("R_T3_TRAVELERS_BAG","R Nor Traveler's Bag",3,"T3_TRAVELERS_BAG",["T2_LEATHER_BAG","T2_CLOTH_TENT","T2_CRYSTAL_ORB"]);
ensureRecipe("R_T3_NOMAD_TENT","R Nor Nomad Tent",3,"T3_NOMAD_TENT",["T2_CLOTH_TENT","T2_CRYSTAL_ORB","T2_IRON_ARMOR"]);
ensureRecipe("R_T3_ORB_OF_VISION","R Nor Orb of Vision",3,"T3_ORB_OF_VISION",["T2_CRYSTAL_ORB","T2_OBSIDIAN_KNIFE","T2_BRONZE_DOOR"]);
ensureRecipe("R_T3_KNIFE_OF_SHADOW","R Nor Knife of Shadow",3,"T3_KNIFE_OF_SHADOW",["T2_OBSIDIAN_KNIFE","T2_IRON_ARMOR","T2_WOODEN_CHEST"]);
ensureRecipe("R_T3_ARMOR_OF_GUARD","R Nor Armor of Guard",3,"T3_ARMOR_OF_GUARD",["T2_IRON_ARMOR","T2_SILVER_GOBLET","T2_GOLDEN_RING"]);

// ===== Recepti T4
ensureRecipe("R_T4_ENGINE_CORE","R Nor Engine Core",4,"T4_ENGINE_CORE",["T3_GATE_OF_MIGHT","T3_KNIFE_OF_SHADOW","T3_ARMOR_OF_GUARD"]);
ensureRecipe("R_T4_CRYSTAL_LENS","R Nor Crystal Lens",4,"T4_CRYSTAL_LENS",["T3_ORB_OF_VISION","T3_RING_OF_GLARE","T3_GOBLET_OF_WISDOM"]);
ensureRecipe("R_T4_MIGHT_GATE","R Nor Reinforced Gate",4,"T4_MIGHT_GATE",["T3_GATE_OF_MIGHT","T3_CHEST_OF_SECRETS","T3_ARMOR_OF_GUARD"]);
ensureRecipe("R_T4_WISDOM_GOBLET","R Nor Enruned Goblet",4,"T4_WISDOM_GOBLET",["T3_GOBLET_OF_WISDOM","T3_RING_OF_GLARE","T3_PILLAR_OF_STRENGTH"]);
ensureRecipe("R_T4_SECRET_CHEST","R Nor Sealed Chest",4,"T4_SECRET_CHEST",["T3_CHEST_OF_SECRETS","T3_PILLAR_OF_STRENGTH","T3_TRAVELERS_BAG"]);
ensureRecipe("R_T4_STRENGTH_PILLAR","R Nor Monument Pillar",4,"T4_STRENGTH_PILLAR",["T3_PILLAR_OF_STRENGTH","T3_TRAVELERS_BAG","T3_NOMAD_TENT"]);
ensureRecipe("R_T4_TRAVELER_SATCHEL","R Nor Traveler Satchel",4,"T4_TRAVELER_SATCHEL",["T3_TRAVELERS_BAG","T3_NOMAD_TENT","T3_ORB_OF_VISION"]);
ensureRecipe("R_T4_NOMAD_DWELLING","R Nor Nomad Dwelling",4,"T4_NOMAD_DWELLING",["T3_NOMAD_TENT","T3_ORB_OF_VISION","T3_KNIFE_OF_SHADOW"]);
ensureRecipe("R_T4_VISION_CORE","R Nor Vision Core",4,"T4_VISION_CORE",["T3_ORB_OF_VISION","T3_KNIFE_OF_SHADOW","T3_GATE_OF_MIGHT"]);
ensureRecipe("R_T4_SHADOW_BLADE","R Nor Shadow Blade",4,"T4_SHADOW_BLADE",["T3_KNIFE_OF_SHADOW","T3_CHEST_OF_SECRETS","T3_ARMOR_OF_GUARD"]);

// ===== Recepti T5
ensureRecipe("R_T5_ANCIENT_RELIC","R Nor Ancient Relic",5,"T5_ANCIENT_RELIC",["T4_ENGINE_CORE","T4_CRYSTAL_LENS","T4_WISDOM_GOBLET"]);
ensureRecipe("R_T5_SUN_LENS","R Nor Sun Lens",5,"T5_SUN_LENS",["T4_CRYSTAL_LENS","T4_VISION_CORE","T4_MIGHT_GATE"]);
ensureRecipe("R_T5_GUARDIAN_GATE","R Nor Guardian Gate",5,"T5_GUARDIAN_GATE",["T4_MIGHT_GATE","T4_ENGINE_CORE","T4_TRAVELER_SATCHEL"]);
ensureRecipe("R_T5_WISDOM_CHALICE","R Nor Wisdom Chalice",5,"T5_WISDOM_CHALICE",["T4_WISDOM_GOBLET","T4_CRYSTAL_LENS","T4_STRENGTH_PILLAR"]);
ensureRecipe("R_T5_VAULT","R Nor Royal Vault",5,"T5_VAULT",["T4_SECRET_CHEST","T4_STRENGTH_PILLAR","T4_TRAVELER_SATCHEL"]);
ensureRecipe("R_T5_COLOSSAL_PILLAR","R Nor Colossal Pillar",5,"T5_COLOSSAL_PILLAR",["T4_STRENGTH_PILLAR","T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING"]);
ensureRecipe("R_T5_WAYFARER_BAG","R Nor Wayfarer Bag",5,"T5_WAYFARER_BAG",["T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING","T4_VISION_CORE"]);
ensureRecipe("R_T5_NOMAD_HALL","R Nor Nomad Hall",5,"T5_NOMAD_HALL",["T4_NOMAD_DWELLING","T4_VISION_CORE","T4_MIGHT_GATE"]);
ensureRecipe("R_T5_EYE_OF_TRUTH","R Nor Eye of Truth",5,"T5_EYE_OF_TRUTH",["T4_VISION_CORE","T4_ENGINE_CORE","T4_WISDOM_GOBLET"]);
ensureRecipe("R_T5_NIGHTFALL_EDGE","R Nor Nightfall Edge",5,"T5_NIGHTFALL_EDGE",["T4_SHADOW_BLADE","T4_MIGHT_GATE","T4_SECRET_CHEST"]);


// =============== AUTH (LOGIN)
app.post("/api/login", async (req,res)=>{
  try {
    const {email,password} = req.body||{};
    const u = db.prepare("SELECT * FROM users WHERE email=?")
                 .get((email||"").toLowerCase());
    if (!u) return res.status(404).json({ok:false,error:"User not found"});
    if (u.is_disabled) return res.status(403).json({ok:false,error:"Account disabled"});

    const ok = await bcrypt.compare(password||"", u.pass_hash);
    if (!ok) return res.status(401).json({ok:false,error:"Wrong password"});

    const token  = signToken(u);
    const isProd = process.env.NODE_ENV === "production";

    res.cookie(TOKEN_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,     // true na Renderu (HTTPS)
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), u.id);

    return res.json({ok:true, user:{id:u.id,email:u.email}});
  } catch(e) {
    console.error("Login error:", e);
    return res.status(500).json({ok:false,error:"Login failed"});
  }
});
// ======== SESSION (LOGOUT)
app.get("/api/logout", (req, res) => {
  const tok = readToken(req);
  if (tok) {
    db.prepare("UPDATE users SET last_seen=? WHERE id=?")
      .run(nowISO(), tok.uid);
  }
  res.clearCookie(TOKEN_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: (process.env.NODE_ENV==="production"||process.env.RENDER==="true"),
    path: "/"
  });
  return res.json({ ok:true });
});

// ======== SESSION (ME)
app.get("/api/me", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false });

  const u = db.prepare(`
    SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at
    FROM users WHERE id=?
  `).get(tok.uid);

  if (!u) {
    res.clearCookie(TOKEN_NAME, {
      httpOnly: true,
      sameSite: "lax",
      secure: (process.env.NODE_ENV==="production"||process.env.RENDER==="true"),
      path: "/"
    });
    return res.status(401).json({ ok:false });
  }

  const buysToNext = (u.next_recipe_at==null)
    ? null
    : Math.max(0, (u.next_recipe_at || 0) - (u.shop_buy_count || 0));

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
      buys_to_next: buysToNext
    }
  });
});

  
// =============== ADMIN minimal (UI admin.html oslanja se na ove rute)

// ping
app.get("/api/admin/ping",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"}); // [ADMIN: GUARD]
  res.json({ok:true});
});

// lista korisnika
app.get("/api/admin/users",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"}); // [ADMIN: GUARD]
  const rows = db.prepare(`
    SELECT id,email,is_admin,is_disabled,balance_silver,
           created_at,last_seen,shop_buy_count,next_recipe_at
    FROM users
  `).all();
  const users = rows.map(u=>({
    id:u.id,
    email:u.email,
    is_admin:!!u.is_admin,                   // [ADMIN: USERS FIELD]
    is_disabled:!!u.is_disabled,             // [ADMIN: USERS FIELD]
    gold:Math.floor(u.balance_silver/100),
    silver:u.balance_silver%100,
    created_at:u.created_at,
    last_seen:u.last_seen,
    shop_buy_count:u.shop_buy_count,
    next_recipe_at:u.next_recipe_at
  }));
  res.json({ok:true,users});
});

// balans + ledger
app.post("/api/admin/adjust-balance",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"}); // [ADMIN: GUARD]
  const {email,gold=0,silver=0,delta_silver} = req.body||{};
  if (!isEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u = db.prepare("SELECT id,balance_silver FROM users WHERE lower(email)=lower(?)").get(email);
  if (!u) return res.status(404).json({ok:false,error:"User not found"});

  let deltaS = (typeof delta_silver==="number")
    ? Math.trunc(delta_silver)
    : (Math.trunc(gold)*100 + Math.trunc(silver));

  if (!Number.isFinite(deltaS) || deltaS===0)
    return res.status(400).json({ok:false,error:"No change"});

  const tx = db.transaction(()=>{
  const after = u.balance_silver + deltaS;
  if (after < 0) throw new Error("Insufficient");

  db.prepare("UPDATE users SET balance_silver=? WHERE id=?")
    .run(after, u.id);

  db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
    .run(u.id, deltaS, "ADMIN_ADJUST", String(email), nowISO()); // [ADMIN: LEDGER WRITE]
});

  try{ tx(); }catch(e){ return res.status(400).json({ok:false,error:String(e.message||e)}); }

  const bal = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
  res.json({ok:true,balance_silver:bal});
});

// inventar korisnika
app.get("/api/admin/user/:id/inventory",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"}); // [ADMIN: GUARD]
  const uid = parseInt(req.params.id,10);
  const items = db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ui.qty
    FROM user_items ui
    JOIN items i ON i.id=ui.item_id
    WHERE ui.user_id=? AND ui.qty>0
    ORDER BY i.tier,i.name
  `).all(uid);
  const recipes = db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty
    FROM user_recipes ur
    JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0
    ORDER BY r.tier,r.name
  `).all(uid);
  res.json({ok:true,items,recipes});
});

// enable/disable
app.post("/api/admin/disable-user",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"}); // [ADMIN: GUARD]
  const { email, disabled } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email);
  if (!u) return res.status(404).json({ok:false,error:"User not found"});
  db.prepare("UPDATE users SET is_disabled=? WHERE id=?").run(disabled ? 1 : 0, u.id); // [ADMIN: USERS FLAG WRITE]
  res.json({ ok:true });
});

// =============== SHOP (T1 only) ===============
const SHOP_T1_COST_S = 100;
const RECIPE_DROP_MIN = 4;
const RECIPE_DROP_MAX = 8;

function nextRecipeInterval(){
  const min = RECIPE_DROP_MIN, max = RECIPE_DROP_MAX;
  return Math.floor(Math.random()*(max-min+1))+min;
}
function pickWeightedRecipe(){
  const list = db.prepare(`SELECT id, code, name, tier FROM recipes WHERE tier BETWEEN 2 AND 5`).all();
  if (!list.length) return null;
  const byTier = {};
  for (const r of list){ (byTier[r.tier] ||= []).push(r); }
  const roll = Math.floor(Math.random()*1000)+1; // 1..1000
  let tier = (roll <= 13 ? 5 : roll <= 50 ? 4 : roll <= 200 ? 3 : 2);
  while (tier >= 2 && !byTier[tier]) tier--;
  const arr = byTier[tier] || byTier[2];
  return arr[Math.floor(Math.random()*arr.length)];
}

app.post("/api/shop/buy-t1",(req,res)=>{
  const uTok = verifyTokenFromCookies(req);
  if(!uTok) return res.status(401).json({ok:false,error:"Not logged in."});

  try{
    const result = db.transaction(()=>{
      const user = db.prepare("SELECT id,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(uTok.uid);
      if(!user) throw new Error("Session expired.");
      const cost = SHOP_T1_COST_S;
      if(user.balance_silver < cost) throw new Error("Insufficient funds.");

      // naplata
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(cost,user.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(user.id,-cost,"SHOP_BUY_T1",null,nowISO());

      // init target droppa
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
        const pick = pickWeightedRecipe();
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
        // T1 random materijal
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

// =============== RECIPES & CRAFTING (SERVER) ===============

// List owned recipes (+qty)
app.get("/api/recipes/list", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok: false, error: "Not logged in." });
  try {
    const rows = db.prepare(`
      SELECT r.id, r.code, r.name, r.tier, ur.qty
      FROM user_recipes ur
      JOIN recipes r ON r.id = ur.recipe_id
      WHERE ur.user_id = ? AND ur.qty > 0
      ORDER BY r.tier ASC, r.name ASC
    `).all(tok.uid);
    res.json({ ok: true, recipes: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Recipe ingredients + "have" counts
app.get("/api/recipes/ingredients/:id", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok: false, error: "Not logged in." });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: "Bad id" });
  try {
    const recipe = db.prepare(`SELECT id, code, name, tier, output_item_id FROM recipes WHERE id=?`).get(id);
    if (!recipe) return res.status(404).json({ ok: false, error: "Recipe not found" });

    const ingredients = db.prepare(`
      SELECT ri.item_id, ri.qty, i.name, i.tier,
             COALESCE(ui.qty,0) AS have
      FROM recipe_ingredients ri
      JOIN items i ON i.id = ri.item_id
      LEFT JOIN user_items ui ON ui.item_id = ri.item_id AND ui.user_id = ?
      WHERE ri.recipe_id = ?
      ORDER BY i.tier, i.name
    `).all(tok.uid, id);

    res.json({ ok: true, recipe, ingredients });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Artefact bonus (public GET)
app.get("/api/items/artefact/bonus", (_req, res) => {
  try {
    const row = db.prepare(`SELECT bonus_gold FROM items WHERE code='ARTEFACT'`).get();
    return res.json({ ok: true, bonus_gold: (row?.bonus_gold | 0) });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// Craft – materijali se UVIJEK troše; recept se troši SAMO kod uspjeha (10% fail -> Scrap)


app.post("/api/craft/do", (req, res) => {
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ ok:false, error: "Not logged in." });

  const { recipe_id } = req.body || {};
  const rid = parseInt(recipe_id, 10);
  if (!rid) return res.status(400).json({ ok:false, error: "Missing recipe_id" });

  try{
    const result = db.transaction(() => {
      const r = db.prepare(`
        SELECT id, name, tier, output_item_id
        FROM recipes WHERE id=?`).get(rid);
      if (!r) throw new Error("Recipe not found.");

      // user must own the recipe (qty>0)
      const haveRec = db.prepare(`
        SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?`).get(tok.uid, r.id);
      if (!haveRec || haveRec.qty <= 0) throw new Error("You don't own this recipe.");

      // ingredients check
      const need = db.prepare(`
        SELECT ri.item_id, ri.qty, i.name
        FROM recipe_ingredients ri
        JOIN items i ON i.id = ri.item_id
        WHERE ri.recipe_id = ?`).all(r.id);

      let missing = [];
      for (const n of need) {
        const inv = db.prepare(`
          SELECT qty FROM user_items WHERE user_id=? AND item_id=?`).get(tok.uid, n.item_id);
        if (!inv || inv.qty < n.qty) {
          missing.push(n.name);
        }
      }
      if (missing.length > 0) {
        throw { code: "MISSING_MATS", missing };
      }

      // consume materials ALWAYS
      for (const n of need) {
        db.prepare(`UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?`).run(n.qty, tok.uid, n.item_id);
      }

      const fail = Math.random() < 0.10; // 10% fail

      if (!fail) {
        // SUCCESS → add output + CONSUME ONE RECIPE
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(tok.uid, r.output_item_id);

        db.prepare(`
          UPDATE user_recipes SET qty=qty-1
          WHERE user_id=? AND recipe_id=?`).run(tok.uid, r.id);

        const out = db.prepare(`SELECT code, name, tier FROM items WHERE id=?`).get(r.output_item_id);
        return { result: "success", crafted: out };
      } else {
        // FAIL → add SCRAP, recipe stays
        const scrap = db.prepare(`SELECT id FROM items WHERE code='SCRAP'`).get();
        if (scrap) {
          db.prepare(`
            INSERT INTO user_items(user_id,item_id,qty)
            VALUES (?,?,1)
            ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
          `).run(tok.uid, scrap.id);
        }
        return { result: "fail", scrap: true };
      }
    })();

    res.json({ ok:true, ...result });
  } catch(e){
    if (e && e.code === "MISSING_MATS") {
      return res.status(400).json({ ok:false, error: "Not all required materials are available.", missing: e.missing });
    }
    res.status(400).json({ ok:false, error: String(e.message || e) });
  }
});


// ARTEFACT: vraća i artefactBonusGold u /api/inventory
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

  // bonus gold za artefact
  const art = db.prepare(`SELECT bonus_gold FROM items WHERE code='ARTEFACT'`).get();
  const artefactBonusGold = (art?.bonus_gold | 0);

  res.json({ok:true, items, recipes, artefactBonusGold});
});


// ================= SALES (Marketplace) =================
function mapListing(a) {
  return {
    id: a.id,
    kind: a.type,                // 'item' | 'recipe'
    item_id: a.item_id,
    recipe_id: a.recipe_id,
    qty: a.qty,
    price_s: a.buy_now_price_s,  // cijena u silveru (buy-now)
    seller_user_id: a.seller_user_id,
    status: a.status,
    start_time: a.start_time,
    end_time: a.end_time,
    name: a.name ?? null,
    tier: a.tier ?? null
  };
}

// LIVE MARKETPLACE (s opcionalnim search by name)
// GET /api/sales/live?q=ring
app.get("/api/sales/live", (req, res) => {
  try {
    const q = (req.query && String(req.query.q || "").trim().toLowerCase()) || "";

    // Live aukcije + pridruženo ime/tier
    const rows = db.prepare(`
      SELECT a.*,
             COALESCE(i.name, r.name)  AS name,
             COALESCE(i.tier, r.tier)  AS tier
      FROM auctions a
      LEFT JOIN items   i ON a.type='item'   AND i.id=a.item_id
      LEFT JOIN recipes r ON a.type='recipe' AND r.id=a.recipe_id
      WHERE a.status='live'
      ORDER BY a.id DESC
      LIMIT 500
    `).all();

    let result = rows;
    if (q) result = rows.filter(a => (a.name || "").toLowerCase().includes(q));

    res.json({ ok: true, listings: result.map(mapListing) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// MOJI LISTINZI
// GET /api/sales/mine
app.get("/api/sales/mine", (req, res) => {
  try {
    const uid = requireAuth(req);
    const rows = db.prepare(`
      SELECT a.*,
             COALESCE(i.name, r.name)  AS name,
             COALESCE(i.tier, r.tier)  AS tier
      FROM auctions a
      LEFT JOIN items   i ON a.type='item'   AND i.id=a.item_id
      LEFT JOIN recipes r ON a.type='recipe' AND r.id=a.recipe_id
      WHERE a.seller_user_id=? AND a.status IN ('live','paid','canceled')
      ORDER BY a.id DESC
      LIMIT 500
    `).all(uid);

    res.json({ ok: true, listings: rows.map(mapListing) });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e.message || e) });
  }
});

// CREATE LISTING (fixed price / buy-now)
// body: { kind: 'item'|'recipe', id: number, qty: number, gold: number, silver: number }
app.post("/api/sales/list", (req, res) => {
  try {
    const uid = requireAuth(req);
    const { kind, id, qty, gold = 0, silver = 0 } = req.body || {};

    if (!(kind === "item" || kind === "recipe")) throw new Error("Bad kind.");
    const targetId = parseInt(id, 10);
    if (!targetId) throw new Error("Bad id.");

    const q = Math.max(1, parseInt(qty, 10) || 1);
    const price =
      (Math.max(0, parseInt(gold, 10) || 0) * 100) +
      (Math.max(0, parseInt(silver, 10) || 0) % 100);
    if (price <= 0) throw new Error("Price must be > 0.");

    // listing fee = GOLD dio cijene, u silveru (npr. 8g => 8s)
    const listingFeeS = Math.floor(price / 100); // gold component as silver

    const out = db.transaction(() => {
      // 1) provjera i naplata listing fee-a
      if (listingFeeS > 0) {
        const bal = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(uid);
        if (!bal || bal.balance_silver < listingFeeS) throw new Error("Insufficient funds for listing fee.");
        db.prepare(`UPDATE users SET balance_silver=balance_silver-? WHERE id=?`).run(listingFeeS, uid);
        db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
          .run(uid, -listingFeeS, "SALE_LIST_FEE", null, nowISO());
      }

      // 2) skini iz inventara u escrow
      if (kind === "item") {
        const row = db.prepare(`SELECT COALESCE(qty,0) qty FROM user_items WHERE user_id=? AND item_id=?`)
          .get(uid, targetId);
        if (!row || row.qty < q) throw new Error("Not enough items.");
        db.prepare(`UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?`).run(q, uid, targetId);
      } else {
        const row = db.prepare(`SELECT COALESCE(qty,0) qty FROM user_recipes WHERE user_id=? AND recipe_id=?`)
          .get(uid, targetId);
        if (!row || row.qty < q) throw new Error("Not enough recipes.");
        db.prepare(`UPDATE user_recipes SET qty=qty-? WHERE user_id=? AND recipe_id=?`).run(q, uid, targetId);
      }

      // 3) kreiraj aukciju (fixed/buy-now)
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
        q,
        price,
        price,
        nowISO(),
        addMinutes(nowISO(), 7 * 24 * 60) // 7 days
      );

      // 4) escrow zapis
      db.prepare(`
        INSERT INTO inventory_escrow(auction_id,owner_user_id,type,item_id,recipe_id,qty,created_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(
        ins.lastInsertRowid,
        uid,
        kind,
        kind === "item" ? targetId : null,
        kind === "recipe" ? targetId : null,
        q,
        nowISO()
      );

      return { id: ins.lastInsertRowid, status: "live", price_s: price, qty: q, listing_fee_s: listingFeeS };
    })();

    res.json({ ok: true, listing: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});


// Cancel listing
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

      // vrati u inventory
      addInv(uid, esc.item_id, esc.recipe_id, esc.qty);

      db.prepare(`UPDATE auctions SET status='canceled' WHERE id=?`).run(id);
      db.prepare(`DELETE FROM inventory_escrow WHERE auction_id=?`).run(id);

      return { id, status: "canceled" };
    })();

    res.json({ ok: true, listing: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// Buy-now
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

      // fee 1%
      const fee = Math.floor((a.fee_bps || 100) * price / 10000);
      const net = price - fee;

      // skini kupcu
      db.prepare(`UPDATE users SET balance_silver=balance_silver-? WHERE id=?`).run(price, buyerId);
      db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
        .run(buyerId, -price, "SALE_BUY", String(id), nowISO());

      // uplati prodavaču
      db.prepare(`UPDATE users SET balance_silver=balance_silver+? WHERE id=?`).run(net, a.seller_user_id);
      db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
        .run(a.seller_user_id, net, "SALE_EARN", String(id), nowISO());

      // prebacivanje robe
      addInv(buyerId, esc.item_id, esc.recipe_id, esc.qty);

      db.prepare(`
        UPDATE auctions
        SET status='paid', winner_user_id=?, sold_price_s=?, end_time=?, highest_bid_s=?, highest_bidder_user_id=?
        WHERE id=?
      `).run(buyerId, price, nowISO(), price, buyerId, id);

      db.prepare(`DELETE FROM inventory_escrow WHERE auction_id=?`).run(id);

      return { id, paid_s: price };
    })();

    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/sales/ping", (_req,res)=>res.json({ok:true}));


// ============================== HEALTH ==============================
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: nowISO() });
});

// =============== START ===============
server.listen(PORT, HOST, () => {
  console.log(`ARTEFACT server listening on http://${HOST}:${PORT}`);
});
        //---end






























