// ARTEFACT • Server (Express + SQLite)
// Auth (JWT cookie), Shop (T1 only + weighted recipe drop 800/150/37/12/1, every 4–8 buys),
// Crafting (10% fail -> SCRAP, T6 no fail, Artefact = 10 different T5),
// Auctions (create/live/mine/bid/buy-now/cancel, my-bids + cancel-bid),
// Admin endpoints (separate /admin page), Static from /public.

const express = require("express");
const http = require("http");
const path = require("path");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || "admin@example.com").toLowerCase();
const TOKEN_NAME = "token";

// Economy
const SHOP_T1_COST_S = 100;  // 1g
const AUCTION_FEE_BPS = 100; // 1%
const RECIPE_DROP_MIN = 4, RECIPE_DROP_MAX = 8;

const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const DB_PATH = path.join(__dirname, "artefact.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// --- helpers
const nowISO = () => new Date().toISOString();
const addMinutes = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const isValidEmail = e => typeof e==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.toLowerCase());
const isValidPassword = p => typeof p==="string" && p.length>=6;
const signToken = u => jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" });
function verifyToken(req){ const t=req.cookies && req.cookies[TOKEN_NAME]; if(!t) return null; try{return jwt.verify(t,JWT_SECRET);}catch{return null;} }
function isAdminRequest(req){
  const hdr=(req.headers["x-admin-key"]||req.headers["X-Admin-Key"]||"")+"";
  if(hdr===String(ADMIN_KEY)) return true;
  const tok=verifyToken(req); if(!tok) return false;
  const r=db.prepare("SELECT is_admin FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin===1);
}

// --- schema
function exec(sql){ db.exec(sql); }
exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
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
  user_id INTEGER NOT NULL, delta_s INTEGER NOT NULL,
  reason TEXT NOT NULL, ref TEXT, created_at TEXT NOT NULL
);`);
exec(`CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  tier INTEGER NOT NULL, volatile INTEGER NOT NULL DEFAULT 0
);`);
exec(`CREATE TABLE IF NOT EXISTS user_items(
  user_id INTEGER NOT NULL, item_id INTEGER NOT NULL, qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,item_id)
);`);
exec(`CREATE TABLE IF NOT EXISTS recipes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  tier INTEGER NOT NULL, output_item_id INTEGER NOT NULL
);`);
exec(`CREATE TABLE IF NOT EXISTS recipe_ingredients(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id INTEGER NOT NULL, item_id INTEGER NOT NULL, qty INTEGER NOT NULL
);`);
exec(`CREATE TABLE IF NOT EXISTS user_recipes(
  user_id INTEGER NOT NULL, recipe_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,recipe_id)
);`);
exec(`CREATE TABLE IF NOT EXISTS auctions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  type TEXT NOT NULL, -- item|recipe
  item_id INTEGER, recipe_id INTEGER, qty INTEGER NOT NULL DEFAULT 1,
  title TEXT, description TEXT,
  start_price_s INTEGER NOT NULL, buy_now_price_s INTEGER,
  highest_bid_s INTEGER, highest_bidder_user_id INTEGER,
  fee_bps INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL, -- live|paid|canceled
  start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  sold_price_s INTEGER, winner_user_id INTEGER, created_at TEXT NOT NULL
);`);
exec(`CREATE TABLE IF NOT EXISTS bids(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL, bidder_user_id INTEGER NOT NULL,
  amount_s INTEGER NOT NULL, created_at TEXT NOT NULL
);`);
exec(`CREATE TABLE IF NOT EXISTS money_holds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL UNIQUE, user_id INTEGER NOT NULL,
  amount_s INTEGER NOT NULL, created_at TEXT NOT NULL
);`);
exec(`CREATE TABLE IF NOT EXISTS inventory_escrow(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL UNIQUE, owner_user_id INTEGER NOT NULL,
  item_id INTEGER, recipe_id INTEGER, qty INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);`);

// --- seed helpers
function ensureItem(code,name,tier,vol=0){
  const r=db.prepare("SELECT id FROM items WHERE code=?").get(code);
  if(r){ db.prepare("UPDATE items SET name=?,tier=?,volatile=? WHERE id=?").run(name,tier,vol,r.id); return r.id; }
  db.prepare("INSERT INTO items(code,name,tier,volatile) VALUES (?,?,?,?)").run(code,name,tier,vol);
  return db.prepare("SELECT id FROM items WHERE code=?").get(code).id;
}
const byCode = code => (db.prepare("SELECT id FROM items WHERE code=?").get(code)||{}).id;
function ensureRecipe(code,name,tier,outCode,ingCodes){
  const outId = byCode(outCode); if(!outId) throw new Error("Missing item "+outCode);
  const r=db.prepare("SELECT id FROM recipes WHERE code=?").get(code);
  let rid;
  if(!r){ db.prepare("INSERT INTO recipes(code,name,tier,output_item_id) VALUES (?,?,?,?)").run(code,name,tier,outId);
          rid=db.prepare("SELECT id FROM recipes WHERE code=?").get(code).id; }
  else { db.prepare("UPDATE recipes SET name=?,tier=?,output_item_id=? WHERE id=?").run(name,tier,outId,r.id);
         rid=r.id; db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id=?").run(rid); }
  for(const c of ingCodes){
    const iid = byCode(c); if(!iid) throw new Error("Missing ingredient "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,?)").run(rid,iid,1);
  }
  return rid;
}

// --- items/recipes set (skraćeno: kao u prethodnoj verziji)
ensureItem("SCRAP","Scrap",1,1);
const T1 = [
  ["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]
]; for(const [c,n] of T1) ensureItem(c,n,1,0);

// T2
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

// T3 set (skraćeno kao ranije)
function i(c){return c} // syntactic sugar for arrays below
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
const T2C={DOOR:i("T2_BRONZE_DOOR"),GOBLET:i("T2_SILVER_GOBLET"),RING:i("T2_GOLDEN_RING"),CHEST:i("T2_WOODEN_CHEST"),
           PILLAR:i("T2_STONE_PILLAR"),BAG:i("T2_LEATHER_BAG"),TENT:i("T2_CLOTH_TENT"),ORB:i("T2_CRYSTAL_ORB"),
           KNIFE:i("T2_OBSIDIAN_KNIFE"),ARMOR:i("T2_IRON_ARMOR")};
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

// T4
["ENGINE_CORE","CRYSTAL_LENS","MIGHT_GATE","WISDOM_GOBLET","SECRET_CHEST","STRENGTH_PILLAR","TRAVELER_SATCHEL","NOMAD_DWELLING","VISION_CORE","SHADOW_BLADE"]
  .forEach((k,i)=>ensureItem("T4_"+k,["Nor Engine Core","Nor Crystal Lens","Nor Reinforced Gate","Nor Enruned Goblet","Nor Sealed Chest","Nor Monument Pillar","Nor Traveler Satchel","Nor Nomad Dwelling","Nor Vision Core","Nor Shadow Blade"][i],4));
const T3C={GATE:"T3_GATE_OF_MIGHT",GOBLET:"T3_GOBLET_OF_WISDOM",RING:"T3_RING_OF_GLARE",CHEST:"T3_CHEST_OF_SECRETS",PILLAR:"T3_PILLAR_OF_STRENGTH",BAG:"T3_TRAVELERS_BAG",TENT:"T3_NOMAD_TENT",ORB:"T3_ORB_OF_VISION",KNIFE:"T3_KNIFE_OF_SHADOW",ARMOR:"T3_ARMOR_OF_GUARD"};
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

// T5
["ANCIENT_RELIC","SUN_LENS","GUARDIAN_GATE","WISDOM_CHALICE","VAULT","COLOSSAL_PILLAR","WAYFARER_BAG","NOMAD_HALL","EYE_OF_TRUTH","NIGHTFALL_EDGE"]
  .forEach((k,i)=>ensureItem("T5_"+k,["Nor Ancient Relic","Nor Sun Lens","Nor Guardian Gate","Nor Wisdom Chalice","Nor Royal Vault","Nor Colossal Pillar","Nor Wayfarer Bag","Nor Nomad Hall","Nor Eye of Truth","Nor Nightfall Edge"][i],5));
const T4C={CORE:"T4_ENGINE_CORE",LENS:"T4_CRYSTAL_LENS",RGATE:"T4_MIGHT_GATE",GOB:"T4_WISDOM_GOBLET",CHEST:"T4_SECRET_CHEST",PILLAR:"T4_STRENGTH_PILLAR",SATCHEL:"T4_TRAVELER_SATCHEL",DWELL:"T4_NOMAD_DWELLING",VISION:"T4_VISION_CORE",SHADOW:"T4_SHADOW_BLADE"};
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

// T6 (final)
ensureItem("ARTEFACT","Artefact",6);

// initial admin flag
try{ const u=db.prepare("SELECT id FROM users WHERE email=?").get(DEFAULT_ADMIN_EMAIL); if(u) db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(u.id); }catch{}

// ================= AUTH =================
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
app.get("/api/logout",(req,res)=>{ const u=verifyToken(req); if(u) db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(),u.uid);
  res.clearCookie(TOKEN_NAME,{httpOnly:true,sameSite:"lax",secure:false}); res.json({ok:true}); });
app.get("/api/me",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const r=db.prepare("SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(u.uid);
  if(!r) return res.status(401).json({ok:false});
  const g=Math.floor(r.balance_silver/100), s=r.balance_silver%100;
  const buysToNext=(r.next_recipe_at==null)?null:Math.max(0,(r.next_recipe_at)-(r.shop_buy_count||0));
  res.json({ok:true,user:{id:r.id,email:r.email,is_admin:!!r.is_admin,gold:g,silver:s,balance_silver:r.balance_silver,shop_buy_count:r.shop_buy_count,next_recipe_at:r.next_recipe_at,buys_to_next:buysToNext}});
});

// ================= ADMIN =================
app.get("/api/admin/ping",(req,res)=> isAdminRequest(req)?res.json({ok:true}):res.status(401).json({ok:false}));
app.get("/api/admin/users",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false});
  const rows=db.prepare("SELECT * FROM users ORDER BY is_disabled ASC, lower(email) ASC").all();
  const mapped=rows.map(u=>({id:u.id,email:u.email,is_admin:!!u.is_admin,is_disabled:!!u.is_disabled,gold:Math.floor(u.balance_silver/100),silver:u.balance_silver%100,shop_buy_count:u.shop_buy_count,next_recipe_at:u.next_recipe_at}));
  res.json({ok:true,users:mapped});
});
app.post("/api/admin/adjust-balance",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false});
  const {email,delta_silver,gold=0,silver=0}=req.body||{};
  const u=db.prepare("SELECT id,balance_silver FROM users WHERE lower(email)=lower(?)").get(email||"");
  if(!u) return res.status(404).json({ok:false,error:"User not found"});
  const deltaS = Number.isFinite(delta_silver)?Math.trunc(delta_silver):(Math.trunc(gold)*100+Math.trunc(silver));
  if(!deltaS) return res.status(400).json({ok:false,error:"No change"});
  try{
    const tx=db.transaction(()=>{ const after=u.balance_silver+deltaS; if(after<0) throw new Error("Insufficient funds");
      db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after,u.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(u.id,deltaS,"ADMIN_ADJUST",null,nowISO());
    }); tx();
    const bl=db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
    res.json({ok:true,balance_silver:bl,gold:Math.floor(bl/100),silver:bl%100});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.post("/api/admin/disable-user",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false});
  const {email,disabled}=req.body||{}; const flag=disabled?1:0;
  const r=db.prepare("UPDATE users SET is_disabled=? WHERE lower(email)=lower(?)").run(flag,email||"");
  if(!r.changes) return res.status(404).json({ok:false,error:"User not found"}); res.json({ok:true});
});
app.get("/api/admin/user/:id/inventory",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false});
  const uid=parseInt(req.params.id,10);
  const items=db.prepare(`SELECT i.id,i.code,i.name,i.tier,ui.qty FROM items i JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=? WHERE ui.qty>0 ORDER BY i.tier,i.name`).all(uid);
  const recipes=db.prepare(`SELECT r.id,r.code,r.name,r.tier,ur.qty FROM recipes r JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=? WHERE ur.qty>0 ORDER BY r.tier,r.name`).all(uid);
  res.json({ok:true,items,recipes});
});

// ================= SHOP =================
const T1_CODES = T1.map(x=>x[0]);
function pickWeightedRecipe(){
  const list = db.prepare(`SELECT id,code,name,tier FROM recipes WHERE tier BETWEEN 2 AND 6`).all();
  if(!list.length) return null;
  const byTier={}; for(const r of list){ (byTier[r.tier]||(byTier[r.tier]=[])).push(r); }
  const roll=randInt(1,1000);
  let t=(roll===1)?6:(roll<=13?5:(roll<=50?4:(roll<=200?3:2)));
  while(t>=2 && !byTier[t]) t--; if(!byTier[t]) t=2;
  const arr=byTier[t]; return arr[Math.floor(Math.random()*arr.length)];
}
const nextRecipeInterval=()=>randInt(RECIPE_DROP_MIN,RECIPE_DROP_MAX);

app.post("/api/shop/buy-t1",(req,res)=>{
  const uTok=verifyToken(req); if(!uTok) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const out=db.transaction(()=>{
      const user=db.prepare("SELECT * FROM users WHERE id=?").get(uTok.uid);
      if(!user) throw new Error("Session expired.");
      if(user.balance_silver<SHOP_T1_COST_S) throw new Error("Insufficient funds.");

      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(SHOP_T1_COST_S,user.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(user.id,-SHOP_T1_COST_S,"SHOP_BUY_T1",null,nowISO());

      if(user.next_recipe_at==null){
        const firstAt=user.shop_buy_count + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(firstAt,user.id);
        user.next_recipe_at=firstAt;
      }
      const willDrop=(user.shop_buy_count+1)>=user.next_recipe_at;
      let addedItem=null, grantedRecipe=null;

      if(willDrop){
        const pick=pickWeightedRecipe();
        if(pick){
          db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
                      VALUES (?,?,1,0)
                      ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+1`).run(user.id,pick.id);
          db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(user.id,0,"RECIPE_DROP","recipe:"+pick.code,nowISO());
          grantedRecipe={id:pick.id,code:pick.code,name:pick.name,tier:pick.tier};
        }
        const nextAt=(user.shop_buy_count+1)+nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(nextAt,user.id);
      }else{
        const code=T1_CODES[Math.floor(Math.random()*T1_CODES.length)];
        const iid=byCode(code);
        db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                    ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(user.id,iid);
        addedItem=db.prepare("SELECT code,name FROM items WHERE id=?").get(iid);
      }

      db.prepare("UPDATE users SET shop_buy_count=shop_buy_count+1 WHERE id=?").run(user.id);
      const bal=db.prepare("SELECT balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(user.id);
      const buysToNext=(bal.next_recipe_at==null)?null:Math.max(0,bal.next_recipe_at-bal.shop_buy_count);
      return {ok:true,result_type:willDrop?"RECIPE":"ITEM",addedItem,grantedRecipe,
              balance_silver:bal.balance_silver,gold:Math.floor(bal.balance_silver/100),silver:bal.balance_silver%100,
              shop_buy_count:bal.shop_buy_count,buys_to_next:buysToNext};
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// ================= RECIPES / CRAFT =================
app.get("/api/my/recipes",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const rows=db.prepare(`SELECT r.id,r.code,r.name,r.tier,ur.qty,ur.attempts
                         FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
                         WHERE ur.user_id=? AND ur.qty>0 ORDER BY r.tier,r.name`).all(u.uid);
  res.json({ok:true,recipes:rows});
});
app.get("/api/recipes/:id",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const rid=parseInt(req.params.id,10);
  const rec=db.prepare(`SELECT r.id,r.code,r.name,r.tier,r.output_item_id,COALESCE(ur.qty,0) have_qty,COALESCE(ur.attempts,0) attempts
                        FROM recipes r LEFT JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
                        WHERE r.id=?`).get(u.uid,rid);
  if(!rec||!rec.have_qty) return res.status(404).json({ok:false,error:"You don't own this recipe."});
  const ings=db.prepare(`SELECT i.id,i.code,i.name,i.tier,ri.qty need_qty,COALESCE(ui.qty,0) have_qty
                         FROM recipe_ingredients ri JOIN items i ON i.id=ri.item_id
                         LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
                         WHERE ri.recipe_id=? ORDER BY i.tier,i.name`).all(u.uid,rid);
  const can=ings.every(x=>x.have_qty>=x.need_qty);
  res.json({ok:true,recipe:rec,ingredients:ings,can_craft:can});
});
app.post("/api/recipes/:id/craft",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const rid=parseInt(req.params.id,10);
  try{
    const out=db.transaction(()=>{
      const rec=db.prepare(`SELECT r.id,r.code,r.name,r.tier,r.output_item_id,COALESCE(ur.qty,0) have_qty,COALESCE(ur.attempts,0) attempts
                            FROM recipes r LEFT JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
                            WHERE r.id=?`).get(u.uid,rid);
      if(!rec||!rec.have_qty) throw new Error("You don't own this recipe.");
      const ings=db.prepare(`SELECT i.id,i.code,i.name,ri.qty need_qty,COALESCE(ui.qty,0) have_qty
                             FROM recipe_ingredients ri JOIN items i ON i.id=ri.item_id
                             LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
                             WHERE ri.recipe_id=?`).all(u.uid,rid);
      for(const ing of ings){ if(ing.have_qty<ing.need_qty) throw new Error("Missing: "+ing.code); }
      for(const ing of ings){ db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(ing.need_qty,u.uid,ing.id); }
      db.prepare("UPDATE user_recipes SET attempts=MIN(attempts+1,5) WHERE user_id=? AND recipe_id=?").run(u.uid,rec.id);
      const outTier=(db.prepare("SELECT tier FROM items WHERE id=?").get(rec.output_item_id)||{}).tier||rec.tier;
      const failP=(outTier>=6)?0.0:0.10;
      if(Math.random()<failP){
        const scrap=byCode("SCRAP");
        db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                    ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(u.uid,scrap);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(u.uid,0,"CRAFT_FAIL","recipe:"+rec.code,nowISO());
        return {ok:true,crafted:false,scrap:true,recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier}};
      }else{
        const ch=db.prepare("UPDATE user_recipes SET qty=qty-1 WHERE user_id=? AND recipe_id=? AND qty>0").run(u.uid,rec.id).changes;
        if(!ch) throw new Error("Recipe not available.");
        db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                    ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(u.uid,rec.output_item_id);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(u.uid,0,"CRAFT_SUCCESS","recipe:"+rec.code,nowISO());
        const outItem=db.prepare("SELECT code,name,tier FROM items WHERE id=?").get(rec.output_item_id);
        return {ok:true,crafted:true,output:outItem,recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier}};
      }
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.get("/api/my/inventory",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const items=db.prepare(`SELECT i.id,i.code,i.name,i.tier,ui.qty
                          FROM items i JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
                          WHERE ui.qty>0 ORDER BY i.tier,i.name`).all(u.uid);
  const recipes=db.prepare(`SELECT r.id,r.code,r.name,r.tier,ur.qty
                            FROM recipes r JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
                            WHERE ur.qty>0 ORDER BY r.tier,r.name`).all(u.uid);
  res.json({ok:true,items,recipes});
});
app.get("/api/my/inventory/for-auctions",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const items=db.prepare(`SELECT i.id,i.code,i.name,i.tier,ui.qty
                          FROM items i JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
                          WHERE ui.qty>0 ORDER BY i.tier,i.name`).all(u.uid);
  const recipes=db.prepare(`SELECT r.id,r.code,r.name,r.tier,ur.qty
                            FROM recipes r JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
                            WHERE ur.qty>0 ORDER BY r.tier,r.name`).all(u.uid);
  res.json({ok:true,items,recipes});
});

// ================= AUCTIONS =================
function findByCode(code){
  if(!code) return null;
  if(code.startsWith("R_")){ const r=db.prepare("SELECT id,code,name,tier FROM recipes WHERE code=?").get(code); return r?{kind:"recipe",rec:r}:null; }
  const i=db.prepare("SELECT id,code,name,tier FROM items WHERE code=?").get(code); return i?{kind:"item",it:i}:null;
}
app.post("/api/auctions/create",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const {code,qty=1,start_gold=0,start_silver=0,buy_gold=0,buy_silver=0,duration_min}=req.body||{};
  const look=findByCode(String(code||"").trim()); if(!look) return res.status(400).json({ok:false,error:"Unknown code."});
  const q=Math.max(1,Math.trunc(qty)); const sStart=Math.trunc(start_gold)*100+Math.trunc(start_silver);
  const sBuy=Math.trunc(buy_gold)*100+Math.trunc(buy_silver); if(sStart<=0) return res.status(400).json({ok:false,error:"Start price must be > 0."});
  if(sBuy && sBuy<sStart) return res.status(400).json({ok:false,error:"Buy-now must be >= start."});
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
      const now=nowISO(); const end=addMinutes(now, Number.isFinite(duration_min)?Math.max(5,Math.trunc(duration_min)):60);
      db.prepare(`INSERT INTO auctions(seller_user_id,type,item_id,recipe_id,qty,title,description,start_price_s,buy_now_price_s,highest_bid_s,highest_bidder_user_id,fee_bps,status,start_time,end_time,created_at)
                  VALUES (?,?,?,?,?,?,NULL,?,?,NULL,NULL,?,'live',?,?,?)`)
        .run(u.uid,look.kind,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,
             look.kind==="item"?look.it.code:look.rec.code,sStart,sBuy||null,AUCTION_FEE_BPS,now,end,now);
      const aid=db.prepare("SELECT last_insert_rowid() id").get().id;
      db.prepare("INSERT INTO inventory_escrow(auction_id,owner_user_id,item_id,recipe_id,qty,created_at) VALUES (?,?,?,?,?,?)")
        .run(aid,u.uid,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,now);
      return {ok:true,auction_id:aid};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.get("/api/auctions/live",(req,res)=>{
  const rows=db.prepare(`
    SELECT a.id,a.seller_user_id,a.type,a.qty,a.start_price_s,a.buy_now_price_s,a.highest_bid_s,a.end_time,a.status,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name
    FROM auctions a
    LEFT JOIN items i ON i.id=a.item_id
    LEFT JOIN recipes r ON r.id=a.recipe_id
    WHERE a.status='live'
    ORDER BY datetime(a.end_time) ASC, a.id ASC
  `).all();
  res.json({ok:true,auctions:rows});
});
app.get("/api/auctions/mine",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const rows=db.prepare(`
    SELECT a.id,a.type,a.qty,a.start_price_s,a.buy_now_price_s,a.highest_bid_s,a.end_time,a.status,a.sold_price_s,a.winner_user_id,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name
    FROM auctions a
    LEFT JOIN items i ON i.id=a.item_id
    LEFT JOIN recipes r ON r.id=a.recipe_id
    WHERE a.seller_user_id=?
    ORDER BY a.id DESC
  `).all(u.uid);
  res.json({ok:true,auctions:rows});
});
// new: my active highest bids
app.get("/api/auctions/my-bids",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const rows=db.prepare(`
    SELECT a.id,a.highest_bid_s,a.end_time,a.status, a.start_price_s, a.buy_now_price_s,
           COALESCE(i.code,r.code) code, COALESCE(i.name,r.name) name,
           (SELECT COUNT(*) FROM bids b WHERE b.auction_id=a.id) AS bids_count
    FROM auctions a
    LEFT JOIN items i ON i.id=a.item_id
    LEFT JOIN recipes r ON r.id=a.recipe_id
    WHERE a.status='live' AND a.highest_bidder_user_id=?
    ORDER BY datetime(a.end_time) ASC
  `).all(u.uid);
  res.json({ok:true,bids:rows});
});
// bid
app.post("/api/auctions/:id/bid",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const aid=parseInt(req.params.id,10);
  let {gold=0,silver=0}=req.body||{}; gold=Math.trunc(gold||0); silver=Math.trunc(silver||0);
  if(silver<0||silver>99) return res.status(400).json({ok:false,error:"Silver must be 0..99."});
  const amount_s=gold*100+silver; if(amount_s<=0) return res.status(400).json({ok:false,error:"Bid must be > 0."});
  try{
    const result=db.transaction(()=>{
      const a=db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if(!a||a.status!=="live") throw new Error("Auction not active.");
      if(new Date()>new Date(a.end_time)) throw new Error("Auction expired.");
      if(u.uid===a.seller_user_id) throw new Error("Can't bid on your own auction.");
      const minAccept=Math.max(a.start_price_s,(a.highest_bid_s||0)+1);
      if(amount_s<minAccept) throw new Error(`Too low. Minimum: ${Math.floor(minAccept/100)}g ${minAccept%100}s`);
      const me=db.prepare("SELECT id,balance_silver FROM users WHERE id=?").get(u.uid);
      if(me.balance_silver<amount_s) throw new Error("Insufficient funds.");
      const oldHold=db.prepare("SELECT * FROM money_holds WHERE auction_id=?").get(a.id);
      if(oldHold){
        db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(oldHold.amount_s,oldHold.user_id);
        db.prepare("DELETE FROM money_holds WHERE auction_id=?").run(a.id);
      }
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(amount_s,me.id);
      db.prepare("INSERT INTO money_holds(auction_id,user_id,amount_s,created_at) VALUES (?,?,?,?)").run(a.id,me.id,amount_s,nowISO());
      db.prepare("INSERT INTO bids(auction_id,bidder_user_id,amount_s,created_at) VALUES (?,?,?,?)").run(a.id,me.id,amount_s,nowISO());
      db.prepare("UPDATE auctions SET highest_bid_s=?,highest_bidder_user_id=? WHERE id=?").run(amount_s,me.id,a.id);
      const bal=db.prepare("SELECT balance_silver FROM users WHERE id=?").get(me.id).balance_silver;
      return {ok:true,highest_bid_s:amount_s,your_balance_silver:bal,gold:Math.floor(bal/100),silver:bal%100};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
// buy-now
app.post("/api/auctions/:id/buy-now",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const aid=parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const a=db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if(!a||a.status!=="live") throw new Error("Auction not active.");
      if(!a.buy_now_price_s) throw new Error("No buy-now price.");
      if(u.uid===a.seller_user_id) throw new Error("Can't buy your own auction.");
      const oldHold=db.prepare("SELECT * FROM money_holds WHERE auction_id=?").get(a.id);
      if(oldHold){ db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(oldHold.amount_s,oldHold.user_id);
                   db.prepare("DELETE FROM money_holds WHERE auction_id=?").run(a.id); }
      const buyer=db.prepare("SELECT id,balance_silver FROM users WHERE id=?").get(u.uid);
      if(buyer.balance_silver<a.buy_now_price_s) throw new Error("Insufficient funds.");
      const seller=a.seller_user_id;

      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(a.buy_now_price_s,buyer.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(buyer.id,-a.buy_now_price_s,"AUCTION_BUY_NOW","auction:"+a.id,nowISO());
      const fee=Math.floor((a.buy_now_price_s*a.fee_bps)/10000), net=a.buy_now_price_s-fee;
      db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(net,seller);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(seller,net,"AUCTION_SALE_NET","auction:"+a.id,nowISO());

      const esc=db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if(esc){
        if(esc.item_id) db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`).run(buyer.id,esc.item_id,esc.qty);
        else if(esc.recipe_id) db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?) ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`).run(buyer.id,esc.recipe_id,esc.qty);
      }
      db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);
      db.prepare("UPDATE auctions SET status='paid',sold_price_s=?,winner_user_id=? WHERE id=?").run(a.buy_now_price_s,buyer.id,a.id);

      const bal= db.prepare("SELECT balance_silver FROM users WHERE id=?").get(buyer.id).balance_silver;
      return {ok:true,buyer_balance_silver:bal,gold:Math.floor(bal/100),silver:bal%100};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
// seller cancel (no bids)
app.post("/api/auctions/:id/cancel",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const aid=parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const a=db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if(!a||a.seller_user_id!==u.uid) throw new Error("Not your auction.");
      if(a.status!=="live") throw new Error("Not active.");
      if(a.highest_bid_s) throw new Error("Already has bids.");
      const esc=db.prepare("SELECT * FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if(esc){
        if(esc.item_id) db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`).run(u.uid,esc.item_id,esc.qty);
        else if(esc.recipe_id) db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?) ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`).run(u.uid,esc.recipe_id,esc.qty);
      }
      db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);
      db.prepare("UPDATE auctions SET status='canceled' WHERE id=?").run(a.id);
      return {ok:true};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
// new: highest bidder cancels (only if the only bidder)
app.post("/api/auctions/:id/cancel-bid",(req,res)=>{
  const u=verifyToken(req); if(!u) return res.status(401).json({ok:false});
  const aid=parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const a=db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if(!a||a.status!=="live") throw new Error("Auction not active.");
      if(a.highest_bidder_user_id!==u.uid) throw new Error("Not your highest bid.");
      const count=db.prepare("SELECT COUNT(*) c FROM bids WHERE auction_id=?").get(a.id).c|0;
      if(count>1) throw new Error("Cannot cancel: there are other bids.");
      const hold=db.prepare("SELECT * FROM money_holds WHERE auction_id=?").get(a.id);
      if(hold){ db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(hold.amount_s,hold.user_id);
                db.prepare("DELETE FROM money_holds WHERE auction_id=?").run(a.id); }
      db.prepare("DELETE FROM bids WHERE auction_id=?").run(a.id);
      db.prepare("UPDATE auctions SET highest_bid_s=NULL,highest_bidder_user_id=NULL WHERE id=?").run(a.id);
      const bal=db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.uid).balance_silver;
      return {ok:true,balance_silver:bal,gold:Math.floor(bal/100),silver:bal%100};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// Misc
app.get("/api/health",(req,res)=>res.json({ok:true,db:DB_PATH}));
app.get("/admin",(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));

server.listen(PORT,HOST,()=>console.log(`ARTEFACT at http://${HOST}:${PORT} (db ${DB_PATH})`));
