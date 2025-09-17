// ==============================================
// ARTEFACT • Server (Node/Express + SQLite, JWT auth)
// - DB path: /data/artefact.db   (Render Persistent Disk)
// - Auth: register/login/logout/me
// - Shop: buy T1 (1g) → T1 item OR recipe drop (approx every 4–8 buys)
//          Weighted recipe drop per 1000: T2=800, T3=150, T4=37, T5=12, T6=1
// - Crafting: craft by recipes (10% fail => Scrap; Tier 6 = 0% fail)
// - Special craft: ARTEFACT from 10 DISTINCT T5 items (no fail)
// - Sales: fixed-price listings (item/recipe) with escrow (no bids)
// ==============================================

const express = require("express");
const http = require("http");
const path = require("path");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ---------- Config
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN_NAME = "token";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// Persistent disk (/data on Render)
const DATA_DIR = process.env.DATA_DIR || "/data";
const DB_PATH = path.join(DATA_DIR, "artefact.db");

// Economy
const SHOP_T1_COST_S = 100;        // 1 gold = 100 silver
const RECIPE_DROP_MIN = 4;         // every 4–8 buys you drop a recipe
const RECIPE_DROP_MAX = 8;

// ---------- App
const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"))); // serves index.html

// ---------- DB
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ---------- Helpers
const nowISO = () => new Date().toISOString();
const randInt = (a,b) => a + Math.floor(Math.random()*(b-a+1));
const add = (o,k,v)=>{ o[k]=(o[k]||0)+v; return o; };

function isValidEmail(e){ return typeof e==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.toLowerCase()); }
function isValidPassword(p){ return typeof p==="string" && p.length>=6; }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function verifyTokenFromCookies(req){
  const t = req.cookies && req.cookies[TOKEN_NAME];
  if (!t) return null;
  try{ return jwt.verify(t, JWT_SECRET); }catch{ return null; }
}

// ---------- Schema
function ensureTable(sql){ db.exec(sql); }
function ensureColumn(table, columnDef){
  const name = columnDef.split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if(!cols.some(c=>c.name===name)){
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}

ensureTable(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  balance_silver INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  shop_buy_count INTEGER NOT NULL DEFAULT 0,
  next_recipe_at INTEGER
);`);

ensureTable(`
CREATE TABLE IF NOT EXISTS gold_ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta_s INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);`);

ensureTable(`
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  volatile INTEGER NOT NULL DEFAULT 0
);`);
ensureTable(`
CREATE TABLE IF NOT EXISTS user_items(
  user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,item_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(item_id) REFERENCES items(id)
);`);

ensureTable(`
CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  output_item_id INTEGER NOT NULL,
  FOREIGN KEY(output_item_id) REFERENCES items(id)
);`);
ensureTable(`
CREATE TABLE IF NOT EXISTS recipe_ingredients(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  FOREIGN KEY(recipe_id) REFERENCES recipes(id),
  FOREIGN KEY(item_id) REFERENCES items(id)
);`);
ensureTable(`
CREATE TABLE IF NOT EXISTS user_recipes(
  user_id INTEGER NOT NULL,
  recipe_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,recipe_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(recipe_id) REFERENCES recipes(id)
);`);

/* Sales (fixed price) + escrow */
ensureTable(`
CREATE TABLE IF NOT EXISTS sales(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,              -- 'item'|'recipe'
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  price_s INTEGER NOT NULL,        -- 100s = 1g
  fee_bps INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL,            -- 'live'|'paid'|'canceled'
  start_time TEXT NOT NULL,
  end_time TEXT,
  sold_price_s INTEGER,
  buyer_user_id INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (seller_user_id) REFERENCES users(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (recipe_id) REFERENCES recipes(id),
  FOREIGN KEY (buyer_user_id) REFERENCES users(id)
);`);

ensureTable(`
CREATE TABLE IF NOT EXISTS inventory_escrow(
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

// ---------- Seed helpers
function ensureItem(code,name,tier,volatile=0){
  const r=db.prepare("SELECT id FROM items WHERE code=?").get(code);
  if(r){ db.prepare("UPDATE items SET name=?,tier=?,volatile=? WHERE code=?").run(name,tier,volatile,code); return r.id; }
  db.prepare("INSERT INTO items(code,name,tier,volatile) VALUES (?,?,?,?)").run(code,name,tier,volatile);
  return db.prepare("SELECT id FROM items WHERE code=?").get(code).id;
}
function idByCode(code){ const r=db.prepare("SELECT id FROM items WHERE code=?").get(code); return r&&r.id; }
function ensureRecipe(code,name,tier,outCode,ingCodes){
  const outId=idByCode(outCode); if(!outId) throw new Error("Missing item "+outCode);
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
    const iid=idByCode(c); if(!iid) throw new Error("Missing ingredient item "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,?)").run(rid,iid,1);
  }
  return rid;
}

// ---------- Items & Recipes

// Volatile scrap
ensureItem("SCRAP","Scrap",1,1);

// T1 materials (10)
const T1 = [
  ["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]
];
for(const [c,n] of T1) ensureItem(c,n,1,0);

// T2 (10) – 4–7 unique T1
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

// T3 (10) – 4–7 unique T2
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

const T2C = {
  DOOR:"T2_BRONZE_DOOR", GOBLET:"T2_SILVER_GOBLET", RING:"T2_GOLDEN_RING",
  CHEST:"T2_WOODEN_CHEST", PILLAR:"T2_STONE_PILLAR", BAG:"T2_LEATHER_BAG",
  TENT:"T2_CLOTH_TENT", ORB:"T2_CRYSTAL_ORB", KNIFE:"T2_OBSIDIAN_KNIFE", ARMOR:"T2_IRON_ARMOR"
};
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

// T4 (10) – 4–7 unique T3
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

// T5 (10) – 4–7 unique T4
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

// T6 item for reward
ensureItem("ARTEFACT","Artefact",6);

// ---------- AUTH
app.post("/api/register", async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
    if(!isValidPassword(password)) return res.status(400).json({ok:false,error:"Password must be at least 6 chars."});
    const ex=db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email);
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
    const u=db.prepare("SELECT id,email,pass_hash,is_disabled FROM users WHERE lower(email)=lower(?)").get(email||"");
    if(!u) return res.status(404).json({ok:false,error:"User not found."});
    if(u.is_disabled) return res.status(403).json({ok:false,error:"Account disabled."});
    const ok=await bcrypt.compare(password||"",u.pass_hash);
    if(!ok) return res.status(401).json({ok:false,error:"Wrong password."});
    const token=signToken(u);
    res.cookie(TOKEN_NAME,token,{httpOnly:true,sameSite:"lax",secure:false,maxAge:7*24*3600*1000});
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
  const r=db.prepare("SELECT id,email,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(u.uid);
  if(!r) return res.status(401).json({ok:false});
  const g=Math.floor((r.balance_silver||0)/100), s=(r.balance_silver||0)%100;
  const buysToNext=(r.next_recipe_at==null)?null:Math.max(0,(r.next_recipe_at)-(r.shop_buy_count||0));
  res.json({ok:true,user:{ id:r.id,email:r.email, gold:g,silver:s, balance_silver:r.balance_silver,
    shop_buy_count:r.shop_buy_count,next_recipe_at:r.next_recipe_at,buys_to_next:buysToNext }});
});

// ---------- SHOP
const T1_CODES = T1.map(([code])=>code);
function nextRecipeInterval(){ return randInt(RECIPE_DROP_MIN, RECIPE_DROP_MAX); }
function pickWeightedRecipe(){
  const all=db.prepare("SELECT id,code,name,tier FROM recipes").all();
  if(!all.length) return null;
  const groups = all.reduce((m,r)=>add(m,r.tier,[r]) , {});
  const roll = randInt(1,1000);
  let target;
  if(roll===1000) target=6;       // 1
  else if(roll>=988) target=5;    // 12
  else if(roll>=951) target=4;    // 37
  else if(roll>=801) target=3;    // 150
  else target=2;                  // 800
  while(target>=2 && !groups[target]) target--;
  const arr = groups[target] || groups[2];
  return arr[Math.floor(Math.random()*arr.length)];
}

app.post("/api/shop/buy-t1",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const result=db.transaction(()=>{
      const u=db.prepare("SELECT id,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(tok.uid);
      if(!u) throw new Error("Session expired.");
      if(u.balance_silver < SHOP_T1_COST_S) throw new Error("Insufficient funds.");

      // pay
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(SHOP_T1_COST_S,u.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(u.id,-SHOP_T1_COST_S,"SHOP_BUY_T1",null,nowISO());

      // init schedule if missing
      if(u.next_recipe_at==null){
        const first = u.shop_buy_count + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(first,u.id);
        u.next_recipe_at = first;
      }

      const willDrop = (u.shop_buy_count + 1) >= u.next_recipe_at;
      let addedItem=null, grantedRecipe=null;

      if(willDrop){
        const pick = pickWeightedRecipe();
        if(pick){
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
            VALUES (?,?,1,0)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+1
          `).run(u.id,pick.id);
          grantedRecipe = { id:pick.id, code:pick.code, name:pick.name, tier:pick.tier };
          db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
            .run(u.id,0,"RECIPE_DROP","recipe:"+pick.code,nowISO());
        }
        const nextAt = (u.shop_buy_count + 1) + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(nextAt,u.id);
      }else{
        const code = T1_CODES[Math.floor(Math.random()*T1_CODES.length)];
        const iid = idByCode(code);
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(u.id,iid);
        const it=db.prepare("SELECT code,name FROM items WHERE id=?").get(iid);
        addedItem = it;
      }

      db.prepare("UPDATE users SET shop_buy_count=shop_buy_count+1 WHERE id=?").run(u.id);

      const bal=db.prepare("SELECT balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(u.id);
      const buysToNext=(bal.next_recipe_at==null)?null:Math.max(0,bal.next_recipe_at-bal.shop_buy_count);

      return {
        ok:true,
        result_type: willDrop ? "RECIPE" : "ITEM",
        addedItem, grantedRecipe,
        balance_silver: bal.balance_silver,
        gold: Math.floor(bal.balance_silver/100),
        silver: bal.balance_silver%100,
        shop_buy_count: bal.shop_buy_count,
        buys_to_next: buysToNext
      };
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// ---------- RECIPES / CRAFT
app.get("/api/my/recipes",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false});
  const rows=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty,ur.attempts
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0
    ORDER BY r.tier ASC, r.name ASC
  `).all(tok.uid);
  res.json({ok:true,recipes:rows});
});
app.get("/api/recipes/:id",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false});
  const rid=parseInt(req.params.id,10);
  const rec=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,r.output_item_id,COALESCE(ur.qty,0) have_qty,COALESCE(ur.attempts,0) attempts
    FROM recipes r LEFT JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
    WHERE r.id=?
  `).get(tok.uid,rid);
  if(!rec || !rec.have_qty) return res.status(404).json({ok:false,error:"You don't own this recipe."});
  const ings=db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ri.qty need_qty,COALESCE(ui.qty,0) have_qty
    FROM recipe_ingredients ri JOIN items i ON i.id=ri.item_id
    LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ri.recipe_id=?
    ORDER BY i.tier ASC, i.name ASC
  `).all(tok.uid,rid);
  const enriched=ings.map(x=>({ item_id:x.id, code:x.code, name:x.name, tier:x.tier,
    need_qty:x.need_qty, have_qty:x.have_qty, missing:Math.max(0,x.need_qty-x.have_qty)}));
  const can_craft=enriched.every(x=>x.have_qty>=x.need_qty);
  res.json({ ok:true, recipe:{ id:rec.id,code:rec.code,name:rec.name,tier:rec.tier,attempts:rec.attempts,output_item_id:rec.output_item_id }, ingredients:enriched, can_craft });
});
app.post("/api/recipes/:id/craft",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  const rid=parseInt(req.params.id,10);
  try{
    const out=db.transaction(()=>{
      const rec=db.prepare(`
        SELECT r.id,r.code,r.name,r.tier,r.output_item_id,COALESCE(ur.qty,0) have_qty,COALESCE(ur.attempts,0) attempts
        FROM recipes r LEFT JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
        WHERE r.id=?
      `).get(tok.uid,rid);
      if(!rec||!rec.have_qty) throw new Error("You don't own this recipe.");

      const ings=db.prepare(`
        SELECT i.id,i.code,i.name,ri.qty need_qty,COALESCE(ui.qty,0) have_qty
        FROM recipe_ingredients ri JOIN items i ON i.id=ri.item_id
        LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
        WHERE ri.recipe_id=?
      `).all(tok.uid,rid);
      for(const ing of ings){ if(ing.have_qty<ing.need_qty) throw new Error("Missing: "+ing.code+" x"+(ing.need_qty-ing.have_qty)); }
      for(const ing of ings){ db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(ing.need_qty,tok.uid,ing.id); }

      db.prepare("UPDATE user_recipes SET attempts = MIN(attempts + 1, 5) WHERE user_id=? AND recipe_id=?").run(tok.uid, rec.id);

      const outTierRow = db.prepare("SELECT tier FROM items WHERE id=?").get(rec.output_item_id);
      const outTier = outTierRow ? (outTierRow.tier|0) : rec.tier;
      const failP = (outTier >= 6) ? 0.0 : 0.10; // T6 no fail
      const roll=Math.random();

      if(roll<failP){
        const scrap=idByCode("SCRAP");
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(tok.uid,scrap);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
          .run(tok.uid,0,"CRAFT_FAIL","recipe:"+rec.code,nowISO());
        return { ok:true, crafted:false, scrap:true, recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier} };
      }else{
        const ch = db.prepare("UPDATE user_recipes SET qty=qty-1 WHERE user_id=? AND recipe_id=? AND qty>0").run(tok.uid,rec.id).changes;
        if(ch===0) throw new Error("Recipe not available any more.");
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(tok.uid,rec.output_item_id);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
          .run(tok.uid,0,"CRAFT_SUCCESS","recipe:"+rec.code,nowISO());
        const outItem=db.prepare("SELECT code,name,tier FROM items WHERE id=?").get(rec.output_item_id);
        return { ok:true, crafted:true, scrap:false, output:outItem, recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier} };
      }
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Special craft: Artefact from 10 distinct T5
app.post("/api/craft/artefact",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const out=db.transaction(()=>{
      const have=db.prepare(`
        SELECT i.id,i.code,i.name,ui.qty
        FROM items i JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
        WHERE i.tier=5 AND ui.qty>0
        ORDER BY i.name ASC
      `).all(tok.uid);
      if(have.length<10) throw new Error("You need at least 10 different T5 items.");
      const use = have.slice(0,10);
      use.forEach(it=>{
        db.prepare("UPDATE user_items SET qty=qty-1 WHERE user_id=? AND item_id=?").run(tok.uid,it.id);
      });
      const art=idByCode("ARTEFACT");
      db.prepare(`
        INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
        ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
      `).run(tok.uid,art);
      return { ok:true, crafted:true, output:{ code:"ARTEFACT", name:"Artefact", tier:6 } };
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Inventory helper
app.get("/api/my/inventory",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false});
  const items=db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,COALESCE(ui.qty,0) qty
    FROM items i JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ui.qty>0 ORDER BY i.tier ASC,i.name ASC
  `).all(tok.uid);
  const recipes=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,COALESCE(ur.qty,0) qty
    FROM recipes r JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
    WHERE ur.qty>0 ORDER BY r.tier ASC,r.name ASC
  `).all(tok.uid);
  res.json({ok:true,items,recipes});
});

// ---------- SALES (fixed price)
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

app.post("/api/sales/create",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  const {code,qty=1,price_gold=0,price_silver=0}=req.body||{};
  const amount_s = Math.trunc(price_gold||0)*100 + Math.trunc(price_silver||0);
  if(!code || amount_s<=0) return res.status(400).json({ok:false,error:"Bad params."});
  const q = Math.max(1, Math.trunc(qty));
  const look=findItemOrRecipeByCode(String(code).trim());
  if(!look) return res.status(400).json({ok:false,error:"Unknown code."});
  try{
    const out=db.transaction(()=>{
      if(look.kind==="item"){
        const r=db.prepare("SELECT qty FROM user_items WHERE user_id=? AND item_id=?").get(tok.uid,look.it.id);
        if(!r||r.qty<q) throw new Error("Not enough items.");
        db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(q,tok.uid,look.it.id);
      }else{
        const r=db.prepare("SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?").get(tok.uid,look.rec.id);
        if(!r||r.qty<q) throw new Error("Not enough recipes.");
        db.prepare("UPDATE user_recipes SET qty=qty-? WHERE user_id=? AND recipe_id=?").run(q,tok.uid,look.rec.id);
      }
      const now=nowISO();
      db.prepare(`
        INSERT INTO sales(seller_user_id,type,item_id,recipe_id,qty,price_s,fee_bps,status,start_time,created_at)
        VALUES (?,?,?,?,?,?,100,'live',?,?)
      `).run(tok.uid,look.kind,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,amount_s,now,now);
      const sid=db.prepare("SELECT last_insert_rowid() id").get().id;
      db.prepare(`
        INSERT INTO inventory_escrow(sale_id,owner_user_id,item_id,recipe_id,qty,created_at)
        VALUES (?,?,?,?,?,?)
      `).run(sid,tok.uid,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,now);
      const row=db.prepare(`
        SELECT s.id,s.type,s.qty,s.price_s,COALESCE(i.code,r.code) code,COALESCE(i.name,r.name) name
        FROM sales s
        LEFT JOIN items i ON i.id=s.item_id
        LEFT JOIN recipes r ON r.id=s.recipe_id
        WHERE s.id=?
      `).get(sid);
      return {ok:true,sale:row};
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

app.get("/api/sales/live",(req,res)=>{
  const rows=db.prepare(`
    SELECT s.id,s.type,s.qty,s.price_s,s.status,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name
    FROM sales s
    LEFT JOIN items i ON i.id=s.item_id
    LEFT JOIN recipes r ON r.id=s.recipe_id
    WHERE s.status='live'
    ORDER BY s.id DESC
  `).all();
  res.json({ok:true,sales:rows});
});
app.get("/api/sales/mine",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false});
  const rows=db.prepare(`
    SELECT s.id,s.type,s.qty,s.price_s,s.status,s.sold_price_s,s.buyer_user_id,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name
    FROM sales s
    LEFT JOIN items i ON i.id=s.item_id
    LEFT JOIN recipes r ON r.id=s.recipe_id
    WHERE s.seller_user_id=?
    ORDER BY s.id DESC
  `).all(tok.uid);
  res.json({ok:true,sales:rows});
});
app.post("/api/sales/:id/buy",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  const sid=parseInt(req.params.id,10);
  try{
    const out=db.transaction(()=>{
      const s=db.prepare("SELECT * FROM sales WHERE id=?").get(sid);
      if(!s || s.status!=='live') throw new Error("Sale not available.");
      if(s.seller_user_id===tok.uid) throw new Error("Can't buy your own listing.");
      const buyer=db.prepare("SELECT id,balance_silver FROM users WHERE id=?").get(tok.uid);
      if(buyer.balance_silver < s.price_s) throw new Error("Insufficient funds.");
      const fee = Math.floor((s.price_s*s.fee_bps)/10000);
      const net = s.price_s - fee;

      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(s.price_s,buyer.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(buyer.id,-s.price_s,"SALE_BUY","sale:"+s.id,nowISO());

      db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(net,s.seller_user_id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(s.seller_user_id,net,"SALE_NET","sale:"+s.id,nowISO());

      const esc=db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE sale_id=?").get(s.id);
      if(esc){
        if(esc.item_id){
          db.prepare(`
            INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
            ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty
          `).run(buyer.id,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty
          `).run(buyer.id,esc.recipe_id,esc.qty);
        }
      }
      db.prepare("DELETE FROM inventory_escrow WHERE sale_id=?").run(s.id);
      db.prepare("UPDATE sales SET status='paid',sold_price_s=?,buyer_user_id=? WHERE id=?")
        .run(s.price_s,buyer.id,s.id);

      const bal = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(buyer.id).balance_silver;
      return { ok:true, buyer_balance_silver: bal, buyer_gold: Math.floor(bal/100), buyer_silver: bal%100 };
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.post("/api/sales/:id/cancel",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false,error:"Not logged in."});
  const sid=parseInt(req.params.id,10);
  try{
    const out=db.transaction(()=>{
      const s=db.prepare("SELECT * FROM sales WHERE id=?").get(sid);
      if(!s || s.status!=='live') throw new Error("Sale not active.");
      if(s.seller_user_id!==tok.uid) throw new Error("Not your listing.");
      const esc=db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE sale_id=?").get(s.id);
      if(esc){
        if(esc.item_id){
          db.prepare(`
            INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
            ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty
          `).run(tok.uid,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty
          `).run(tok.uid,esc.recipe_id,esc.qty);
        }
      }
      db.prepare("DELETE FROM inventory_escrow WHERE sale_id=?").run(s.id);
      db.prepare("UPDATE sales SET status='canceled' WHERE id=?").run(s.id);
      return { ok:true };
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// ---------- HEALTH
app.get("/api/health",(req,res)=>{
  res.json({ ok:true, db_path: DB_PATH, data_dir: DATA_DIR });
});

// ---------- START
server.listen(PORT, HOST, ()=>{
  console.log(`Server on http://${HOST}:${PORT}  DB:${DB_PATH}`);
});
