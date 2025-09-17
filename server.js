// ==============================================
// ARTEFACT • Full server (Express + better-sqlite3)
// - Persistent DB on Render disk (or ./data locally)
// - Auth (register/login/logout/me) via httpOnly JWT cookie
// - Shop: buy T1 pack (1g=100s), recipe drops (T2–T6 weighted 800/150/37/12/1)
// - Crafting: recipes + special ARTEFACT (10 distinct T5)
// - Sales (fixed-price): create, live (with ?q=search), mine, buy, cancel
// - Inventory endpoints
// - Admin route kept (/admin) but no button in UI
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

// Persistent disk (Render default mount) or local ./data
const DATA_DIR = process.env.DATA_DIR || "/opt/render/project/src/data";
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const DB_PATH = path.join(DATA_DIR, "artefact.db");

// Economy
const SHOP_T1_COST_S = 100; // 1 gold
const RECIPE_DROP_MIN = 4;
const RECIPE_DROP_MAX = 8;
const SALES_FEE_BPS = 100; // 1%

// -------- App
const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"))); // index.html, app.css, etc.

// -------- DB
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const nowISO = () => new Date().toISOString();
const randInt = (a,b)=> a + Math.floor(Math.random()*(b-a+1));
const addMinutes = (iso,m)=> new Date(new Date(iso).getTime()+m*60000).toISOString();

function isValidEmail(e){ return typeof e==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e||"").toLowerCase()); }
function isValidPassword(p){ return typeof p==="string" && typeof p === "string" && p.length>=6; }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function verify(req){
  const t = req.cookies && req.cookies[TOKEN_NAME];
  if(!t) return null;
  try { return jwt.verify(t, JWT_SECRET); } catch { return null; }
}

// -------- Schema helpers
function ensure(sql){ db.exec(sql); }
function ensureCol(table, colDef){
  const name = colDef.split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if(!cols.some(c=>c.name===name)){
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  }
}

// -------- Schema
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

// We reuse "auctions" infra for fixed-price Sales.
// We only use buy-now path and ignore bidding.
ensure(`
CREATE TABLE IF NOT EXISTS auctions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,          -- 'item' | 'recipe'
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT,
  start_price_s INTEGER NOT NULL,        -- used as fixed price
  buy_now_price_s INTEGER,               -- equals start_price_s
  highest_bid_s INTEGER,
  highest_bidder_user_id INTEGER,
  fee_bps INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL,        -- 'live' | 'paid' | 'canceled'
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  sold_price_s INTEGER,
  winner_user_id INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (seller_user_id) REFERENCES users(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (recipe_id) REFERENCES recipes(id),
  FOREIGN KEY (highest_bidder_user_id) REFERENCES users(id),
  FOREIGN KEY (winner_user_id) REFERENCES users(id)
);`);

ensure(`
CREATE TABLE IF NOT EXISTS inventory_escrow(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL UNIQUE,
  owner_user_id INTEGER NOT NULL,
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY(auction_id) REFERENCES auctions(id),
  FOREIGN KEY(owner_user_id) REFERENCES users(id),
  FOREIGN KEY(item_id) REFERENCES items(id),
  FOREIGN KEY(recipe_id) REFERENCES recipes(id)
);`);

ensure(`
CREATE TABLE IF NOT EXISTS bids(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL,
  bidder_user_id INTEGER NOT NULL,
  amount_s INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(auction_id) REFERENCES auctions(id),
  FOREIGN KEY(bidder_user_id) REFERENCES users(id)
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
  for(const c of ingCodes){
    const iid=idByCode(c); if(!iid) throw new Error("Missing ingredient "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,?)").run(rid,iid,1);
  }
  return rid;
}

// -------- Items & Recipes (compact set to match your previous logic)

// Volatile scrap
ensureItem("SCRAP","Scrap",1,1);

// T1 materials (10)
const T1 = [
  ["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]
];
for(const [c,n] of T1) ensureItem(c,n,1,0);

// T2 examples
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

// T2 recipes (unique T1s, 4–7 each)
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

// T3 (from T2)
ensureItem("T3_GATE","Nor Gate of Might",3);
ensureItem("T3_GOBLET","Nor Goblet of Wisdom",3);
ensureItem("T3_RING","Nor Ring of Glare",3);
ensureItem("T3_CHEST","Nor Chest of Secrets",3);
ensureItem("T3_PILLAR","Nor Pillar of Strength",3);
ensureItem("T3_BAG","Nor Traveler's Bag",3);
ensureItem("T3_TENT","Nor Nomad Tent",3);
ensureItem("T3_ORB","Nor Orb of Vision",3);
ensureItem("T3_KNIFE","Nor Knife of Shadow",3);
ensureItem("T3_ARMOR","Nor Armor of Guard",3);

const T2C = {
  DOOR:"T2_BRONZE_DOOR", GOBLET:"T2_SILVER_GOBLET", RING:"T2_GOLDEN_RING",
  CHEST:"T2_WOODEN_CHEST", PILLAR:"T2_STONE_PILLAR", BAG:"T2_LEATHER_BAG",
  TENT:"T2_CLOTH_TENT", ORB:"T2_CRYSTAL_ORB", KNIFE:"T2_OBSIDIAN_KNIFE", ARMOR:"T2_IRON_ARMOR"
};
ensureRecipe("R_T3_GATE","Nor Gate of Might",3,"T3_GATE",[T2C.DOOR,T2C.GOBLET,T2C.RING,T2C.CHEST]);
ensureRecipe("R_T3_GOBLET","Nor Goblet of Wisdom",3,"T3_GOBLET",[T2C.GOBLET,T2C.RING,T2C.PILLAR,T2C.BAG,T2C.TENT]);
ensureRecipe("R_T3_RING","Nor Ring of Glare",3,"T3_RING",[T2C.RING,T2C.CHEST,T2C.PILLAR,T2C.BAG,T2C.ORB,T2C.KNIFE]);
ensureRecipe("R_T3_CHEST","Nor Chest of Secrets",3,"T3_CHEST",[T2C.CHEST,T2C.PILLAR,T2C.BAG,T2C.TENT,T2C.ORB,T2C.KNIFE,T2C.ARMOR]);
ensureRecipe("R_T3_PILLAR","Nor Pillar of Strength",3,"T3_PILLAR",[T2C.PILLAR,T2C.BAG,T2C.TENT,T2C.ORB]);
ensureRecipe("R_T3_BAG","Nor Traveler's Bag",3,"T3_BAG",[T2C.BAG,T2C.TENT,T2C.ORB,T2C.KNIFE,T2C.DOOR]);
ensureRecipe("R_T3_TENT","Nor Nomad Tent",3,"T3_TENT",[T2C.TENT,T2C.ORB,T2C.KNIFE,T2C.DOOR,T2C.ARMOR,T2C.GOBLET]);
ensureRecipe("R_T3_ORB","Nor Orb of Vision",3,"T3_ORB",[T2C.ORB,T2C.KNIFE,T2C.DOOR,T2C.GOBLET,T2C.CHEST,T2C.BAG,T2C.RING]);
ensureRecipe("R_T3_KNIFE","Nor Knife of Shadow",3,"T3_KNIFE",[T2C.KNIFE,T2C.DOOR,T2C.ARMOR,T2C.CHEST]);
ensureRecipe("R_T3_ARMOR","Nor Armor of Guard",3,"T3_ARMOR",[T2C.ARMOR,T2C.GOBLET,T2C.RING,T2C.BAG,T2C.TENT]);

// T4
ensureItem("T4_CORE","Nor Engine Core",4);
ensureItem("T4_LENS","Nor Crystal Lens",4);
ensureItem("T4_RGATE","Nor Reinforced Gate",4);
ensureItem("T4_RGOBLET","Nor Enruned Goblet",4);
ensureItem("T4_RCHEST","Nor Sealed Chest",4);
ensureItem("T4_RPILLAR","Nor Monument Pillar",4);
ensureItem("T4_SATCHEL","Nor Traveler Satchel",4);
ensureItem("T4_DWELL","Nor Nomad Dwelling",4);
ensureItem("T4_VISION","Nor Vision Core",4);
ensureItem("T4_SHADOW","Nor Shadow Blade",4);

const T3C = {
  GATE:"T3_GATE", GOBLET:"T3_GOBLET", RING:"T3_RING", CHEST:"T3_CHEST", PILLAR:"T3_PILLAR",
  BAG:"T3_BAG", TENT:"T3_TENT", ORB:"T3_ORB", KNIFE:"T3_KNIFE", ARMOR:"T3_ARMOR"
};
ensureRecipe("R_T4_CORE","Nor Engine Core",4,"T4_CORE",[T3C.GATE,T3C.KNIFE,T3C.ARMOR,T3C.ORB]);
ensureRecipe("R_T4_LENS","Nor Crystal Lens",4,"T4_LENS",[T3C.ORB,T3C.RING,T3C.GOBLET,T3C.CHEST,T3C.PILLAR]);
ensureRecipe("R_T4_RGATE","Nor Reinforced Gate",4,"T4_RGATE",[T3C.GATE,T3C.CHEST,T3C.ARMOR,T3C.BAG]);
ensureRecipe("R_T4_RGOBLET","Nor Enruned Goblet",4,"T4_RGOBLET",[T3C.GOBLET,T3C.RING,T3C.PILLAR,T3C.BAG,T3C.TENT]);
ensureRecipe("R_T4_RCHEST","Nor Sealed Chest",4,"T4_RCHEST",[T3C.CHEST,T3C.PILLAR,T3C.BAG,T3C.TENT,T3C.ORB,T3C.KNIFE]);
ensureRecipe("R_T4_RPILLAR","Nor Monument Pillar",4,"T4_RPILLAR",[T3C.PILLAR,T3C.BAG,T3C.TENT,T3C.ORB]);
ensureRecipe("R_T4_SATCHEL","Nor Traveler Satchel",4,"T4_SATCHEL",[T3C.BAG,T3C.TENT,T3C.ORB,T3C.KNIFE,T3C.GATE]);
ensureRecipe("R_T4_DWELL","Nor Nomad Dwelling",4,"T4_DWELL",[T3C.TENT,T3C.ORB,T3C.KNIFE,T3C.GATE,T3C.ARMOR,T3C.GOBLET]);
ensureRecipe("R_T4_VISION","Nor Vision Core",4,"T4_VISION",[T3C.ORB,T3C.KNIFE,T3C.GATE,T3C.GOBLET,T3C.CHEST]);
ensureRecipe("R_T4_SHADOW","Nor Shadow Blade",4,"T4_SHADOW",[T3C.KNIFE,T3C.GATE,T3C.CHEST,T3C.ARMOR]);

// T5
ensureItem("T5_RELIC","Nor Ancient Relic",5);
ensureItem("T5_SUNLENS","Nor Sun Lens",5);
ensureItem("T5_GUARD_GATE","Nor Guardian Gate",5);
ensureItem("T5_CHALICE","Nor Wisdom Chalice",5);
ensureItem("T5_VAULT","Nor Royal Vault",5);
ensureItem("T5_COLOSSAL","Nor Colossal Pillar",5);
ensureItem("T5_WAYFARER","Nor Wayfarer Bag",5);
ensureItem("T5_HALL","Nor Nomad Hall",5);
ensureItem("T5_EYE","Nor Eye of Truth",5);
ensureItem("T5_NIGHT","Nor Nightfall Edge",5);

const T4C = {
  CORE:"T4_CORE", LENS:"T4_LENS", RGATE:"T4_RGATE", GOB:"T4_RGOBLET",
  CHEST:"T4_RCHEST", PILLAR:"T4_RPILLAR", SATCHEL:"T4_SATCHEL",
  DWELL:"T4_DWELL", VISION:"T4_VISION", SHADOW:"T4_SHADOW"
};
ensureRecipe("R_T5_RELIC","Nor Ancient Relic",5,"T5_RELIC",[T4C.CORE,T4C.LENS,T4C.GOB,T4C.CHEST]);
ensureRecipe("R_T5_SUNLENS","Nor Sun Lens",5,"T5_SUNLENS",[T4C.LENS,T4C.VISION,T4C.RGATE,T4C.PILLAR,T4C.SATCHEL]);
ensureRecipe("R_T5_GUARD_GATE","Nor Guardian Gate",5,"T5_GUARD_GATE",[T4C.RGATE,T4C.CORE,T4C.SATCHEL,T4C.DWELL]);
ensureRecipe("R_T5_CHALICE","Nor Wisdom Chalice",5,"T5_CHALICE",[T4C.GOB,T4C.LENS,T4C.PILLAR,T4C.SATCHEL,T4C.DWELL]);
ensureRecipe("R_T5_VAULT","Nor Royal Vault",5,"T5_VAULT",[T4C.CHEST,T4C.PILLAR,T4C.SATCHEL,T4C.DWELL,T4C.VISION,T4C.SHADOW]);
ensureRecipe("R_T5_COLOSSAL","Nor Colossal Pillar",5,"T5_COLOSSAL",[T4C.PILLAR,T4C.SATCHEL,T4C.DWELL,T4C.VISION]);
ensureRecipe("R_T5_WAYFARER","Nor Wayfarer Bag",5,"T5_WAYFARER",[T4C.SATCHEL,T4C.DWELL,T4C.VISION,T4C.SHADOW,T4C.RGATE]);
ensureRecipe("R_T5_HALL","Nor Nomad Hall",5,"T5_HALL",[T4C.DWELL,T4C.VISION,T4C.SHADOW,T4C.RGATE,T4C.GOB]);
ensureRecipe("R_T5_EYE","Nor Eye of Truth",5,"T5_EYE",[T4C.VISION,T4C.SHADOW,T4C.CORE,T4C.GOB,T4C.CHEST]);
ensureRecipe("R_T5_NIGHT","Nor Nightfall Edge",5,"T5_NIGHT",[T4C.SHADOW,T4C.RGATE,T4C.CHEST,T4C.CORE]);

// T6 artefact output (from special endpoint)
ensureItem("ARTEFACT","Artefact",6);

// -------- Auth
app.post("/api/register", async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
    if(!isValidPassword(password)) return res.status(400).json({ok:false,error:"Password must be at least 6 chars."});
    const ex=db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
    if(ex) return res.status(409).json({ok:false,error:"User already exists."});
    const pass=await bcrypt.hash(password,10);
    db.prepare("INSERT INTO users(email,pass_hash,created_at) VALUES (?,?,?)").run(email.toLowerCase(),pass,nowISO());
    res.json({ok:true});
  }catch{ res.status(500).json({ok:false,error:"Server error."}); }
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
    res.json({ok:true});
  }catch{ res.status(500).json({ok:false,error:"Server error."}); }
});
app.get("/api/logout",(req,res)=>{
  const t=verify(req); if(t) db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(),t.uid);
  res.clearCookie(TOKEN_NAME,{httpOnly:true,sameSite:"lax",secure:false});
  res.json({ok:true});
});
app.get("/api/me",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  const u=db.prepare("SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(t.uid);
  if(!u) { res.clearCookie(TOKEN_NAME); return res.status(401).json({ok:false}); }
  const g=Math.floor(u.balance_silver/100), s=u.balance_silver%100;
  const buysToNext=(u.next_recipe_at==null)?null:Math.max(0,u.next_recipe_at-(u.shop_buy_count||0));
  res.json({ok:true,user:{id:u.id,email:u.email,is_admin:!!u.is_admin,gold:g,silver:s,balance_silver:u.balance_silver,shop_buy_count:u.shop_buy_count,next_recipe_at:u.next_recipe_at,buys_to_next:buysToNext}});
});

// -------- Inventory
app.get("/api/my/inventory",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  const items=db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ui.qty
    FROM user_items ui JOIN items i ON i.id=ui.item_id
    WHERE ui.user_id=? AND ui.qty>0
    ORDER BY i.tier,i.name
  `).all(t.uid);
  const recipes=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0
    ORDER BY r.tier,r.name
  `).all(t.uid);
  res.json({ok:true,items,recipes});
});

// -------- Shop (T1 only)
const T1_CODES = T1.map(([c])=>c);
function nextRecipeInterval(){ return randInt(RECIPE_DROP_MIN, RECIPE_DROP_MAX); }
function pickWeightedRecipe(){
  // per 1000: T2 800 / T3 150 / T4 37 / T5 12 / T6 1
  const list = db.prepare(`SELECT id,code,name,tier FROM recipes`).all();
  if(!list.length) return null;
  const byTier={}; for(const r of list){ (byTier[r.tier]||(byTier[r.tier]=[])).push(r); }
  const roll=randInt(1,1000);
  let tier=2;
  if(roll===1000) tier=6;
  else if(roll>=988) tier=5;          // 12
  else if(roll>=951) tier=4;          // 37
  else if(roll>=801) tier=3;          // 150
  else tier=2;                        // 800
  while(tier>=2 && !byTier[tier]) tier--;
  if(!byTier[tier]) tier=2;
  const arr=byTier[tier];
  return arr[Math.floor(Math.random()*arr.length)];
}

app.post("/api/shop/buy-t1",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const out=db.transaction(()=>{
      const u=db.prepare("SELECT id,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(t.uid);
      if(u.balance_silver<SHOP_T1_COST_S) throw new Error("Insufficient funds.");
      // pay
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(SHOP_T1_COST_S,u.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(u.id,-SHOP_T1_COST_S,"SHOP_BUY_T1",null,nowISO());

      // init recipe target
      if(u.next_recipe_at==null){
        const first = u.shop_buy_count + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(first,u.id);
        u.next_recipe_at = first;
      }

      const willDrop = (u.shop_buy_count+1) >= u.next_recipe_at;
      let addedItem=null, grantedRecipe=null;

      if(willDrop){
        const pick=pickWeightedRecipe();
        if(pick){
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
            VALUES (?,?,1,0)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+1
          `).run(u.id,pick.id);
          grantedRecipe = {id:pick.id,code:pick.code,name:pick.name,tier:pick.tier};
        }
        const nextAt = (u.shop_buy_count+1) + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(nextAt,u.id);
      }else{
        const code=T1_CODES[Math.floor(Math.random()*T1_CODES.length)];
        const iid=idByCode(code);
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(u.id,iid);
        const row=db.prepare("SELECT code,name FROM items WHERE id=?").get(iid);
        addedItem=row;
      }

      db.prepare("UPDATE users SET shop_buy_count=shop_buy_count+1 WHERE id=?").run(u.id);
      const bal=db.prepare("SELECT balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(u.id);
      const gold=Math.floor(bal.balance_silver/100), silver=bal.balance_silver%100;
      const buysToNext=(bal.next_recipe_at==null)?null:Math.max(0,bal.next_recipe_at-(bal.shop_buy_count||0));
      return {ok:true,result_type: willDrop?"RECIPE":"ITEM",addedItem,grantedRecipe,gold,silver,balance_silver:bal.balance_silver,buys_to_next:buysToNext};
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// -------- Recipes & Crafting
app.get("/api/my/recipes",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  const rows=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty,ur.attempts
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0
    ORDER BY r.tier,r.name
  `).all(t.uid);
  res.json({ok:true,recipes:rows});
});

app.get("/api/recipes/:id",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  const rid = parseInt(req.params.id,10);
  const rec=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,r.output_item_id,COALESCE(ur.qty,0) have_qty,COALESCE(ur.attempts,0) attempts
    FROM recipes r LEFT JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
    WHERE r.id=?
  `).get(t.uid,rid);
  if(!rec || !rec.have_qty) return res.status(404).json({ok:false,error:"You don't own this recipe."});
  const ings=db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ri.qty need_qty,COALESCE(ui.qty,0) have_qty
    FROM recipe_ingredients ri JOIN items i ON i.id=ri.item_id
    LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ri.recipe_id=?
    ORDER BY i.tier,i.name
  `).all(t.uid,rid);
  const view=ings.map(x=>({ item_id:x.id, code:x.code, name:x.name, tier:x.tier, need_qty:x.need_qty, have_qty:x.have_qty, missing:Math.max(0,x.need_qty-x.have_qty)}));
  const can_craft=view.every(v=>v.have_qty>=v.need_qty);
  res.json({ok:true,recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier,attempts:rec.attempts,output_item_id:rec.output_item_id},ingredients:view,can_craft});
});

app.post("/api/recipes/:id/craft",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false,error:"Not logged in."});
  const rid=parseInt(req.params.id,10);
  try{
    const out=db.transaction(()=>{
      const rec=db.prepare(`
        SELECT r.id,r.code,r.name,r.tier,r.output_item_id,COALESCE(ur.qty,0) have_qty,COALESCE(ur.attempts,0) attempts
        FROM recipes r LEFT JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
        WHERE r.id=?
      `).get(t.uid,rid);
      if(!rec || !rec.have_qty) throw new Error("Recipe not available.");

      const ings=db.prepare(`
        SELECT i.id,i.code,i.name,ri.qty need_qty,COALESCE(ui.qty,0) have_qty
        FROM recipe_ingredients ri JOIN items i ON i.id=ri.item_id
        LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
        WHERE ri.recipe_id=?
      `).all(t.uid,rid);
      for(const ig of ings){ if(ig.have_qty<ig.need_qty) throw new Error("Missing "+ig.code); }

      // consume
      for(const ig of ings){
        db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(ig.need_qty,t.uid,ig.id);
      }
      // attempts up to 5
      db.prepare("UPDATE user_recipes SET attempts=MIN(attempts+1,5) WHERE user_id=? AND recipe_id=?").run(t.uid,rec.id);

      const outTier=db.prepare("SELECT tier FROM items WHERE id=?").get(rec.output_item_id)?.tier||rec.tier;
      const failP = outTier>=6 ? 0.0 : 0.10; // T6 never fails
      if(Math.random()<failP){
        const scrap=idByCode("SCRAP");
        db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                    ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(t.uid,scrap);
        return {ok:true,crafted:false,scrap:true,msg:"Craft failed -> Scrap"};
      }else{
        // consume recipe use
        const changed = db.prepare("UPDATE user_recipes SET qty=qty-1 WHERE user_id=? AND recipe_id=? AND qty>0").run(t.uid,rec.id).changes;
        if(changed===0) throw new Error("No recipe left.");
        db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                    ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(t.uid,rec.output_item_id);
        const outItem=db.prepare("SELECT code,name,tier FROM items WHERE id=?").get(rec.output_item_id);
        return {ok:true,crafted:true,output:outItem,msg:`Crafted: ${outItem.name} [T${outItem.tier}]`};
      }
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Special: Artefact from 10 distinct T5 items
app.post("/api/craft/artefact",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  try{
    const out=db.transaction(()=>{
      const t5=db.prepare(`
        SELECT i.id,i.name,ui.qty
        FROM user_items ui JOIN items i ON i.id=ui.item_id
        WHERE ui.user_id=? AND ui.qty>0 AND i.tier=5
        ORDER BY i.name
      `).all(t.uid);
      if(t5.length<10) throw new Error("You need at least 10 different T5 items.");
      const picked = t5.slice(0,10);
      for(const p of picked){ db.prepare("UPDATE user_items SET qty=qty-1 WHERE user_id=? AND item_id=?").run(t.uid,p.id); }
      const outId=idByCode("ARTEFACT");
      db.prepare(`INSERT INTO user_items(user_id,item_id,qty)
                  VALUES (?,?,1)
                  ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(t.uid,outId);
      const outItem=db.prepare("SELECT code,name,tier FROM items WHERE id=?").get(outId);
      return {ok:true,crafted:true,output:outItem,msg:`Crafted: ${outItem.name}`};
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// -------- Sales (fixed price) – reuse auctions infra

function findByCode(code){
  if(!code) return null;
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
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  const { code, qty=1, price_gold=0, price_silver=0 } = req.body||{};
  const look = findByCode((code||"").trim());
  if(!look) return res.status(400).json({ok:false,error:"Unknown code"});
  const q=Math.max(1,Math.trunc(qty));
  let price_s = Math.trunc(price_gold||0)*100 + Math.trunc(price_silver||0);
  if(price_s<=0) return res.status(400).json({ok:false,error:"Price must be > 0."});
  try{
    const out = db.transaction(()=>{
      if(look.kind==="item"){
        const r=db.prepare("SELECT qty FROM user_items WHERE user_id=? AND item_id=?").get(t.uid,look.it.id);
        if(!r || r.qty<q) throw new Error("Not enough items.");
        db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(q,t.uid,look.it.id);
      }else{
        const r=db.prepare("SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?").get(t.uid,look.rec.id);
        if(!r || r.qty<q) throw new Error("Not enough recipes.");
        db.prepare("UPDATE user_recipes SET qty=qty-? WHERE user_id=? AND recipe_id=?").run(q,t.uid,look.rec.id);
      }
      const now=nowISO();
      // fixed price via start_price_s and buy_now_price_s (same)
      db.prepare(`
        INSERT INTO auctions(
          seller_user_id,type,item_id,recipe_id,qty,title,description,
          start_price_s,buy_now_price_s,highest_bid_s,highest_bidder_user_id,fee_bps,
          status,start_time,end_time,created_at
        ) VALUES (?,?,?,?,?,?,?, ?,?,?,NULL,?, 'live', ?, ?, ?)
      `).run(
        t.uid,
        look.kind,
        look.kind==="item"?look.it.id:null,
        look.kind==="recipe"?look.rec.id:null,
        q,
        look.kind==="item"?look.it.code:look.rec.code,
        null,
        price_s, price_s, null,
        SALES_FEE_BPS,
        now, addMinutes(now, 365*24*60), now // far future "end"
      );
      const aid=db.prepare("SELECT last_insert_rowid() id").get().id;
      db.prepare(`INSERT INTO inventory_escrow(auction_id,owner_user_id,item_id,recipe_id,qty,created_at)
                  VALUES (?,?,?,?,?,?)`)
        .run(aid,t.uid,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,now);

      const a=db.prepare(`
        SELECT a.id,a.qty,a.start_price_s,COALESCE(i.code,r.code) code,COALESCE(i.name,r.name) name
        FROM auctions a LEFT JOIN items i ON i.id=a.item_id LEFT JOIN recipes r ON r.id=a.recipe_id
        WHERE a.id=?`).get(aid);
      return {ok:true,listing:a};
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Live marketplace (optional ?q=search)
app.get("/api/sales/live",(req,res)=>{
  const q = (req.query.q||"").trim().toLowerCase();
  let rows = db.prepare(`
    SELECT a.id,a.type,a.qty,a.start_price_s,a.status,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name
    FROM auctions a
    LEFT JOIN items i ON i.id=a.item_id
    LEFT JOIN recipes r ON r.id=a.recipe_id
    WHERE a.status='live'
    ORDER BY a.id DESC
  `).all();
  if(q){
    rows = rows.filter(x=> (x.name||"").toLowerCase().includes(q) || (x.code||"").toLowerCase().includes(q));
  }
  res.json({ok:true,listings:rows});
});

// My listings
app.get("/api/sales/mine",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  const rows = db.prepare(`
    SELECT a.id,a.type,a.qty,a.start_price_s,a.status,a.sold_price_s,a.winner_user_id,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name
    FROM auctions a
    LEFT JOIN items i ON i.id=a.item_id
    LEFT JOIN recipes r ON r.id=a.recipe_id
    WHERE a.seller_user_id=?
    ORDER BY a.id DESC
  `).all(t.uid);
  res.json({ok:true,listings:rows});
});

// Buy (fixed price)
app.post("/api/sales/:id/buy",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  const aid = parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const a=db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if(!a || a.status!=="live") throw new Error("Listing not available.");
      if(a.seller_user_id===t.uid) throw new Error("Can't buy your own listing.");
      const buyer=db.prepare("SELECT id,balance_silver FROM users WHERE id=?").get(t.uid);
      const price = a.start_price_s;
      if(buyer.balance_silver<price) throw new Error("Insufficient funds.");

      // deduct buyer
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(price,buyer.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(buyer.id,-price,"SALE_BUY","auction:"+a.id,nowISO());

      const fee = Math.floor(price*SALES_FEE_BPS/10000);
      const net = price - fee;

      // credit seller
      db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(net,a.seller_user_id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(a.seller_user_id,net,"SALE_NET","auction:"+a.id,nowISO());

      // deliver from escrow
      const esc=db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if(esc){
        if(esc.item_id){
          db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`)
            .run(buyer.id,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`)
            .run(buyer.id,esc.recipe_id,esc.qty);
        }
      }
      db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);
      db.prepare("UPDATE auctions SET status='paid',sold_price_s=?,winner_user_id=? WHERE id=?").run(price,buyer.id,a.id);

      const bal=db.prepare("SELECT balance_silver FROM users WHERE id=?").get(buyer.id).balance_silver;
      return {ok:true,buyer_gold:Math.floor(bal/100),buyer_silver:bal%100};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Cancel my listing (only if still live)
app.post("/api/sales/:id/cancel",(req,res)=>{
  const t=verify(req); if(!t) return res.status(401).json({ok:false});
  const aid=parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const a=db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if(!a || a.seller_user_id!==t.uid) throw new Error("Not your listing.");
      if(a.status!=="live") throw new Error("Already finished.");

      const esc=db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if(esc){
        if(esc.item_id){
          db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`)
            .run(t.uid,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`)
            .run(t.uid,esc.recipe_id,esc.qty);
        }
      }
      db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);
      db.prepare("UPDATE auctions SET status='canceled' WHERE id=?").run(a.id);
      return {ok:true};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// -------- Admin page route (no link in UI)
app.get("/admin",(req,res)=> res.sendFile(path.join(__dirname,"public","admin.html")));

// -------- Health
app.get("/api/health",(req,res)=> res.json({ok:true,db_path:DB_PATH,data_dir:DATA_DIR}));

// -------- Start
server.listen(PORT, HOST, ()=>{
  console.log(`ARTEFACT server on http://${HOST}:${PORT}`);
  console.log(`DB -> ${DB_PATH}`);
});
