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

const DB_FILE = process.env.DB_PATH || path.join(__dirname, "data", "artefact.db"));
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

// Catalog: items — ispod: SCRAP + T1–T5 bez “Nor” u imenima
ensureItemIcon("SCRAP","Scrap",1,1);
const T1 = [
  ["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]
];
for (const [c,n] of T1) ensureItemIcon(c,n,1,0);

const T2_ITEMS = [
  ["T2_BRONZE_DOOR","Bronze Door"],["T2_SILVER_GOBLET","Silver Goblet"],
  ["T2_GOLDEN_RING","Golden Ring"],["T2_WOODEN_CHEST","Wooden Chest"],
  ["T2_STONE_PILLAR","Stone Pillar"],["T2_LEATHER_BAG","Leather Bag"],
  ["T2_CLOTH_TENT","Cloth Tent"],["T2_CRYSTAL_ORB","Crystal Orb"],
  ["T2_OBSIDIAN_KNIFE","Obsidian Knife"],["T2_IRON_ARMOR","Iron Armor"]
];
for (const [code,name] of T2_ITEMS) ensureItemIcon(code,name,2,0);

const T3_ITEMS = [
  ["T3_GATE_OF_MIGHT","Gate of Might"],["T3_GOBLET_OF_WISDOM","Goblet of Wisdom"],
  ["T3_RING_OF_GLARE","Ring of Glare"],["T3_CHEST_OF_SECRETS","Chest of Secrets"],
  ["T3_PILLAR_OF_STRENGTH","Pillar of Strength"],["T3_TRAVELERS_BAG","Traveler's Bag"],
  ["T3_NOMAD_TENT","Nomad Tent"],["T3_ORB_OF_VISION","Orb of Vision"],
  ["T3_KNIFE_OF_SHADOW","Knife of Shadow"],["T3_ARMOR_OF_GUARD","Armor of Guard"]
];
for (const [code,name] of T3_ITEMS) ensureItemIcon(code,name,3,0);

const T4_ITEMS = [
  ["T4_ENGINE_CORE","Engine Core"],["T4_CRYSTAL_LENS","Crystal Lens"],
  ["T4_MIGHT_GATE","Reinforced Gate"],["T4_WISDOM_GOBLET","Enruned Goblet"],
  ["T4_SECRET_CHEST","Sealed Chest"],["T4_STRENGTH_PILLAR","Monument Pillar"],
  ["T4_TRAVELER_SATCHEL","Traveler Satchel"],["T4_NOMAD_DWELLING","Nomad Dwelling"],
  ["T4_VISION_CORE","Vision Core"],["T4_SHADOW_BLADE","Shadow Blade"]
];
for (const [code,name] of T4_ITEMS) ensureItemIcon(code,name,4,0);

const T5_ITEMS = [
  ["T5_ANCIENT_RELIC","Ancient Relic"],["T5_SUN_LENS","Sun Lens"],
  ["T5_GUARDIAN_GATE","Guardian Gate"],["T5_WISDOM_CHALICE","Wisdom Chalice"],
  ["T5_VAULT","Royal Vault"],["T5_COLOSSAL_PILLAR","Colossal Pillar"],
  ["T5_WAYFARER_BAG","Wayfarer Bag"],["T5_NOMAD_HALL","Nomad Hall"],
  ["T5_EYE_OF_TRUTH","Eye of Truth"],["T5_NIGHTFALL_EDGE","Nightfall Edge"]
];
for (const [code,name] of T5_ITEMS) ensureItemIcon(code,name,5,0);

// Catalog: recipes — ispod: T2–T5 recepti, imena s “R ” (bez “Nor”)
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
for (const [code,name,tier,result,parts] of R_T2) ensureRecipeIcon(code,name,tier,result,parts);

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
for (const [code,name,tier,result,parts] of R_T3) ensureRecipeIcon(code,name,tier,result,parts);

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
for (const [code,name,tier,result,parts] of R_T4) ensureRecipeIcon(code,name,tier,result,parts);

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
for (const [code,name,tier,result,parts] of R_T5) ensureRecipeIcon(code,name,tier,result,parts);
