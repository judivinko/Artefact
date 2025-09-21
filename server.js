// Config & imports — ispod: dependency-ji, env varijable, putanje
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";
const TOKEN_NAME = "token";
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || "judi.vinko81@gmail.com").toLowerCase();

const DB_FILE = process.env.DB_PATH || path.join(__dirname, "data", "artefact.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// App setup — ispod: Express app, server, middleware
const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
app.use(express.json());
app.use(cookieParser());

// Static files & HTML routes — ispod: /public, / i /admin (admin.html se ne dira)
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html"))); // admin.html se ne dira

// SPA fallback — ispod: sve ne-API GET rute vraćaju index.html
app.get(/^\/(?!api\/).*/, (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// Database init — ispod: otvaranje SQLite i WAL
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

// DB migrations (sales/escrow) — ispod: kreiranje/alter sales, auctions, inventory_escrow
function tableExists(name) {
  try { return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name); }
  catch { return false; }
}
function hasColumn(table, col) {
  try { return !!db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === col); }
  catch { return false; }
}
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
        price_s INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'live',
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
})();

// Helper utils — ispod: vrijeme, validacije, JWT, readToken/isAdmin, addInv
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

// Admin: set bonus gold — ispod: POST /api/admin/set-bonus-gold
app.post("/api/admin/set-bonus-gold", (req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const { code="ARTEFACT", bonus_gold=0 } = req.body || {};
  const g = Math.max(0, parseInt(bonus_gold,10) || 0);
  const row = db.prepare(`SELECT id FROM items WHERE code=?`).get(String(code));
  if (!row) return res.status(404).json({ok:false,error:"Item not found"});
  db.prepare(`UPDATE items SET bonus_gold=? WHERE code=?`).run(g, String(code));
  return res.json({ ok:true, bonus_gold:g });
});

// Base schema — ispod: users, gold_ledger, items, user_items, recipes, recipe_ingredients, user_recipes
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

// One-off migration — ispod: prefiks 'R ' za recepte koji ga nemaju
try {
  db.prepare(`
    UPDATE recipes
    SET name = 'R ' || name
    WHERE name NOT LIKE 'R %'
  `).run();
} catch {}

// Seed helpers — ispod: ensureItem, idByCode, ensureRecipe
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

// Icon mapping for items — ispod: mapa code→filename→/images path
const G = (typeof window !== "undefined") ? window : global;
const ICONS = {
  itemsBase: "/images",
  recipeIcon: "/images/recipe.png",
  defaultItem: "/images/t1_bronze.png"
};
function fileNameForItem(code, tier){
  if (tier === 1 && !/^T1_/.test(code)) {
    return `t1_${String(code||"").toLowerCase()}.png`;
  }
  const m = String(code||"").match(/^T([2-6])_(.*)$/);
  if (m) {
    const t = m[1];
    const rest = (m[2]||"").toLowerCase();
    return `t${t}_${rest}.png`;
  }
  return ICONS.defaultItem.split("/").pop();
}
function iconPathForItem(code, tier){
  return `${ICONS.itemsBase}/${fileNameForItem(code, tier)}`;
}
function ensureItemIcon(code, name, tier, base, iconPath){
  if (!G.ITEMS) G.ITEMS = {};
  G.ITEMS[code] = { code, name, tier, base, icon: iconPath || iconPathForItem(code, tier) || ICONS.defaultItem };
}
function ensureRecipeIcon(code, name, tier, result, parts){
  if (!G.RECIPES) G.RECIPES = {};
  G.RECIPES[code] = { code, name, tier, result, parts, icon: ICONS.recipeIcon };
}

// ---------- ITEMS ----------

// SCRAP
ensureItem("SCRAP","Scrap",1,1);

// T1 materials (10)
const T1 = [
  ["BRONZE","Bronze"],
  ["IRON","Iron"],
  ["SILVER","Silver"],
  ["GOLD","Gold"],
  ["WOOD","Wood"],
  ["STONE","Stone"],
  ["LEATHER","Leather"],
  ["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],
  ["OBSIDIAN","Obsidian"]
];
for (const [c,n] of T1) ensureItem(c,n,1,0);

// T2 items (10)
const T2_ITEMS = [
  ["T2_BRONZE_DOOR","Bronze Door"],
  ["T2_SILVER_GOBLET","Silver Goblet"],
  ["T2_GOLDEN_RING","Golden Ring"],
  ["T2_WOODEN_CHEST","Wooden Chest"],
  ["T2_STONE_PILLAR","Stone Pillar"],
  ["T2_LEATHER_BAG","Leather Bag"],
  ["T2_CLOTH_TENT","Cloth Tent"],
  ["T2_CRYSTAL_ORB","Crystal Orb"],
  ["T2_OBSIDIAN_KNIFE","Obsidian Knife"],
  ["T2_IRON_ARMOR","Iron Armor"]
];
for (const [code,name] of T2_ITEMS) ensureItem(code,name,2,0);

// T3 items (10)
const T3_ITEMS = [
  ["T3_GATE_OF_MIGHT","Gate of Might"],
  ["T3_GOBLET_OF_WISDOM","Goblet of Wisdom"],
  ["T3_RING_OF_GLARE","Ring of Glare"],
  ["T3_CHEST_OF_SECRETS","Chest of Secrets"],
  ["T3_PILLAR_OF_STRENGTH","Pillar of Strength"],
  ["T3_TRAVELERS_BAG","Traveler's Bag"],
  ["T3_NOMAD_TENT","Nomad Tent"],
  ["T3_ORB_OF_VISION","Orb of Vision"],
  ["T3_KNIFE_OF_SHADOW","Knife of Shadow"],
  ["T3_ARMOR_OF_GUARD","Armor of Guard"]
];
for (const [code,name] of T3_ITEMS) ensureItem(code,name,3,0);

// T4 items (10)
const T4_ITEMS = [
  ["T4_ENGINE_CORE","Engine Core"],
  ["T4_CRYSTAL_LENS","Crystal Lens"],
  ["T4_MIGHT_GATE","Reinforced Gate"],
  ["T4_WISDOM_GOBLET","Enruned Goblet"],
  ["T4_SECRET_CHEST","Sealed Chest"],
  ["T4_STRENGTH_PILLAR","Monument Pillar"],
  ["T4_TRAVELER_SATCHEL","Traveler Satchel"],
  ["T4_NOMAD_DWELLING","Nomad Dwelling"],
  ["T4_VISION_CORE","Vision Core"],
  ["T4_SHADOW_BLADE","Shadow Blade"]
];
for (const [code,name] of T4_ITEMS) ensureItem(code,name,4,0);

// T5 items (10)
const T5_ITEMS = [
  ["T5_ANCIENT_RELIC","Ancient Relic"],
  ["T5_SUN_LENS","Sun Lens"],
  ["T5_GUARDIAN_GATE","Guardian Gate"],
  ["T5_WISDOM_CHALICE","Wisdom Chalice"],
  ["T5_VAULT","Royal Vault"],
  ["T5_COLOSSAL_PILLAR","Colossal Pillar"],
  ["T5_WAYFARER_BAG","Wayfarer Bag"],
  ["T5_NOMAD_HALL","Nomad Hall"],
  ["T5_EYE_OF_TRUTH","Eye of Truth"],
  ["T5_NIGHTFALL_EDGE","Nightfall Edge"]
];
for (const [code,name] of T5_ITEMS) ensureItem(code,name,5,0);

// ---------- RECIPES (sve sa zajedničkom /images/recipe.png) ----------

// T2 recipes
const R_T2 = [
  ["R_T2_BRONZE_DOOR","R Bronze Door",2,"T2_BRONZE_DOOR",["BRONZE","IRON","WOOD","STONE"]],
  ["R_T2_SILVER_GOBLET","R Silver Goblet",2,"T2_SILVER_GOBLET",["SILVER","GOLD","CRYSTAL","CLOTH"]],
  ["R_T2_GOLDEN_RING","R Golden Ring",2,"T2_GOLDEN_RING",["GOLD","SILVER","CRYSTAL","LEATHER"]],
  ["R_T2_WOODEN_CHEST","R Wooden Chest",2,"T2_WOODEN_CHEST",["WOOD","STONE","LEATHER","IRON","CLOTH"]],
  ["R_T2_STONE_PILLAR","R Stone Pillar",2,"T2_STONE_PILLAR",["STONE","WOOD","IRON","CLOTH"]],
  ["R_T2_LEATHER_BAG","R Leather Bag",2,"T2_LEATHER_BAG",["LEATHER","CLOTH","WOOD","SILVER"]],
  ["R_T2_CLOTH_TENT","R Cloth Tent",2,"T2_CLOTH_TENT",["CLOTH","LEATHER","WOOD","STONE","IRON"]],
  ["R_T2_CRYSTAL_ORB","R Crystal Orb",2,"T2_CRYSTAL_ORB",["CRYSTAL","GOLD","CLOTH","WOOD","LEATHER"]],
  ["R_T2_OBSIDIAN_KNIFE","R Obsidian Knife",2,"T2_OBSIDIAN_KNIFE",["OBSIDIAN","CRYSTAL","IRON","BRONZE"]],
  ["R_T2_IRON_ARMOR","R Iron Armor",2,"T2_IRON_ARMOR",["IRON","BRONZE","LEATHER","CLOTH","STONE"]]
];
for (const [code,name,tier,result,parts] of R_T2) ensureRecipe(code,name,tier,result,parts);

// T3 recipes
const R_T3 = [
  ["R_T3_GATE_OF_MIGHT","R Gate of Might",3,"T3_GATE_OF_MIGHT",["T2_BRONZE_DOOR","T2_SILVER_GOBLET","T2_GOLDEN_RING","T2_WOODEN_CHEST"]],
  ["R_T3_GOBLET_OF_WISDOM","R Goblet of Wisdom",3,"T3_GOBLET_OF_WISDOM",["T2_SILVER_GOBLET","T2_GOLDEN_RING","T2_STONE_PILLAR","T2_LEATHER_BAG"]],
  ["R_T3_RING_OF_GLARE","R Ring of Glare",3,"T3_RING_OF_GLARE",["T2_GOLDEN_RING","T2_WOODEN_CHEST","T2_STONE_PILLAR","T2_CRYSTAL_ORB"]],
  ["R_T3_CHEST_OF_SECRETS","R Chest of Secrets",3,"T3_CHEST_OF_SECRETS",["T2_WOODEN_CHEST","T2_STONE_PILLAR","T2_LEATHER_BAG","T2_CLOTH_TENT"]],
  ["R_T3_PILLAR_OF_STRENGTH","R Pillar of Strength",3,"T3_PILLAR_OF_STRENGTH",["T2_STONE_PILLAR","T2_LEATHER_BAG","T2_CLOTH_TENT"]],
  ["R_T3_TRAVELERS_BAG","R Traveler's Bag",3,"T3_TRAVELERS_BAG",["T2_LEATHER_BAG","T2_CLOTH_TENT","T2_CRYSTAL_ORB"]],
  ["R_T3_NOMAD_TENT","R Nomad Tent",3,"T3_NOMAD_TENT",["T2_CLOTH_TENT","T2_CRYSTAL_ORB","T2_IRON_ARMOR"]],
  ["R_T3_ORB_OF_VISION","R Orb of Vision",3,"T3_ORB_OF_VISION",["T2_CRYSTAL_ORB","T2_OBSIDIAN_KNIFE","T2_BRONZE_DOOR"]],
  ["R_T3_KNIFE_OF_SHADOW","R Knife of Shadow",3,"T3_KNIFE_OF_SHADOW",["T2_OBSIDIAN_KNIFE","T2_IRON_ARMOR","T2_WOODEN_CHEST"]],
  ["R_T3_ARMOR_OF_GUARD","R Armor of Guard",3,"T3_ARMOR_OF_GUARD",["T2_IRON_ARMOR","T2_SILVER_GOBLET","T2_GOLDEN_RING"]]
];
for (const [code,name,tier,result,parts] of R_T3) ensureRecipe(code,name,tier,result,parts);

// T4 recipes
const R_T4 = [
  ["R_T4_ENGINE_CORE","R Engine Core",4,"T4_ENGINE_CORE",["T3_GATE_OF_MIGHT","T3_KNIFE_OF_SHADOW","T3_ARMOR_OF_GUARD"]],
  ["R_T4_CRYSTAL_LENS","R Crystal Lens",4,"T4_CRYSTAL_LENS",["T3_ORB_OF_VISION","T3_RING_OF_GLARE","T3_GOBLET_OF_WISDOM"]],
  ["R_T4_MIGHT_GATE","R Reinforced Gate",4,"T4_MIGHT_GATE",["T3_GATE_OF_MIGHT","T3_CHEST_OF_SECRETS","T3_ARMOR_OF_GUARD"]],
  ["R_T4_WISDOM_GOBLET","R Enruned Goblet",4,"T4_WISDOM_GOBLET",["T3_GOBLET_OF_WISDOM","T3_RING_OF_GLARE","T3_PILLAR_OF_STRENGTH"]],
  ["R_T4_SECRET_CHEST","R Sealed Chest",4,"T4_SECRET_CHEST",["T3_CHEST_OF_SECRETS","T3_PILLAR_OF_STRENGTH","T3_TRAVELERS_BAG"]],
  ["R_T4_STRENGTH_PILLAR","R Monument Pillar",4,"T4_STRENGTH_PILLAR",["T3_PILLAR_OF_STRENGTH","T3_TRAVELERS_BAG","T3_NOMAD_TENT"]],
  ["R_T4_TRAVELER_SATCHEL","R Traveler Satchel",4,"T4_TRAVELER_SATCHEL",["T3_TRAVELERS_BAG","T3_NOMAD_TENT","T3_ORB_OF_VISION"]],
  ["R_T4_NOMAD_DWELLING","R Nomad Dwelling",4,"T4_NOMAD_DWELLING",["T3_NOMAD_TENT","T3_ORB_OF_VISION","T3_KNIFE_OF_SHADOW"]],
  ["R_T4_VISION_CORE","R Vision Core",4,"T4_VISION_CORE",["T3_ORB_OF_VISION","T3_KNIFE_OF_SHADOW","T3_GATE_OF_MIGHT"]],
  ["R_T4_SHADOW_BLADE","R Shadow Blade",4,"T4_SHADOW_BLADE",["T3_KNIFE_OF_SHADOW","T3_CHEST_OF_SECRETS","T3_ARMOR_OF_GUARD"]]
];
for (const [code,name,tier,result,parts] of R_T4) ensureRecipe(code,name,tier,result,parts);

// T5 recipes
const R_T5 = [
  ["R_T5_ANCIENT_RELIC","R Ancient Relic",5,"T5_ANCIENT_RELIC",["T4_ENGINE_CORE","T4_CRYSTAL_LENS","T4_WISDOM_GOBLET"]],
  ["R_T5_SUN_LENS","R Sun Lens",5,"T5_SUN_LENS",["T4_CRYSTAL_LENS","T4_VISION_CORE","T4_MIGHT_GATE"]],
  ["R_T5_GUARDIAN_GATE","R Guardian Gate",5,"T5_GUARDIAN_GATE",["T4_MIGHT_GATE","T4_ENGINE_CORE","T4_TRAVELER_SATCHEL"]],
  ["R_T5_WISDOM_CHALICE","R Wisdom Chalice",5,"T5_WISDOM_CHALICE",["T4_WISDOM_GOBLET","T4_CRYSTAL_LENS","T4_STRENGTH_PILLAR"]],
  ["R_T5_VAULT","R Royal Vault",5,"T5_VAULT",["T4_SECRET_CHEST","T4_STRENGTH_PILLAR","T4_TRAVELER_SATCHEL"]],
  ["R_T5_COLOSSAL_PILLAR","R Colossal Pillar",5,"T5_COLOSSAL_PILLAR",["T4_STRENGTH_PILLAR","T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING"]],
  ["R_T5_WAYFARER_BAG","R Wayfarer Bag",5,"T5_WAYFARER_BAG",["T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING","T4_VISION_CORE"]],
  ["R_T5_NOMAD_HALL","R Nomad Hall",5,"T5_NOMAD_HALL",["T4_NOMAD_DWELLING","T4_VISION_CORE","T4_MIGHT_GATE"]],
  ["R_T5_EYE_OF_TRUTH","R Eye of Truth",5,"T5_EYE_OF_TRUTH",["T4_VISION_CORE","T4_ENGINE_CORE","T4_WISDOM_GOBLET"]],
  ["R_T5_NIGHTFALL_EDGE","R Nightfall Edge",5,"T5_NIGHTFALL_EDGE",["T4_SHADOW_BLADE","T4_MIGHT_GATE","T4_SECRET_CHEST"]]
];
for (const [code,name,tier,result,parts] of R_T5) ensureRecipe(code,name,tier,result,parts);


// Auth: register — ispod: POST /api/register (kreira usera)
app.post("/api/register", async (req,res)=>{
  try{
    const {email,password} = req.body||{};
    if(!isEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
    if(!isPass(password)) return res.status(400).json({ok:false,error:"Password too short"});
    const e = String(email).toLowerCase();
    const exists = db.prepare("SELECT id FROM users WHERE email=?").get(e);
    if (exists) return res.status(409).json({ok:false,error:"User exists"});
    const hash = await bcrypt.hash(password, 10);
    db.prepare("INSERT INTO users(email,pass_hash,created_at,is_admin) VALUES (?,?,?,?)")
      .run(e, hash, nowISO(), e===DEFAULT_ADMIN_EMAIL?1:0);
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:"Register failed"}); }
});

// Auth: login/logout/me — ispod: POST /api/login, GET /api/logout, GET /api/me
app.post("/api/login", async (req,res)=>{
  try{
    const {email,password} = req.body||{};
    const u = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase());
    if(!u) return res.status(404).json({ok:false,error:"User not found"});
    if(u.is_disabled) return res.status(403).json({ok:false,error:"Account disabled"});
    const ok = await bcrypt.compare(password||"", u.pass_hash);
    if(!ok) return res.status(401).json({ok:false,error:"Wrong password"});
    const token = signToken(u);
    res.cookie(TOKEN_NAME, token, {
      httpOnly:true, sameSite:"lax", secure:(process.env.NODE_ENV==="production"), path:"/", maxAge:7*24*60*60*1000
    });
    db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), u.id);
    res.json({ok:true, user:{id:u.id,email:u.email}});
  }catch(e){ res.status(500).json({ok:false,error:"Login failed"}); }
});

app.get("/api/logout", (req,res)=>{
  const tok = readToken(req);
  if (tok) db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), tok.uid);
  res.clearCookie(TOKEN_NAME,{httpOnly:true,sameSite:"lax",secure:(process.env.NODE_ENV==="production"),path:"/"});
  res.json({ok:true});
});

app.get("/api/me",(req,res)=>{
  const tok = readToken(req);
  if(!tok) return res.status(401).json({ok:false});
  const u = db.prepare(`
    SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at
    FROM users WHERE id=?`).get(tok.uid);
  if(!u){
    res.clearCookie(TOKEN_NAME,{httpOnly:true,sameSite:"lax",secure:(process.env.NODE_ENV==="production"),path:"/"});
    return res.status(401).json({ok:false});
  }
  const buysToNext = (u.next_recipe_at==null) ? null
    : Math.max(0,(u.next_recipe_at||0)-(u.shop_buy_count||0));
  res.json({ok:true,user:{
    id:u.id,email:u.email,is_admin:!!u.is_admin,
    balance_silver:u.balance_silver,
    gold:Math.floor(u.balance_silver/100),
    silver:(u.balance_silver%100),
    shop_buy_count:u.shop_buy_count,
    next_recipe_at:u.next_recipe_at,
    buys_to_next:buysToNext
  }});
});

// Admin: minimal — ispod: ping, users, adjust balance, user inventory, disable user
app.get("/api/admin/ping",(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  res.json({ok:true});
});

app.get("/api/admin/users",(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const rows = db.prepare(`
    SELECT id,email,is_admin,is_disabled,balance_silver,created_at,last_seen,shop_buy_count,next_recipe_at
    FROM users`).all();
  const users = rows.map(u=>({
    id:u.id,email:u.email,is_admin:!!u.is_admin,is_disabled:!!u.is_disabled,
    gold:Math.floor(u.balance_silver/100),silver:(u.balance_silver%100),
    created_at:u.created_at,last_seen:u.last_seen,
    shop_buy_count:u.shop_buy_count,next_recipe_at:u.next_recipe_at
  }));
  res.json({ok:true,users});
});

app.post("/api/admin/adjust-balance",(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email,gold=0,silver=0,delta_silver} = req.body||{};
  if(!isEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u = db.prepare("SELECT id,balance_silver FROM users WHERE lower(email)=lower(?)").get(email);
  if(!u) return res.status(404).json({ok:false,error:"User not found"});
  let deltaS = (typeof delta_silver==="number") ? Math.trunc(delta_silver) : (Math.trunc(gold)*100 + Math.trunc(silver));
  if(!Number.isFinite(deltaS) || deltaS===0) return res.status(400).json({ok:false,error:"No change"});
  try{
    db.transaction(()=>{
      const after = u.balance_silver + deltaS;
      if(after<0) throw new Error("Insufficient");
      db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after,u.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(u.id, deltaS, "ADMIN_ADJUST", String(email), nowISO());
    })();
  }catch(e){ return res.status(400).json({ok:false,error:String(e.message||e)}); }
  const bal = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
  res.json({ok:true,balance_silver:bal});
});

app.get("/api/admin/user/:id/inventory",(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const uid = parseInt(req.params.id,10);
  const items = db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ui.qty
    FROM user_items ui JOIN items i ON i.id=ui.item_id
    WHERE ui.user_id=? AND ui.qty>0 ORDER BY i.tier,i.name`).all(uid);
  const recipes = db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0 ORDER BY r.tier,r.name`).all(uid);
  res.json({ok:true,items,recipes});
});

app.post("/api/admin/disable-user",(req,res)=>{
  if(!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email,disabled} = req.body||{};
  if(!isEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u = db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email);
  if(!u) return res.status(404).json({ok:false,error:"User not found"});
  db.prepare("UPDATE users SET is_disabled=? WHERE id=?").run(disabled?1:0,u.id);
  res.json({ok:true});
});

// Shop: buy T1 — ispod: POST /api/shop/buy-t1 (100s, T1 ili recept po intervalu)
const SHOP_T1_COST_S = 100;
const RECIPE_DROP_MIN = 4;
const RECIPE_DROP_MAX = 8;
function nextRecipeInterval(){ return Math.floor(Math.random()*(RECIPE_DROP_MAX-RECIPE_DROP_MIN+1))+RECIPE_DROP_MIN; }
function pickWeightedRecipe(){
  const list = db.prepare(`SELECT id,code,name,tier FROM recipes WHERE tier BETWEEN 2 AND 5`).all();
  if(!list.length) return null;
  const byTier = {}; for(const r of list){ (byTier[r.tier] ||= []).push(r); }
  const roll = Math.floor(Math.random()*1000)+1; // 1..1000
  let tier = (roll<=13?5:roll<=50?4:roll<=200?3:2);
  while(tier>=2 && !byTier[tier]) tier--;
  const arr = byTier[tier] || byTier[2];
  return arr[Math.floor(Math.random()*arr.length)];
}
app.post("/api/shop/buy-t1",(req,res)=>{
  const tok = readToken(req);
  if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const result = db.transaction(()=>{
      const user = db.prepare("SELECT id,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(tok.uid);
      if(!user) throw new Error("Session expired.");
      if(user.balance_silver < SHOP_T1_COST_S) throw new Error("Insufficient funds.");
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(SHOP_T1_COST_S,user.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(user.id,-SHOP_T1_COST_S,"SHOP_BUY_T1",null,nowISO());
      let nextAt = user.next_recipe_at;
      if(nextAt==null){
        nextAt = user.shop_buy_count + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(nextAt,user.id);
      }
      const newCount = (user.shop_buy_count||0)+1;
      db.prepare("UPDATE users SET shop_buy_count=? WHERE id=?").run(newCount,user.id);
      const willDropRecipe = newCount >= nextAt;
      let gotItem=null, gotRecipe=null;
      if(willDropRecipe){
        const pick = pickWeightedRecipe();
        if(pick){
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
            VALUES (?,?,1,0)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+1
          `).run(user.id,pick.id);
          gotRecipe = {code:pick.code,name:pick.name,tier:pick.tier};
        }
        const next = newCount + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(next,user.id);
      }else{
        const t1 = db.prepare("SELECT id,code,name FROM items WHERE tier=1").all();
        const pick = t1[Math.floor(Math.random()*t1.length)];
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(user.id,pick.id);
        gotItem = {code:pick.code,name:pick.name,tier:1};
      }
      const bal = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(user.id).balance_silver;
      return {balance_silver:bal,gotItem,gotRecipe};
    })();
    res.json({ok:true, ...result});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Recipes: list & ingredients — ispod: GET /api/recipes/list, GET /api/recipes/ingredients/:id
app.get("/api/recipes/list",(req,res)=>{
  const tok = readToken(req);
  if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const rows = db.prepare(`
      SELECT r.id,r.code,r.name,r.tier,ur.qty
      FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
      WHERE ur.user_id=? AND ur.qty>0
      ORDER BY r.tier ASC, r.name ASC`).all(tok.uid);
    res.json({ok:true,recipes:rows});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});

app.get("/api/recipes/ingredients/:id",(req,res)=>{
  const tok = readToken(req);
  if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  const id = parseInt(req.params.id,10);
  if(!id) return res.status(400).json({ok:false,error:"Bad id"});
  try{
    const recipe = db.prepare(`SELECT id,code,name,tier,output_item_id FROM recipes WHERE id=?`).get(id);
    if(!recipe) return res.status(404).json({ok:false,error:"Recipe not found"});
    const ingredients = db.prepare(`
      SELECT ri.item_id,ri.qty,i.name,i.tier,COALESCE(ui.qty,0) AS have
      FROM recipe_ingredients ri
      JOIN items i ON i.id=ri.item_id
      LEFT JOIN user_items ui ON ui.item_id=ri.item_id AND ui.user_id=?
      WHERE ri.recipe_id=?
      ORDER BY i.tier,i.name`).all(tok.uid,id);
    res.json({ok:true,recipe,ingredients});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});

// Craft: normal recipe — ispod: POST /api/craft/do (10% fail → Scrap; materijali se troše uvijek)
app.post("/api/craft/do",(req,res)=>{
  const tok = readToken(req);
  if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  const rid = parseInt((req.body||{}).recipe_id,10);
  if(!rid) return res.status(400).json({ok:false,error:"Missing recipe_id"});
  try{
    const result = db.transaction(()=>{
      const r = db.prepare(`SELECT id,name,tier,output_item_id FROM recipes WHERE id=?`).get(rid);
      if(!r) throw new Error("Recipe not found.");
      const haveRec = db.prepare(`SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?`).get(tok.uid,r.id);
      if(!haveRec || haveRec.qty<=0) throw new Error("You don't own this recipe.");
      const need = db.prepare(`
        SELECT ri.item_id,ri.qty,i.name FROM recipe_ingredients ri
        JOIN items i ON i.id=ri.item_id WHERE ri.recipe_id=?`).all(r.id);
      for(const n of need){
        const inv = db.prepare(`SELECT qty FROM user_items WHERE user_id=? AND item_id=?`).get(tok.uid,n.item_id);
        if(!inv || inv.qty<n.qty) throw {code:"MISSING_MATS",missing:n.name};
      }
      for(const n of need){
        db.prepare(`UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?`).run(n.qty,tok.uid,n.item_id);
      }
      const fail = Math.random()<0.10;
      if(!fail){
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(tok.uid,r.output_item_id);
        db.prepare(`UPDATE user_recipes SET qty=qty-1 WHERE user_id=? AND recipe_id=?`).run(tok.uid,r.id);
        const out = db.prepare(`SELECT code,name,tier FROM items WHERE id=?`).get(r.output_item_id);
        return {result:"success",crafted:out};
      }else{
        const scrap = db.prepare(`SELECT id FROM items WHERE code='SCRAP'`).get();
        if(scrap){
          db.prepare(`
            INSERT INTO user_items(user_id,item_id,qty)
            VALUES (?,?,1)
            ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
          `).run(tok.uid,scrap.id);
        }
        return {result:"fail",scrap:true};
      }
    })();
    res.json({ok:true, ...result});
  }catch(e){
    if(e && e.code==="MISSING_MATS") return res.status(400).json({ok:false,error:"Not all required materials are available."});
    res.status(400).json({ok:false,error:String(e.message||e)});
  }
});

// Artefact: bonus i craft — ispod: GET /api/items/artefact/bonus, POST /api/craft/artefact
function ensureArtefactItem(){
  const r = db.prepare("SELECT id FROM items WHERE code='ARTEFACT'").get();
  if(!r){
    db.prepare("INSERT INTO items(code,name,tier,volatile,bonus_gold) VALUES (?,?,?,?,?)")
      .run("ARTEFACT","Artefact",6,0,0);
  }
}
app.get("/api/items/artefact/bonus",(_req,res)=>{
  try{
    ensureArtefactItem();
    const row = db.prepare(`SELECT bonus_gold FROM items WHERE code='ARTEFACT'`).get();
    res.json({ok:true,bonus_gold:(row?.bonus_gold|0)});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.post("/api/craft/artefact",(req,res)=>{
  const tok = readToken(req);
  if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const result = db.transaction(()=>{
      ensureArtefactItem();
      const t5 = db.prepare(`
        SELECT i.id,i.code
        FROM items i
        JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=? AND ui.qty>0
        WHERE i.tier=5
      `).all(tok.uid);
      const distinct = [...new Set(t5.map(x=>x.id))];
      if(distinct.length<10) throw new Error("Need 10 distinct T5 items.");
      const pick10 = distinct.slice(0,10);
      for(const iid of pick10){
        db.prepare(`UPDATE user_items SET qty=qty-1 WHERE user_id=? AND item_id=?`).run(tok.uid,iid);
      }
      const art = db.prepare(`SELECT id,bonus_gold FROM items WHERE code='ARTEFACT'`).get();
      db.prepare(`
        INSERT INTO user_items(user_id,item_id,qty)
        VALUES (?,?,1)
        ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
      `).run(tok.uid, art.id);
      return { crafted:"Artefact", bonus_gold:(art?.bonus_gold|0) };
    })();
    res.json({ok:true, ...result});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Inventory: full — ispod: GET /api/inventory (items, recipes, artefactBonusGold)
app.get("/api/inventory",(req,res)=>{
  const tok = readToken(req);
  if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  const items = db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ui.qty
    FROM user_items ui JOIN items i ON i.id=ui.item_id
    WHERE ui.user_id=? AND ui.qty>0
    ORDER BY i.tier,i.name`).all(tok.uid);
  const recipes = db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0
    ORDER BY r.tier,r.name`).all(tok.uid);
  ensureArtefactItem();
  const art = db.prepare(`SELECT bonus_gold FROM items WHERE code='ARTEFACT'`).get();
  res.json({ok:true,items,recipes,artefactBonusGold:(art?.bonus_gold|0)});
});

// Market: helpers — ispod: mapiranje aukcije u listing DTO
function mapListing(a){
  return {
    id:a.id, kind:a.type, item_id:a.item_id, recipe_id:a.recipe_id, qty:a.qty,
    price_s:a.buy_now_price_s, seller_user_id:a.seller_user_id, status:a.status,
    start_time:a.start_time, end_time:a.end_time, name:a.name??null, tier:a.tier??null
  };
}

// Market: live — ispod: GET /api/sales/live?q=
app.get("/api/sales/live",(req,res)=>{
  try{
    const q = (req.query && String(req.query.q||"").trim().toLowerCase()) || "";
    const rows = db.prepare(`
      SELECT a.*,
             COALESCE(i.name,r.name) AS name,
             COALESCE(i.tier,r.tier) AS tier
      FROM auctions a
      LEFT JOIN items   i ON a.type='item'   AND i.id=a.item_id
      LEFT JOIN recipes r ON a.type='recipe' AND r.id=a.recipe_id
      WHERE a.status='live'
      ORDER BY a.id DESC LIMIT 500`).all();
    const filtered = q ? rows.filter(a=>(a.name||"").toLowerCase().includes(q)) : rows;
    res.json({ok:true,listings:filtered.map(mapListing)});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});

// Market: mine — ispod: GET /api/sales/mine (moji oglasi)
app.get("/api/sales/mine",(req,res)=>{
  try{
    const uid = (readToken(req)||{}).uid; if(!uid) throw new Error("Not logged in.");
    const rows = db.prepare(`
      SELECT a.*,
             COALESCE(i.name,r.name) AS name,
             COALESCE(i.tier,r.tier) AS tier
      FROM auctions a
      LEFT JOIN items   i ON a.type='item'   AND i.id=a.item_id
      LEFT JOIN recipes r ON a.type='recipe' AND r.id=a.recipe_id
      WHERE a.seller_user_id=? AND a.status IN ('live','paid','canceled')
      ORDER BY a.id DESC LIMIT 500`).all(uid);
    res.json({ok:true,listings:rows.map(mapListing)});
  }catch(e){ res.status(401).json({ok:false,error:String(e.message||e)}); }
});

// Market: list — ispod: POST /api/sales/list (kreiraj buy-now oglas + escrow)
app.post("/api/sales/list",(req,res)=>{
  try{
    const tok = readToken(req); if(!tok) throw new Error("Not logged in.");
    const {kind,id,qty,gold=0,silver=0} = req.body||{};
    if(!(kind==="item"||kind==="recipe")) throw new Error("Bad kind.");
    const targetId = parseInt(id,10); if(!targetId) throw new Error("Bad id.");
    const q = Math.max(1, parseInt(qty,10)||1);
    const price = (Math.max(0,parseInt(gold,10)||0)*100) + ((Math.max(0,parseInt(silver,10)||0))%100);
    if(price<=0) throw new Error("Price must be > 0.");
    const feeS = Math.floor(price/100);
    const out = db.transaction(()=>{
      if(feeS>0){
        const bal = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(tok.uid);
        if(!bal || bal.balance_silver<feeS) throw new Error("Insufficient funds for listing fee.");
        db.prepare(`UPDATE users SET balance_silver=balance_silver-? WHERE id=?`).run(feeS,tok.uid);
        db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
          .run(tok.uid,-feeS,"SALE_LIST_FEE",null,nowISO());
      }
      if(kind==="item"){
        const row = db.prepare(`SELECT COALESCE(qty,0) qty FROM user_items WHERE user_id=? AND item_id=?`).get(tok.uid,targetId);
        if(!row || row.qty<q) throw new Error("Not enough items.");
        db.prepare(`UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?`).run(q,tok.uid,targetId);
      }else{
        const row = db.prepare(`SELECT COALESCE(qty,0) qty FROM user_recipes WHERE user_id=? AND recipe_id=?`).get(tok.uid,targetId);
        if(!row || row.qty<q) throw new Error("Not enough recipes.");
        db.prepare(`UPDATE user_recipes SET qty=qty-? WHERE user_id=? AND recipe_id=?`).run(q,tok.uid,targetId);
      }
      const ins = db.prepare(`
        INSERT INTO auctions (seller_user_id,type,item_id,recipe_id,qty,start_price_s,buy_now_price_s,fee_bps,status,start_time,end_time)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          tok.uid, kind, kind==="item"?targetId:null, kind==="recipe"?targetId:null, q,
          price, price, 100, 'live', nowISO(), addMinutes(nowISO(), 7*24*60)
        );
      db.prepare(`
        INSERT INTO inventory_escrow(auction_id,owner_user_id,type,item_id,recipe_id,qty,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(ins.lastInsertRowid, tok.uid, kind, kind==="item"?targetId:null, kind==="recipe"?targetId:null, q, nowISO());
      return { id:ins.lastInsertRowid, status:"live", price_s:price, qty:q, listing_fee_s:feeS };
    })();
    res.json({ok:true,listing:out});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Market: cancel & buy — ispod: POST /api/sales/cancel, POST /api/sales/buy
app.post("/api/sales/cancel",(req,res)=>{
  try{
    const tok = readToken(req); if(!tok) throw new Error("Not logged in.");
    const id = parseInt((req.body||{}).id,10); if(!id) throw new Error("Missing id.");
    const out = db.transaction(()=>{
      const a = db.prepare(`SELECT * FROM auctions WHERE id=?`).get(id);
      if(!a) throw new Error("Not found.");
      if(a.seller_user_id!==tok.uid) throw new Error("Forbidden.");
      if(a.status!=='live') throw new Error("Not live.");
      const esc = db.prepare(`SELECT * FROM inventory_escrow WHERE auction_id=?`).get(id);
      if(!esc) throw new Error("Missing escrow.");
      addInv(tok.uid, esc.item_id, esc.recipe_id, esc.qty);
      db.prepare(`UPDATE auctions SET status='canceled' WHERE id=?`).run(id);
      db.prepare(`DELETE FROM inventory_escrow WHERE auction_id=?`).run(id);
      return {id,status:"canceled"};
    })();
    res.json({ok:true,listing:out});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

app.post("/api/sales/buy",(req,res)=>{
  try{
    const tok = readToken(req); if(!tok) throw new Error("Not logged in.");
    const id = parseInt((req.body||{}).id,10); if(!id) throw new Error("Missing id.");
    const out = db.transaction(()=>{
      const a = db.prepare(`SELECT * FROM auctions WHERE id=?`).get(id);
      if(!a) throw new Error("Not found.");
      if(a.status!=='live') throw new Error("Not live.");
      if(!a.buy_now_price_s) throw new Error("Not a buy-now listing.");
      if(a.seller_user_id===tok.uid) throw new Error("You can't buy your own listing.");
      const price = a.buy_now_price_s;
      const buyer = db.prepare(`SELECT balance_silver FROM users WHERE id=?`).get(tok.uid);
      if(!buyer || buyer.balance_silver<price) throw new Error("Insufficient funds.");
      const esc = db.prepare(`SELECT * FROM inventory_escrow WHERE auction_id=?`).get(id);
      if(!esc) throw new Error("Missing escrow.");
      const fee = Math.floor((a.fee_bps||100)*price/10000);
      const net = price - fee;
      db.prepare(`UPDATE users SET balance_silver=balance_silver-? WHERE id=?`).run(price,tok.uid);
      db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
        .run(tok.uid,-price,"SALE_BUY",String(id),nowISO());
      db.prepare(`UPDATE users SET balance_silver=balance_silver+? WHERE id=?`).run(net,a.seller_user_id);
      db.prepare(`INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)`)
        .run(a.seller_user_id,net,"SALE_EARN",String(id),nowISO());
      addInv(tok.uid, esc.item_id, esc.recipe_id, esc.qty);
      db.prepare(`
        UPDATE auctions
        SET status='paid', winner_user_id=?, sold_price_s=?, end_time=?, highest_bid_s=?, highest_bidder_user_id=?
        WHERE id=?`).run(tok.uid, price, nowISO(), price, tok.uid, id);
      db.prepare(`DELETE FROM inventory_escrow WHERE auction_id=?`).run(id);
      return {id,paid_s:price};
    })();
    res.json({ok:true,result:out});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Health & start — ispod: GET /api/health i server.listen
app.get("/api/health",(_req,res)=>res.json({ok:true,time:nowISO()}));
server.listen(PORT, HOST, ()=>{ console.log(`ARTEFACT server listening on http://${HOST}:${PORT}`); });



