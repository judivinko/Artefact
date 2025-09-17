// ==============================================
// ARTEFACT • Full server (Express + SQLite)
// - Auth (register/login/logout/me) via JWT cookie
// - Shop: buy T1 only (1g), weighted recipe drops T2..T6 (800/150/37/12/1)
// - Crafting: normal craft (10% fail -> SCRAP, except T6 = 0%)
// - Special craft: ARTEFACT from 10 distinct T5 items, no fail
// - Sales (fixed price): create, list (search), mine, buy, cancel (escrow)
// - Admin: ping, users, adjust-balance, disable, user inventory
// - Static: serves /public (+ /admin -> public/admin.html)
// - Persistent DB at DATA_DIR/artefact.db (Render disk safe)
// ==============================================

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// -------- Config
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_NAME = "token";
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || "").toLowerCase();

// Economy
const SHOP_T1_COST_S = 100;            // 1 gold = 100 silver
const RECIPE_DROP_MIN = 4;             // after N T1 buys, you get a recipe
const RECIPE_DROP_MAX = 8;
const SALES_FEE_BPS = 100;             // 1%

// Persistent disk
const DATA_DIR = process.env.DATA_DIR || "/opt/render/project/src/data";
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DB_PATH = path.join(DATA_DIR, "artefact.db");

// -------- App
const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"))); // index.html, admin.html, app.css…

// -------- DB
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// -------- Helpers
const nowISO = () => new Date().toISOString();
const addMinutes = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function isValidEmail(e){ return typeof e==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e||"").toLowerCase()); }
function isValidPassword(p){ return typeof p==="string" && p.length>=6; }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function verifyTokenFromCookies(req){
  const t = req.cookies && req.cookies[TOKEN_NAME];
  if(!t) return null;
  try { return jwt.verify(t, JWT_SECRET); } catch { return null; }
}
function isAdminRequest(req){
  const hdr = (req.headers["x-admin-key"] || req.headers["X-Admin-Key"] || "").toString();
  if(hdr && hdr === ADMIN_KEY) return true;
  const tok = verifyTokenFromCookies(req);
  if(!tok) return false;
  const r = db.prepare("SELECT is_admin FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin === 1);
}
const clamp = (n,a,b)=> Math.max(a, Math.min(b,n));

// -------- Schema
function exec(sql){ db.exec(sql); }

exec(`CREATE TABLE IF NOT EXISTS users(
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

exec(`CREATE TABLE IF NOT EXISTS gold_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta_s INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);`);

exec(`CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  volatile INTEGER NOT NULL DEFAULT 0
);`);
exec(`CREATE TABLE IF NOT EXISTS user_items(
  user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,item_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(item_id) REFERENCES items(id)
);`);

exec(`CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  output_item_id INTEGER NOT NULL,
  FOREIGN KEY(output_item_id) REFERENCES items(id)
);`);
exec(`CREATE TABLE IF NOT EXISTS recipe_ingredients(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  FOREIGN KEY(recipe_id) REFERENCES recipes(id),
  FOREIGN KEY(item_id) REFERENCES items(id)
);`);
exec(`CREATE TABLE IF NOT EXISTS user_recipes(
  user_id INTEGER NOT NULL,
  recipe_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,recipe_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(recipe_id) REFERENCES recipes(id)
);`);

// Sales tables (fixed price)
exec(`CREATE TABLE IF NOT EXISTS sales(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,                 -- 'item' | 'recipe'
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  start_price_s INTEGER NOT NULL,     -- total price
  fee_bps INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL,               -- 'live' | 'sold' | 'canceled'
  created_at TEXT NOT NULL,
  sold_price_s INTEGER,
  buyer_user_id INTEGER,
  FOREIGN KEY (seller_user_id) REFERENCES users(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (recipe_id) REFERENCES recipes(id),
  FOREIGN KEY (buyer_user_id) REFERENCES users(id)
);`);

// Generic escrow table (used to hold items/recipes while listing is live)
exec(`CREATE TABLE IF NOT EXISTS inventory_escrow(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL UNIQUE,
  owner_user_id INTEGER NOT NULL,
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY(sale_id) REFERENCES sales(id),
  FOREIGN KEY(owner_user_id) REFERENCES users(id),
  FOREIGN KEY(item_id) REFERENCES items(id),
  FOREIGN KEY(recipe_id) REFERENCES recipes(id)
);`);

// -------- Seed helpers
function ensureItem(code,name,tier,volatile=0){
  const r=db.prepare("SELECT id FROM items WHERE code=?").get(code);
  if(r){ db.prepare("UPDATE items SET name=?,tier=?,volatile=? WHERE code=?").run(name,tier,volatile,code); return r.id; }
  db.prepare("INSERT INTO items(code,name,tier,volatile) VALUES (?,?,?,?)").run(code,name,tier,volatile);
  return db.prepare("SELECT id FROM items WHERE code=?").get(code).id;
}
function idByCode(code){ const r=db.prepare("SELECT id FROM items WHERE code=?").get(code); return r&&r.id; }
function ensureRecipe(code,name,tier,outCode,ingCodes){
  const outId = idByCode(outCode); if(!outId) throw new Error("Missing item "+outCode);
  const r=db.prepare("SELECT id FROM recipes WHERE code=?").get(code);
  let rid;
  if(!r){
    db.prepare("INSERT INTO recipes(code,name,tier,output_item_id) VALUES (?,?,?,?)").run(code,name,tier,outId);
    rid=db.prepare("SELECT id FROM recipes WHERE code=?").get(code).id;
  }else{
    db.prepare("UPDATE recipes SET name=?,tier=?,output_item_id=? WHERE id=?").run(name,tier,outId,r.id);
    rid=r.id;
    db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id=?").run(rid);
  }
  // qty=1 for each distinct ingredient (no duplicates)
  const seen = new Set();
  for(const c of ingCodes){
    if(seen.has(c)) continue;
    seen.add(c);
    const iid=idByCode(c); if(!iid) throw new Error("Missing ingredient "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,?)").run(rid,iid,1);
  }
  return rid;
}

// -------- Seed data

// Volatile scrap
ensureItem("SCRAP","Scrap",1,1);

// T1 materials (10)
const T1 = [
  ["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]
];
for(const [c,n] of T1) ensureItem(c,n,1,0);

// T2 items
ensureItem("T2_BRONZE_DOOR","Nor Bronze Door",2);
ensureItem("T2_SILVER_GOBLET","Nor Silver Goblet",2);
ensureItem("T2_GOLDEN_RING","Nor Golden Ring",2);
ensureItem("T2_WOODEN_CHEST","Nor Wooden Chest",2);
ensureItem("T2_STONE_PILLAR","Nor Stone Pillar",2);
ensureItem("T2_LEATHER_BAG","Nor Leather Bag",2);
ensureItem("T2_CLOTH_TENT","Nor Cloth Tent",2);
ensureItem("T2_CRYSTAL_ORB","Nor Crystal Orb",2);
ensureItem("T2_OBSIDIAN_KNIFE","Nor Obsidian Knife",2);
ensureItem("T2_IRON_ARMOR","Nor Iron Armor",2);

// T2 recipes (4–7 distinct T1 mats each)
ensureRecipe("R_T2_BRONZE_DOOR","Nor Bronze Door",2,"T2_BRONZE_DOOR",["BRONZE","IRON","WOOD","STONE"]);
ensureRecipe("R_T2_SILVER_GOBLET","Nor Silver Goblet",2,"T2_SILVER_GOBLET",["SILVER","GOLD","CRYSTAL","CLOTH","LEATHER"]);
ensureRecipe("R_T2_GOLDEN_RING","Nor Golden Ring",2,"T2_GOLDEN_RING",["GOLD","SILVER","CRYSTAL","OBSIDIAN","CLOTH","LEATHER"]);
ensureRecipe("R_T2_WOODEN_CHEST","Nor Wooden Chest",2,"T2_WOODEN_CHEST",["WOOD","STONE","LEATHER","IRON","CLOTH","BRONZE","SILVER"]);
ensureRecipe("R_T2_STONE_PILLAR","Nor Stone Pillar",2,"T2_STONE_PILLAR",["STONE","WOOD","IRON","CLOTH"]);
ensureRecipe("R_T2_LEATHER_BAG","Nor Leather Bag",2,"T2_LEATHER_BAG",["LEATHER","CLOTH","WOOD","SILVER","CRYSTAL"]);
ensureRecipe("R_T2_CLOTH_TENT","Nor Cloth Tent",2,"T2_CLOTH_TENT",["CLOTH","LEATHER","WOOD","STONE","IRON","OBSIDIAN"]);
ensureRecipe("R_T2_CRYSTAL_ORB","Nor Crystal Orb",2,"T2_CRYSTAL_ORB",["CRYSTAL","OBSIDIAN","GOLD","CLOTH","WOOD","LEATHER","BRONZE"]);
ensureRecipe("R_T2_OBSIDIAN_KNIFE","Nor Obsidian Knife",2,"T2_OBSIDIAN_KNIFE",["OBSIDIAN","CRYSTAL","IRON","BRONZE"]);
ensureRecipe("R_T2_IRON_ARMOR","Nor Iron Armor",2,"T2_IRON_ARMOR",["IRON","BRONZE","LEATHER","CLOTH","STONE"]);

// T3 items
ensureItem("T3_GATE_OF_MIGHT","Nor Gate of Might",3);
ensureItem("T3_GOBLET_OF_WISDOM","Nor Goblet of Wisdom",3);
ensureItem("T3_RING_OF_GLARE","Nor Ring of Glare",3);
ensureItem("T3_CHEST_OF_SECRETS","Nor Chest of Secrets",3);
ensureItem("T3_PILLAR_OF_STRENGTH","Nor Pillar of Strength",3);
ensureItem("T3_TRAVELERS_BAG","Nor Traveler's Bag",3);
ensureItem("T3_NOMAD_TENT","Nor Nomad Tent",3);
ensureItem("T3_ORB_OF_VISION","Nor Orb of Vision",3);
ensureItem("T3_KNIFE_OF_SHADOW","Nor Knife of Shadow",3);
ensureItem("T3_ARMOR_OF_GUARD","Nor Armor of Guard",3);

// Map T2 codes
const T2C = {
  DOOR:"T2_BRONZE_DOOR", GOBLET:"T2_SILVER_GOBLET", RING:"T2_GOLDEN_RING",
  CHEST:"T2_WOODEN_CHEST", PILLAR:"T2_STONE_PILLAR", BAG:"T2_LEATHER_BAG",
  TENT:"T2_CLOTH_TENT", ORB:"T2_CRYSTAL_ORB", KNIFE:"T2_OBSIDIAN_KNIFE", ARMOR:"T2_IRON_ARMOR"
};
// T3 recipes (4–7 distinct T2)
ensureRecipe("R_T3_GATE_OF_MIGHT","Nor Gate of Might",3,"T3_GATE_OF_MIGHT",[T2C.DOOR,T2C.GOBLET,T2C.RING,T2C.CHEST]);
ensureRecipe("R_T3_GOBLET_OF_WISDOM","Nor Goblet of Wisdom",3,"T3_GOBLET_OF_WISDOM",[T2C.GOBLET,T2C.RING,T2C.PILLAR,T2C.BAG,T2C.TENT]);
ensureRecipe("R_T3_RING_OF_GLARE","Nor Ring of Glare",3,"T3_RING_OF_GLARE",[T2C.RING,T2C.CHEST,T2C.PILLAR,T2C.BAG,T2C.ORB,T2C.KNIFE]);
ensureRecipe("R_T3_CHEST_OF_SECRETS","Nor Chest of Secrets",3,"T3_CHEST_OF_SECRETS",[T2C.CHEST,T2C.PILLAR,T2C.BAG,T2C.TENT,T2C.ORB,T2C.KNIFE,T2C.ARMOR]);
ensureRecipe("R_T3_PILLAR_OF_STRENGTH","Nor Pillar of Strength",3,"T3_PILLAR_OF_STRENGTH",[T2C.PILLAR,T2C.BAG,T2C.TENT,T2C.ORB]);
ensureRecipe("R_T3_TRAVELERS_BAG","Nor Traveler's Bag",3,"T3_TRAVELERS_BAG",[T2C.BAG,T2C.TENT,T2C.ORB,T2C.KNIFE,T2C.DOOR]);
ensureRecipe("R_T3_NOMAD_TENT","Nor Nomad Tent",3,"T3_NOMAD_TENT",[T2C.TENT,T2C.ORB,T2C.KNIFE,T2C.DOOR,T2C.ARMOR,T2C.GOBLET]);
ensureRecipe("R_T3_ORB_OF_VISION","Nor Orb of Vision",3,"T3_ORB_OF_VISION",[T2C.ORB,T2C.KNIFE,T2C.DOOR,T2C.GOBLET,T2C.CHEST,T2C.BAG,T2C.RING]);
ensureRecipe("R_T3_KNIFE_OF_SHADOW","Nor Knife of Shadow",3,"T3_KNIFE_OF_SHADOW",[T2C.KNIFE,T2C.DOOR,T2C.ARMOR,T2C.CHEST]);
ensureRecipe("R_T3_ARMOR_OF_GUARD","Nor Armor of Guard",3,"T3_ARMOR_OF_GUARD",[T2C.ARMOR,T2C.GOBLET,T2C.RING,T2C.BAG,T2C.TENT]);

// T4 items
ensureItem("T4_ENGINE_CORE","Nor Engine Core",4);
ensureItem("T4_CRYSTAL_LENS","Nor Crystal Lens",4);
ensureItem("T4_MIGHT_GATE","Nor Reinforced Gate",4);
ensureItem("T4_WISDOM_GOBLET","Nor Enruned Goblet",4);
ensureItem("T4_SECRET_CHEST","Nor Sealed Chest",4);
ensureItem("T4_STRENGTH_PILLAR","Nor Monument Pillar",4);
ensureItem("T4_TRAVELER_SATCHEL","Nor Traveler Satchel",4);
ensureItem("T4_NOMAD_DWELLING","Nor Nomad Dwelling",4);
ensureItem("T4_VISION_CORE","Nor Vision Core",4);
ensureItem("T4_SHADOW_BLADE","Nor Shadow Blade",4);

const T3C = {
  GATE:"T3_GATE_OF_MIGHT", GOBLET:"T3_GOBLET_OF_WISDOM", RING:"T3_RING_OF_GLARE",
  CHEST:"T3_CHEST_OF_SECRETS", PILLAR:"T3_PILLAR_OF_STRENGTH", BAG:"T3_TRAVELERS_BAG",
  TENT:"T3_NOMAD_TENT", ORB:"T3_ORB_OF_VISION", KNIFE:"T3_KNIFE_OF_SHADOW", ARMOR:"T3_ARMOR_OF_GUARD"
};
// T4 recipes
ensureRecipe("R_T4_ENGINE_CORE","Nor Engine Core",4,"T4_ENGINE_CORE",[T3C.GATE,T3C.KNIFE,T3C.ARMOR,T3C.ORB]);
ensureRecipe("R_T4_CRYSTAL_LENS","Nor Crystal Lens",4,"T4_CRYSTAL_LENS",[T3C.ORB,T3C.RING,T3C.GOBLET,T3C.CHEST,T3C.PILLAR]);
ensureRecipe("R_T4_MIGHT_GATE","Nor Reinforced Gate",4,"T4_MIGHT_GATE",[T3C.GATE,T3C.CHEST,T3C.ARMOR,T3C.BAG]);
ensureRecipe("R_T4_WISDOM_GOBLET","Nor Enruned Goblet",4,"T4_WISDOM_GOBLET",[T3C.GOBLET,T3C.RING,T3C.PILLAR,T3C.BAG,T3C.TENT]);
ensureRecipe("R_T4_SECRET_CHEST","Nor Sealed Chest",4,"T4_SECRET_CHEST",[T3C.CHEST,T3C.PILLAR,T3C.BAG,T3C.TENT,T3C.ORB,T3C.KNIFE]);
ensureRecipe("R_T4_STRENGTH_PILLAR","Nor Monument Pillar",4,"T4_STRENGTH_PILLAR",[T3C.PILLAR,T3C.BAG,T3C.TENT,T3C.ORB]);
ensureRecipe("R_T4_TRAVELER_SATCHEL","Nor Traveler Satchel",4,"T4_TRAVELER_SATCHEL",[T3C.BAG,T3C.TENT,T3C.ORB,T3C.KNIFE,T3C.GATE]);
ensureRecipe("R_T4_NOMAD_DWELLING","Nor Nomad Dwelling",4,"T4_NOMAD_DWELLING",[T3C.TENT,T3C.ORB,T3C.KNIFE,T3C.GATE,T3C.ARMOR,T3C.GOBLET]);
ensureRecipe("R_T4_VISION_CORE","Nor Vision Core",4,"T4_VISION_CORE",[T3C.ORB,T3C.KNIFE,T3C.GATE,T3C.GOBLET,T3C.CHEST]);
ensureRecipe("R_T4_SHADOW_BLADE","Nor Shadow Blade",4,"T4_SHADOW_BLADE",[T3C.KNIFE,T3C.GATE,T3C.CHEST,T3C.ARMOR]);

// T5 items
ensureItem("T5_ANCIENT_RELIC","Nor Ancient Relic",5);
ensureItem("T5_SUN_LENS","Nor Sun Lens",5);
ensureItem("T5_GUARDIAN_GATE","Nor Guardian Gate",5);
ensureItem("T5_WISDOM_CHALICE","Nor Wisdom Chalice",5);
ensureItem("T5_VAULT","Nor Royal Vault",5);
ensureItem("T5_COLOSSAL_PILLAR","Nor Colossal Pillar",5);
ensureItem("T5_WAYFARER_BAG","Nor Wayfarer Bag",5);
ensureItem("T5_NOMAD_HALL","Nor Nomad Hall",5);
ensureItem("T5_EYE_OF_TRUTH","Nor Eye of Truth",5);
ensureItem("T5_NIGHTFALL_EDGE","Nor Nightfall Edge",5);

const T4C = {
  CORE:"T4_ENGINE_CORE", LENS:"T4_CRYSTAL_LENS", RGATE:"T4_MIGHT_GATE", GOB:"T4_WISDOM_GOBLET",
  CHEST:"T4_SECRET_CHEST", PILLAR:"T4_STRENGTH_PILLAR", SATCHEL:"T4_TRAVELER_SATCHEL",
  DWELL:"T4_NOMAD_DWELLING", VISION:"T4_VISION_CORE", SHADOW:"T4_SHADOW_BLADE"
};
// T5 recipes (4–7 T4)
ensureRecipe("R_T5_ANCIENT_RELIC","Nor Ancient Relic",5,"T5_ANCIENT_RELIC",[T4C.CORE,T4C.LENS,T4C.GOB,T4C.CHEST]);
ensureRecipe("R_T5_SUN_LENS","Nor Sun Lens",5,"T5_SUN_LENS",[T4C.LENS,T4C.VISION,T4C.RGATE,T4C.PILLAR,T4C.SATCHEL]);
ensureRecipe("R_T5_GUARDIAN_GATE","Nor Guardian Gate",5,"T5_GUARDIAN_GATE",[T4C.RGATE,T4C.CORE,T4C.SATCHEL,T4C.DWELL]);
ensureRecipe("R_T5_WISDOM_CHALICE","Nor Wisdom Chalice",5,"T5_WISDOM_CHALICE",[T4C.GOB,T4C.LENS,T4C.PILLAR,T4C.SATCHEL,T4C.DWELL]);
ensureRecipe("R_T5_VAULT","Nor Royal Vault",5,"T5_VAULT",[T4C.CHEST,T4C.PILLAR,T4C.SATCHEL,T4C.DWELL,T4C.VISION,T4C.SHADOW]);
ensureRecipe("R_T5_COLOSSAL_PILLAR","Nor Colossal Pillar",5,"T5_COLOSSAL_PILLAR",[T4C.PILLAR,T4C.SATCHEL,T4C.DWELL,T4C.VISION]);
ensureRecipe("R_T5_WAYFARER_BAG","Nor Wayfarer Bag",5,"T5_WAYFARER_BAG",[T4C.SATCHEL,T4C.DWELL,T4C.VISION,T4C.SHADOW,T4C.RGATE]);
ensureRecipe("R_T5_NOMAD_HALL","Nor Nomad Hall",5,"T5_NOMAD_HALL",[T4C.DWELL,T4C.VISION,T4C.SHADOW,T4C.RGATE,T4C.GOB]);
ensureRecipe("R_T5_EYE_OF_TRUTH","Nor Eye of Truth",5,"T5_EYE_OF_TRUTH",[T4C.VISION,T4C.SHADOW,T4C.CORE,T4C.GOB,T4C.CHEST]);
ensureRecipe("R_T5_NIGHTFALL_EDGE","Nor Nightfall Edge",5,"T5_NIGHTFALL_EDGE",[T4C.SHADOW,T4C.RGATE,T4C.CHEST,T4C.CORE]);

// T6 (Artefact item; crafted only via special endpoint)
ensureItem("ARTEFACT","Artefact",6);

// Make default admin if the email already exists
if (DEFAULT_ADMIN_EMAIL) {
  try{
    const u=db.prepare("SELECT id FROM users WHERE email=?").get(DEFAULT_ADMIN_EMAIL);
    if(u) db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(u.id);
  }catch{}
}

// -------- AUTH
app.post("/api/register", async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
    if(!isValidPassword(password)) return res.status(400).json({ok:false,error:"Password must be at least 6 chars."});
    const ex=db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
    if(ex) return res.status(409).json({ok:false,error:"User already exists."});
    const pass=await bcrypt.hash(password,10);
    db.prepare("INSERT INTO users(email,pass_hash,created_at) VALUES (?,?,?)")
      .run(email.toLowerCase(),pass,nowISO());
    res.json({ok:true,message:"Registration successful."});
  }catch(e){ res.status(500).json({ok:false,error:"Server error."}); }
});
app.post("/api/login", async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    const u=db.prepare("SELECT id,email,pass_hash,is_disabled FROM users WHERE email=?").get((email||"").toLowerCase());
    if(!u) return res.status(404).json({ok:false,error:"User not found."});
    if(u.is_disabled) return res.status(403).json({ok:false,error:"Account disabled."});
    const ok=await bcrypt.compare(password||"",u.pass_hash);
    if(!ok) return res.status(401).json({ok:false,error:"Wrong password."});
    const token=signToken(u);
    res.cookie(TOKEN_NAME,token,{httpOnly:true,sameSite:"lax",secure:false,maxAge:7*24*60*60*1000});
    db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(),u.id);
    res.json({ok:true,message:"Logged in."});
  }catch(e){ res.status(500).json({ok:false,error:"Server error."}); }
});
app.get("/api/logout",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(u) db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(),u.uid);
  res.clearCookie(TOKEN_NAME,{httpOnly:true,sameSite:"lax",secure:false});
  res.json({ok:true,message:"Logged out."});
});
app.get("/api/me",(req,res)=>{
  const u=verifyTokenFromCookies(req);
  if(!u) return res.status(401).json({ok:false});
  const r=db.prepare(`
    SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at
    FROM users WHERE id=?`).get(u.uid);
  if(!r){
    res.clearCookie(TOKEN_NAME,{httpOnly:true,sameSite:"lax",secure:false});
    return res.status(401).json({ok:false,error:"Session expired."});
  }
  const g=Math.floor((r.balance_silver||0)/100), s=(r.balance_silver||0)%100;
  const buysToNext=(r.next_recipe_at==null)?null:Math.max(0,(r.next_recipe_at)-(r.shop_buy_count||0));
  res.json({ok:true,user:{
    id:r.id,email:r.email,is_admin:!!r.is_admin,
    gold:g,silver:s,balance_silver:r.balance_silver,
    shop_buy_count:r.shop_buy_count,next_recipe_at:r.next_recipe_at,buys_to_next:buysToNext
  }});
});

// -------- INVENTORY
app.get("/api/my/inventory",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false});
  const items=db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,COALESCE(ui.qty,0) qty
    FROM items i JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ui.qty>0 ORDER BY i.tier ASC,i.name ASC
  `).all(u.uid);
  const recipes=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,COALESCE(ur.qty,0) qty
    FROM recipes r JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
    WHERE ur.qty>0 ORDER BY r.tier ASC,r.name ASC
  `).all(u.uid);
  res.json({ok:true,items,recipes});
});

// -------- SHOP (T1 only, weighted recipe drop)
const T1_CODES = T1.map(([code]) => code);

function pickWeightedRecipe(){
  // Per-1000: T2 800 / T3 150 / T4 37 / T5 12 / T6 1
  const list = db.prepare(`SELECT id, code, name, tier FROM recipes`).all();
  if (!list.length) return null;
  const byTier = {};
  for (const r of list){ (byTier[r.tier]??=[]).push(r); }
  const roll = randInt(1,1000);
  let targetTier;
  if (roll === 1) targetTier = 6;
  else if (roll <= 13) targetTier = 5;     // 12
  else if (roll <= 50) targetTier = 4;     // 37
  else if (roll <= 200) targetTier = 3;    // 150
  else targetTier = 2;                     // 800
  let tier = targetTier;
  while (tier>=2 && !(byTier[tier] && byTier[tier].length)) tier--;
  if(!byTier[tier] || !byTier[tier].length) tier = 2;
  const arr = byTier[tier];
  return arr[Math.floor(Math.random()*arr.length)];
}
function nextRecipeInterval(){ return randInt(RECIPE_DROP_MIN, RECIPE_DROP_MAX); }

app.post("/api/shop/buy-t1",(req,res)=>{
  const uTok=verifyTokenFromCookies(req);
  if(!uTok) return res.status(401).json({ok:false,error:"Not logged in."});

  try{
    const result=db.transaction(()=>{
      const user=db.prepare("SELECT id,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(uTok.uid);
      if(!user) throw new Error("Session expired. Log in again.");
      if(user.balance_silver<SHOP_T1_COST_S) throw new Error("Insufficient funds.");

      // charge
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(SHOP_T1_COST_S,user.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(user.id,-SHOP_T1_COST_S,"SHOP_BUY_T1",null,nowISO());

      if (user.next_recipe_at == null){
        const firstAt = user.shop_buy_count + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(firstAt, user.id);
        user.next_recipe_at = firstAt;
      }

      const willDropRecipe = (user.shop_buy_count + 1) >= user.next_recipe_at;
      let addedItem = null;
      let grantedRecipe = null;

      if (willDropRecipe){
        const pick = pickWeightedRecipe();
        if (pick){
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
            VALUES (?,?,1,0)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty = qty + 1
          `).run(user.id, pick.id);

          db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
            .run(user.id, 0,"RECIPE_DROP",`recipe:${pick.code}`, nowISO());

          grantedRecipe = { id: pick.id, code: pick.code, name: pick.name, tier: pick.tier };
        }
        const nextAt = (user.shop_buy_count + 1) + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(nextAt, user.id);
      }else{
        const code = T1_CODES[Math.floor(Math.random()*T1_CODES.length)];
        const iid = idByCode(code);
        db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                    ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(user.id,iid);
        const itemRow=db.prepare("SELECT code,name FROM items WHERE id=?").get(iid);
        addedItem = itemRow;
      }

      db.prepare("UPDATE users SET shop_buy_count=shop_buy_count+1 WHERE id=?").run(user.id);

      const bal=db.prepare("SELECT balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(user.id);
      const buysToNext=(bal.next_recipe_at==null)?null:Math.max(0,bal.next_recipe_at-bal.shop_buy_count);
      const g=Math.floor(bal.balance_silver/100), s=bal.balance_silver%100;

      return { ok:true,
        result_type: willDropRecipe ? "RECIPE" : "ITEM",
        addedItem, grantedRecipe,
        gold:g, silver:s, balance_silver:bal.balance_silver,
        shop_buy_count:bal.shop_buy_count, buys_to_next: buysToNext
      };
    })();

    res.json(result);
  }catch(e){
    res.status(400).json({ok:false,error:String(e.message||e)});
  }
});

// -------- RECIPES / CRAFT
app.get("/api/my/recipes",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false});
  const rows=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty,ur.attempts
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0
    ORDER BY r.tier ASC,r.name ASC
  `).all(u.uid);
  res.json({ok:true,recipes:rows});
});

app.get("/api/recipes/:id",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false});
  const rid=parseInt(req.params.id,10);
  const rec=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,r.output_item_id,COALESCE(ur.qty,0) have_qty,COALESCE(ur.attempts,0) attempts
    FROM recipes r LEFT JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
    WHERE r.id=?
  `).get(u.uid,rid);
  if(!rec || !rec.have_qty) return res.status(404).json({ok:false,error:"You don't own this recipe."});
  const ings=db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ri.qty need_qty,COALESCE(ui.qty,0) have_qty
    FROM recipe_ingredients ri JOIN items i ON i.id=ri.item_id
    LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ri.recipe_id=?
    ORDER BY i.tier ASC,i.name ASC
  `).all(u.uid,rid);
  const enriched=ings.map(x=>({ item_id:x.id, code:x.code, name:x.name, tier:x.tier, need_qty:x.need_qty, have_qty:x.have_qty, missing:Math.max(0,x.need_qty-x.have_qty)}));
  const can_craft=enriched.every(x=>x.have_qty>=x.need_qty);
  res.json({ ok:true, recipe:{ id:rec.id,code:rec.code,name:rec.name,tier:rec.tier,attempts:rec.attempts,output_item_id:rec.output_item_id }, ingredients:enriched, can_craft });
});

app.post("/api/recipes/:id/craft",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const rid=parseInt(req.params.id,10);
  try{
    const out=db.transaction(()=>{
      const rec=db.prepare(`
        SELECT r.id,r.code,r.name,r.tier,r.output_item_id,COALESCE(ur.qty,0) have_qty,COALESCE(ur.attempts,0) attempts
        FROM recipes r LEFT JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
        WHERE r.id=?
      `).get(u.uid,rid);
      if(!rec||!rec.have_qty) throw new Error("You don't own this recipe.");

      const ings=db.prepare(`
        SELECT i.id,i.code,i.name,ri.qty need_qty,COALESCE(ui.qty,0) have_qty
        FROM recipe_ingredients ri JOIN items i ON i.id=ri.item_id
        LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
        WHERE ri.recipe_id=?
      `).all(u.uid,rid);
      for(const ing of ings){ if(ing.have_qty<ing.need_qty) throw new Error("Missing: "+ing.code+" x"+(ing.need_qty-ing.have_qty)); }
      for(const ing of ings){ db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(ing.need_qty,u.uid,ing.id); }

      db.prepare("UPDATE user_recipes SET attempts = MIN(attempts + 1, 5) WHERE user_id = ? AND recipe_id = ?").run(u.uid, rec.id);

      const outTierRow = db.prepare("SELECT tier FROM items WHERE id=?").get(rec.output_item_id);
      const outTier = outTierRow ? (outTierRow.tier|0) : rec.tier;
      const failP = (outTier >= 6) ? 0.0 : 0.10;
      const roll=Math.random();

      if(roll<failP){
        const scrap=idByCode("SCRAP");
        db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                    ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(u.uid,scrap);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(u.uid,0,"CRAFT_FAIL","recipe:"+rec.code,nowISO());
        return { ok:true, crafted:false, scrap:true, recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier}, msg:"Craft failed (scrap)" };
      }else{
        const ch = db.prepare("UPDATE user_recipes SET qty = qty - 1 WHERE user_id = ? AND recipe_id = ? AND qty > 0").run(u.uid, rec.id).changes;
        if (ch === 0) throw new Error("Recipe not available any more.");

        db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                    ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(u.uid,rec.output_item_id);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(u.uid,0,"CRAFT_SUCCESS","recipe:"+rec.code,nowISO());
        const outItem=db.prepare("SELECT code,name,tier FROM items WHERE id=?").get(rec.output_item_id);
        return { ok:true, crafted:true, scrap:false, output:outItem, recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier}, msg:`Crafted: ${outItem.name} [T${outItem.tier}]` };
      }
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Special ARTEFACT craft: consume 10 distinct T5 items (1 each)
app.post("/api/craft/artefact",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const r = db.transaction(()=>{
      // list distinct T5 items user owns
      const t5 = db.prepare(`
        SELECT i.id,i.code,i.name,ui.qty
        FROM user_items ui JOIN items i ON i.id=ui.item_id
        WHERE ui.user_id=? AND ui.qty>0 AND i.tier=5
        ORDER BY i.name ASC
      `).all(u.uid);

      if(!t5.length || t5.length < 10) throw new Error("You need at least 10 different T5 items.");

      // take 10 distinct
      const picked = t5.slice(0,10);
      for(const p of picked){
        db.prepare("UPDATE user_items SET qty=qty-1 WHERE user_id=? AND item_id=?").run(u.uid,p.id);
      }
      const arte = idByCode("ARTEFACT");
      db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                  ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(u.uid,arte);
      return { ok:true, msg:"Crafted ARTEFACT", used:picked.map(x=>x.name) };
    })();

    res.json(r);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// -------- SALES (fixed price)
function findItemOrRecipeByCode(code){
  if(!code || typeof code!=="string") return null;
  if(code.startsWith("R_")){
    const r=db.prepare("SELECT id,code,name,tier FROM recipes WHERE code=?").get(code);
    return r?{kind:"recipe",rec:r}:null;
  }else{
    const i=db.prepare("SELECT id,code,name,tier FROM items WHERE code=?").get(code);
    return i?{kind:"item",it:i}:null;
  }
}

// Create listing
app.post("/api/sales/create",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const {code,qty=1,price_gold=0,price_silver=0}=req.body||{};
  const look=findItemOrRecipeByCode((code||"").trim());
  if(!look) return res.status(400).json({ok:false,error:"Unknown code (item or recipe)."});
  const q=Math.max(1,Math.trunc(qty));
  const price_s = Math.trunc(price_gold||0)*100 + Math.trunc(price_silver||0);
  if(price_s<=0) return res.status(400).json({ok:false,error:"Price must be > 0."});
  try{
    const result=db.transaction(()=>{
      if(look.kind==="item"){
        const r=db.prepare("SELECT qty FROM user_items WHERE user_id=? AND item_id=?").get(u.uid,look.it.id);
        if(!r||r.qty<q) throw new Error("Not enough items.");
        db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(q,u.uid,look.it.id);
      }else{
        const r=db.prepare("SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?").get(u.uid,look.rec.id);
        if(!r||r.qty<q) throw new Error("Not enough recipes.");
        db.prepare("UPDATE user_recipes SET qty=qty-? WHERE user_id=? AND recipe_id=?").run(q,u.uid,look.rec.id);
      }
      const now=nowISO();
      db.prepare(`
        INSERT INTO sales
        (seller_user_id,type,item_id,recipe_id,qty,start_price_s,fee_bps,status,created_at)
        VALUES (?,?,?,?,?,?,?, 'live',?)
      `).run(u.uid,look.kind,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,price_s,SALES_FEE_BPS,now);
      const sid=db.prepare("SELECT last_insert_rowid() id").get().id;
      db.prepare("INSERT INTO inventory_escrow(sale_id,owner_user_id,item_id,recipe_id,qty,created_at) VALUES (?,?,?,?,?,?)")
        .run(sid,u.uid,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,now);
      const s=db.prepare(`
        SELECT s.id,s.type,s.qty,s.start_price_s,COALESCE(i.code,r.code) code,COALESCE(i.name,r.name) name
        FROM sales s LEFT JOIN items i ON i.id=s.item_id LEFT JOIN recipes r ON r.id=s.recipe_id WHERE s.id=?`).get(sid);
      return {ok:true,sale:s};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Live marketplace (with name search ?q=…)
app.get("/api/sales/live",(req,res)=>{
  const q = (req.query.q||"").toString().trim().toLowerCase();
  const rows = db.prepare(`
    SELECT s.id,s.type,s.qty,s.start_price_s,s.status,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name
    FROM sales s
    LEFT JOIN items i ON i.id=s.item_id
    LEFT JOIN recipes r ON r.id=s.recipe_id
    WHERE s.status='live'
    ORDER BY s.id DESC
  `).all();
  const filtered = q ? rows.filter(x=> (x.name||"").toLowerCase().includes(q)) : rows;
  res.json({ok:true,listings:filtered});
});

// My listings
app.get("/api/sales/mine",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false});
  const rows=db.prepare(`
    SELECT s.id,s.type,s.qty,s.start_price_s,s.status,s.sold_price_s,s.buyer_user_id,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name
    FROM sales s
    LEFT JOIN items i ON i.id=s.item_id
    LEFT JOIN recipes r ON r.id=s.recipe_id
    WHERE s.seller_user_id=?
    ORDER BY s.id DESC
  `).all(u.uid);
  res.json({ok:true,listings:rows});
});

// Buy listing
app.post("/api/sales/:id/buy",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const sid=parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const s=db.prepare("SELECT * FROM sales WHERE id=?").get(sid);
      if(!s || s.status!=='live') throw new Error("Listing not active.");
      if(s.seller_user_id===u.uid) throw new Error("Can't buy your own listing.");

      const buyer=db.prepare("SELECT id,balance_silver FROM users WHERE id=?").get(u.uid);
      if(buyer.balance_silver < s.start_price_s) throw new Error("Insufficient funds.");

      const seller=db.prepare("SELECT id FROM users WHERE id=?").get(s.seller_user_id);

      // charge buyer
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(s.start_price_s,buyer.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(buyer.id,-s.start_price_s,"SALE_BUY",`sale:${s.id}`,nowISO());

      // payout seller (minus fee)
      const fee = Math.floor((s.start_price_s * s.fee_bps)/10000);
      const net = s.start_price_s - fee;
      db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(net,seller.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(seller.id,net,"SALE_PAYOUT","sale:"+s.id,nowISO());

      // move escrow to buyer
      const esc=db.prepare("SELECT * FROM inventory_escrow WHERE sale_id=?").get(s.id);
      if (esc){
        if(esc.item_id){
          db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`)
            .run(buyer.id,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`)
            .run(buyer.id,esc.recipe_id,esc.qty);
        }
        db.prepare("DELETE FROM inventory_escrow WHERE sale_id=?").run(s.id);
      }

      db.prepare("UPDATE sales SET status='sold', sold_price_s=?, buyer_user_id=? WHERE id=?")
        .run(s.start_price_s,buyer.id,s.id);

      return { ok:true };
    })();

    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Cancel listing (no bids in sales model)
app.post("/api/sales/:id/cancel",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const sid=parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const s=db.prepare("SELECT * FROM sales WHERE id=?").get(sid);
      if(!s || s.seller_user_id!==u.uid) throw new Error("Not your listing.");
      if(s.status!=='live') throw new Error("Listing not active.");

      const esc=db.prepare("SELECT * FROM inventory_escrow WHERE sale_id=?").get(s.id);
      if(esc){
        if(esc.item_id){
          db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`)
            .run(u.uid,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`)
            .run(u.uid,esc.recipe_id,esc.qty);
        }
        db.prepare("DELETE FROM inventory_escrow WHERE sale_id=?").run(s.id);
      }

      db.prepare("UPDATE sales SET status='canceled' WHERE id=?").run(s.id);
      return {ok:true};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// -------- ADMIN
app.get("/api/admin/ping",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  res.json({ok:true,message:"Admin OK"});
});
app.get("/api/admin/users",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const rows=db.prepare(`
    SELECT id,email,is_admin,is_disabled,created_at,last_seen,balance_silver,shop_buy_count,next_recipe_at
    FROM users
    ORDER BY is_disabled ASC, lower(email) ASC
  `).all();
  const users = rows.map(u=>({
    id:u.id,email:u.email,is_admin:!!u.is_admin,is_disabled:!!u.is_disabled,
    created_at:u.created_at,last_seen:u.last_seen,
    gold:Math.floor((u.balance_silver||0)/100), silver:(u.balance_silver||0)%100,
    shop_buy_count:u.shop_buy_count ?? 0, next_recipe_at:u.next_recipe_at ?? null
  }));
  res.json({ok:true,users});
});
app.post("/api/admin/adjust-balance",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email,gold=0,silver=0,delta_silver}=req.body||{};
  if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u=db.prepare("SELECT id,balance_silver FROM users WHERE lower(email)=lower(?)").get(email);
  if(!u) return res.status(404).json({ok:false,error:"User not found"});
  let deltaS=(typeof delta_silver==="number")?Math.trunc(delta_silver):(Math.trunc(gold)*100+Math.trunc(silver));
  if(!Number.isFinite(deltaS) || deltaS===0) return res.status(400).json({ok:false,error:"No change"});
  try{
    const tx=db.transaction(()=>{
      const after=u.balance_silver+deltaS;
      if(after<0) throw new Error("Insufficient funds");
      db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after,u.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(u.id,deltaS,"ADMIN_ADJUST",null,nowISO());
    }); tx();
    const updated=db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
    res.json({ok:true,balance_silver:updated,gold:Math.floor(updated/100),silver:updated%100});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.post("/api/admin/disable-user",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email,disabled}=req.body||{};
  if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const flag = disabled ? 1 : 0;
  const r = db.prepare("UPDATE users SET is_disabled=? WHERE lower(email)=lower(?)").run(flag,email);
  if(r.changes===0) return res.status(404).json({ok:false,error:"User not found"});
  res.json({ok:true});
});
app.get("/api/admin/user/:id/inventory",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const uid=parseInt(req.params.id,10);
  const items=db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,COALESCE(ui.qty,0) qty
    FROM items i JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ui.qty>0 ORDER BY i.tier ASC,i.name ASC
  `).all(uid);
  const recipes=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,COALESCE(ur.qty,0) qty
    FROM recipes r JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
    WHERE ur.qty>0 ORDER BY r.tier ASC,r.name ASC
  `).all(uid);
  res.json({ok:true,items,recipes});
});

// -------- Static admin page
app.get("/admin",(req,res)=> res.sendFile(path.join(__dirname,"public","admin.html")));

// -------- Health
app.get("/api/health",(req,res)=> res.json({
  ok:true,
  data_dir: DATA_DIR,
  db_path: DB_PATH,
  recipe_drop_per_1000: { T2:800, T3:150, T4:37, T5:12, T6:1 }
}));

// -------- Start
server.listen(PORT, HOST, ()=>{
  console.log(`ARTEFACT running at http://${HOST}:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
