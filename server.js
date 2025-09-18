// ==============================================
// ARTEFACT • Full Server (Express + better-sqlite3)
// Auth (register/login/logout/me)
// Shop T1 -> random T1 or recipe drop (T2–T5 weighted)
// Crafting (fail 10% osim ARTEFACT; ARTEFACT = 10 distinct T5)
// Sales (fixed-price): create, market, mine, buy, cancel (+escrow)
// Admin helpers (ping, users, adjust, disable, inventory)
// DB on persistent disk via env DB_PATH
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
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || "admin@example.com").toLowerCase();

const DB_FILE = process.env.DB_PATH || path.join(__dirname, "data", "artefact.db");
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// ---------- App
const app = express();
const server = http.createServer(app);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"))); // index.html, admin.html, app.css

// ---------- DB
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");

// ---------- Helpers
const nowISO = () => new Date().toISOString();
const randInt = (a,b)=> a + Math.floor(Math.random()*(b-a+1));
function isEmail(x){ return typeof x==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x); }
function isPass(x){ return typeof x==="string" && x.length>=6; }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function readToken(req){
  const t = req.cookies && req.cookies[TOKEN_NAME];
  if(!t) return null;
  try{ return jwt.verify(t, JWT_SECRET); }catch{ return null; }
}
function requireUser(req,res){
  const tok = readToken(req);
  if (!tok) { res.status(401).json({ok:false,error:"Not logged in"}); return null; }
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(tok.uid);
  if (!u || u.is_disabled) { res.status(403).json({ok:false,error:"Account disabled"}); return null; }
  return u;
}
function isAdmin(req){
  const hdr = (req.headers["x-admin-key"] || req.headers["X-Admin-Key"] || "").toString();
  if (hdr && hdr === ADMIN_KEY) return true;
  const tok = readToken(req); if (!tok) return false;
  const r = db.prepare("SELECT is_admin FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin===1);
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

// Escrow & Sales (fixed price)
ensure(`
CREATE TABLE IF NOT EXISTS inventory_escrow(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,          -- 'item' | 'recipe'
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY(owner_user_id) REFERENCES users(id),
  FOREIGN KEY(item_id) REFERENCES items(id),
  FOREIGN KEY(recipe_id) REFERENCES recipes(id)
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
  created_at TEXT NOT NULL,
  FOREIGN KEY(seller_user_id) REFERENCES users(id),
  FOREIGN KEY(item_id) REFERENCES items(id),
  FOREIGN KEY(recipe_id) REFERENCES recipes(id)
);`);

// Defensive migrations (popravlja “no column named ...”)
function hasCol(tab, col){
  try{ return db.prepare(`PRAGMA table_info(${tab})`).all().some(c=>c.name===col); }catch{ return false; }
}
if (!hasCol("sales","title"))   db.prepare(`ALTER TABLE sales ADD COLUMN title TEXT NOT NULL DEFAULT ''`).run();
if (!hasCol("sales","price_s")) db.prepare(`ALTER TABLE sales ADD COLUMN price_s INTEGER NOT NULL DEFAULT 0`).run();
if (!hasCol("sales","status"))  db.prepare(`ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'live'`).run();

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

// ---------- Items & Recipes
ensureItem("SCRAP","Scrap",1,1);

// T1 materials (10)
const T1 = [
  ["BRONZE","Bronze"],["IRON","Iron"],["SILVER","Silver"],["GOLD","Gold"],
  ["WOOD","Wood"],["STONE","Stone"],["LEATHER","Leather"],["CLOTH","Cloth"],
  ["CRYSTAL","Crystal"],["OBSIDIAN","Obsidian"]
];
for(const [c,n] of T1) ensureItem(c,n,1,0);

// T2 simple set
const T2 = [
  ["T2_BRONZE_DOOR","Nor Bronze Door",["BRONZE","IRON","WOOD","STONE"]],
  ["T2_SILVER_GOBLET","Nor Silver Goblet",["SILVER","GOLD","CRYSTAL","CLOTH"]],
  ["T2_GOLDEN_RING","Nor Golden Ring",["GOLD","SILVER","CRYSTAL","LEATHER"]],
  ["T2_WOODEN_CHEST","Nor Wooden Chest",["WOOD","STONE","LEATHER","IRON","CLOTH"]],
  ["T2_STONE_PILLAR","Nor Stone Pillar",["STONE","WOOD","IRON","CLOTH"]],
  ["T2_LEATHER_BAG","Nor Leather Bag",["LEATHER","CLOTH","WOOD","SILVER"]],
  ["T2_CLOTH_TENT","Nor Cloth Tent",["CLOTH","LEATHER","WOOD","STONE","IRON"]],
  ["T2_CRYSTAL_ORB","Nor Crystal Orb",["CRYSTAL","GOLD","CLOTH","WOOD","LEATHER"]],
  ["T2_OBSIDIAN_KNIFE","Nor Obsidian Knife",["OBSIDIAN","CRYSTAL","IRON","BRONZE"]],
  ["T2_IRON_ARMOR","Nor Iron Armor",["IRON","BRONZE","LEATHER","CLOTH","STONE"]]
];
for (const [code,name,ings] of T2){
  ensureItem(code,name,2,0);
  ensureRecipe("R_"+code,name,2,code,ings);
}

// T3 from T2
const T3names = [
  ["T3_GATE_OF_MIGHT","Nor Gate of Might",["T2_BRONZE_DOOR","T2_SILVER_GOBLET","T2_GOLDEN_RING","T2_WOODEN_CHEST"]],
  ["T3_GOBLET_OF_WISDOM","Nor Goblet of Wisdom",["T2_SILVER_GOBLET","T2_GOLDEN_RING","T2_STONE_PILLAR","T2_LEATHER_BAG"]],
  ["T3_RING_OF_GLARE","Nor Ring of Glare",["T2_GOLDEN_RING","T2_WOODEN_CHEST","T2_STONE_PILLAR","T2_CRYSTAL_ORB"]],
  ["T3_CHEST_OF_SECRETS","Nor Chest of Secrets",["T2_WOODEN_CHEST","T2_STONE_PILLAR","T2_LEATHER_BAG","T2_CLOTH_TENT"]],
  ["T3_PILLAR_OF_STRENGTH","Nor Pillar of Strength",["T2_STONE_PILLAR","T2_LEATHER_BAG","T2_CLOTH_TENT"]],
  ["T3_TRAVELERS_BAG","Nor Traveler's Bag",["T2_LEATHER_BAG","T2_CLOTH_TENT","T2_CRYSTAL_ORB"]],
  ["T3_NOMAD_TENT","Nor Nomad Tent",["T2_CLOTH_TENT","T2_CRYSTAL_ORB","T2_IRON_ARMOR"]],
  ["T3_ORB_OF_VISION","Nor Orb of Vision",["T2_CRYSTAL_ORB","T2_OBSIDIAN_KNIFE","T2_BRONZE_DOOR"]],
  ["T3_KNIFE_OF_SHADOW","Nor Knife of Shadow",["T2_OBSIDIAN_KNIFE","T2_IRON_ARMOR","T2_WOODEN_CHEST"]],
  ["T3_ARMOR_OF_GUARD","Nor Armor of Guard",["T2_IRON_ARMOR","T2_SILVER_GOBLET","T2_GOLDEN_RING"]]
];
for(const [code,name,ings] of T3names){
  ensureItem(code,name,3,0);
  ensureRecipe("R_"+code,name,3,code,ings);
}

// T4 from T3
const T4names = [
  ["T4_ENGINE_CORE","Nor Engine Core",["T3_GATE_OF_MIGHT","T3_KNIFE_OF_SHADOW","T3_ARMOR_OF_GUARD"]],
  ["T4_CRYSTAL_LENS","Nor Crystal Lens",["T3_ORB_OF_VISION","T3_RING_OF_GLARE","T3_GOBLET_OF_WISDOM"]],
  ["T4_MIGHT_GATE","Nor Reinforced Gate",["T3_GATE_OF_MIGHT","T3_CHEST_OF_SECRETS","T3_ARMOR_OF_GUARD"]],
  ["T4_WISDOM_GOBLET","Nor Enruned Goblet",["T3_GOBLET_OF_WISDOM","T3_RING_OF_GLARE","T3_PILLAR_OF_STRENGTH"]],
  ["T4_SECRET_CHEST","Nor Sealed Chest",["T3_CHEST_OF_SECRETS","T3_PILLAR_OF_STRENGTH","T3_TRAVELERS_BAG"]],
  ["T4_STRENGTH_PILLAR","Nor Monument Pillar",["T3_PILLAR_OF_STRENGTH","T3_TRAVELERS_BAG","T3_NOMAD_TENT"]],
  ["T4_TRAVELER_SATCHEL","Nor Traveler Satchel",["T3_TRAVELERS_BAG","T3_NOMAD_TENT","T3_ORB_OF_VISION"]],
  ["T4_NOMAD_DWELLING","Nor Nomad Dwelling",["T3_NOMAD_TENT","T3_ORB_OF_VISION","T3_KNIFE_OF_SHADOW"]],
  ["T4_VISION_CORE","Nor Vision Core",["T3_ORB_OF_VISION","T3_KNIFE_OF_SHADOW","T3_GATE_OF_MIGHT"]],
  ["T4_SHADOW_BLADE","Nor Shadow Blade",["T3_KNIFE_OF_SHADOW","T3_CHEST_OF_SECRETS","T3_ARMOR_OF_GUARD"]]
];
for(const [code,name,ings] of T4names){
  ensureItem(code,name,4,0);
  ensureRecipe("R_"+code,name,4,code,ings);
}

// T5 from T4
const T5names = [
  ["T5_ANCIENT_RELIC","Nor Ancient Relic",["T4_ENGINE_CORE","T4_CRYSTAL_LENS","T4_WISDOM_GOBLET"]],
  ["T5_SUN_LENS","Nor Sun Lens",["T4_CRYSTAL_LENS","T4_VISION_CORE","T4_MIGHT_GATE"]],
  ["T5_GUARDIAN_GATE","Nor Guardian Gate",["T4_MIGHT_GATE","T4_ENGINE_CORE","T4_TRAVELER_SATCHEL"]],
  ["T5_WISDOM_CHALICE","Nor Wisdom Chalice",["T4_WISDOM_GOBLET","T4_CRYSTAL_LENS","T4_STRENGTH_PILLAR"]],
  ["T5_VAULT","Nor Royal Vault",["T4_SECRET_CHEST","T4_STRENGTH_PILLAR","T4_TRAVELER_SATCHEL"]],
  ["T5_COLOSSAL_PILLAR","Nor Colossal Pillar",["T4_STRENGTH_PILLAR","T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING"]],
  ["T5_WAYFARER_BAG","Nor Wayfarer Bag",["T4_TRAVELER_SATCHEL","T4_NOMAD_DWELLING","T4_VISION_CORE"]],
  ["T5_NOMAD_HALL","Nor Nomad Hall",["T4_NOMAD_DWELLING","T4_VISION_CORE","T4_MIGHT_GATE"]],
  ["T5_EYE_OF_TRUTH","Nor Eye of Truth",["T4_VISION_CORE","T4_ENGINE_CORE","T4_WISDOM_GOBLET"]],
  ["T5_NIGHTFALL_EDGE","Nor Nightfall Edge",["T4_SHADOW_BLADE","T4_MIGHT_GATE","T4_SECRET_CHEST"]]
];
for(const [code,name,ings] of T5names){
  ensureItem(code,name,5,0);
  ensureRecipe("R_"+code,name,5,code,ings);
}

// T6
ensureItem("ARTEFACT","Artefact",6,0);

// ---------- Initial admin flag
try{
  const u = db.prepare("SELECT id FROM users WHERE email=?").get(DEFAULT_ADMIN_EMAIL);
  if (u) db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(u.id);
}catch{}

// =============== AUTH
app.post("/api/register", async (req,res)=>{
  try{
    const {email, password} = req.body||{};
    if (!isEmail(email)) return res.status(400).json({ok:false,error:"Invalid email"});
    if (!isPass(password)) return res.status(400).json({ok:false,error:"Password too short"});
    const ex = db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
    if (ex) return res.status(409).json({ok:false,error:"User exists"});
    const pass_hash = await bcrypt.hash(password,10);
    db.prepare("INSERT INTO users(email,pass_hash,created_at) VALUES (?,?,?)").run(email.toLowerCase(), pass_hash, nowISO());
    res.json({ok:true,message:"Registered"});
  }catch(e){ res.status(500).json({ok:false,error:"Server error"}); }
});

app.post("/api/login", async (req,res)=>{
  try{
    const {email,password} = req.body||{};
    const u = db.prepare("SELECT * FROM users WHERE email=?").get((email||"").toLowerCase());
    if (!u) return res.status(404).json({ok:false,error:"User not found"});
    if (u.is_disabled) return res.status(403).json({ok:false,error:"Account disabled"});
    const ok = await bcrypt.compare(password||"", u.pass_hash);
    if (!ok) return res.status(401).json({ok:false,error:"Wrong password"});
    const token = signToken(u);
    res.cookie(TOKEN_NAME, token, { httpOnly:true, sameSite:"lax", secure:false, maxAge:7*24*60*60*1000 });
    db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), u.id);
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:"Server error"}); }
});

app.get("/api/logout",(req,res)=>{
  const tok = readToken(req);
  if (tok) db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(nowISO(), tok.uid);
  res.clearCookie(TOKEN_NAME,{ httpOnly:true, sameSite:"lax", secure:false });
  res.json({ok:true});
});

app.get("/api/me",(req,res)=>{
  const tok = readToken(req);
  if (!tok) return res.status(401).json({ok:false});
  const u = db.prepare("SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(tok.uid);
  if (!u) { res.clearCookie(TOKEN_NAME); return res.status(401).json({ok:false}); }
  const g = Math.floor(u.balance_silver/100), s=u.balance_silver%100;
  const buysToNext = (u.next_recipe_at==null)?null:Math.max(0, u.next_recipe_at - (u.shop_buy_count||0));
  res.json({ok:true,user:{
    id:u.id,email:u.email,is_admin:!!u.is_admin,
    balance_silver:u.balance_silver,gold:g,silver:s,
    shop_buy_count:u.shop_buy_count,next_recipe_at:u.next_recipe_at,buys_to_next:buysToNext
  }});
});

// =============== ADMIN minimal
app.get("/api/admin/ping",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  res.json({ok:true});
});
app.get("/api/admin/users",(req,res)=>{
  if (!isAdmin(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const rows = db.prepare(`SELECT id,email,is_admin,is_disabled,balance_silver,created_at,last_seen,shop_buy_count,next_recipe_at FROM users`).all();
  const users = rows.map(u=>({
    id:u.id,email:u.email,is_admin:!!u.is_admin,is_disabled:!!u.is_disabled,
    gold:Math.floor(u.balance_silver/100), silver:u.balance_silver%100,
    created_at:u.created_at,last_seen:u.last_seen,
    shop_buy_count:u.shop_buy_count,next_recipe_at:u.next_recipe_at
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
    const after = u.balance_silver + deltaS; if (after<0) throw new Error("Insufficient");
    db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after,u.id);
    db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,created_at) VALUES (?,?,?,?)")
      .run(u.id,deltaS,"ADMIN_ADJUST",nowISO());
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
    FROM user_items ui JOIN items i ON i.id=ui.item_id
    WHERE ui.user_id=? AND ui.qty>0 ORDER BY i.tier,i.name
  `).all(uid);
  const recipes = db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0 ORDER BY r.tier,r.name
  `).all(uid);
  res.json({ok:true,items,recipes});
});

// =============== SHOP (T1 only)
const SHOP_COST_S = 100; // 1g
function pickWeightedRecipe(){
  const all = db.prepare("SELECT id,tier,name FROM recipes WHERE tier BETWEEN 2 AND 5").all();
  if (!all.length) return null;
  const byTier={}; for(const r of all){ (byTier[r.tier] ||= []).push(r); }
  const roll = randInt(1,1000); // 1..1000
  let tier = (roll<=13)?5 : (roll<=50)?4 : (roll<=200)?3 : 2;  // 13/37/150/800
  while (tier>=2 && !(byTier[tier] && byTier[tier].length)) tier--;
  const arr = byTier[tier]||byTier[2];
  return arr[Math.floor(Math.random()*arr.length)];
}
function nextRecipeInterval(){ return randInt(4,8); }

app.post("/api/shop/buy-t1",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  try{
    const row = db.prepare("SELECT id,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(me.id);
    if (row.balance_silver < SHOP_COST_S) return res.status(400).json({ok:false,error:"Insufficient funds"});
    const result = { ok:true, got:null, name:null, buys_to_next:null };

    const tx = db.transaction(()=>{
      // charge
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(SHOP_COST_S, me.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,created_at) VALUES (?,?,?,?)")
        .run(me.id,-SHOP_COST_S,"SHOP_T1_BUY",nowISO());

      // init next drop target
      let shop_buy_count = row.shop_buy_count + 1;
      let next_at = row.next_recipe_at;
      if (next_at == null){
        next_at = row.shop_buy_count + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run(next_at, me.id);
      }

      let recipeGranted = (shop_buy_count >= next_at);

      if (recipeGranted){
        const pick = pickWeightedRecipe();
        if (pick){
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
            VALUES (?,?,1,0)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+1
          `).run(me.id,pick.id);
          result.got = "recipe"; result.name = pick.name;
        }else{
          recipeGranted = false; // fallback to item
        }
        // schedule next drop
        const next = shop_buy_count + nextRecipeInterval();
        db.prepare("UPDATE users SET next_recipe_at=?, shop_buy_count=? WHERE id=?")
          .run(next, shop_buy_count, me.id);
      }

      if (!recipeGranted){
        // random T1 material
        const codes = T1.map(([c])=>c);
        const code = codes[Math.floor(Math.random()*codes.length)];
        const iid = idByCode(code);
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES(?,?,1) ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(me.id,iid);
        result.got="item"; result.name=db.prepare("SELECT name FROM items WHERE id=?").get(iid).name;

        db.prepare("UPDATE users SET shop_buy_count=? WHERE id=?").run(shop_buy_count, me.id);
      }

      const st = db.prepare("SELECT shop_buy_count,next_recipe_at FROM users WHERE id=?").get(me.id);
      result.buys_to_next = (st.next_recipe_at==null)?null:Math.max(0, st.next_recipe_at - st.shop_buy_count);
    });

    tx();
    const bal = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(me.id).balance_silver;
    result.balance_silver = bal;
    result.gold = Math.floor(bal/100); result.silver=bal%100;

    res.json(result);
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});

// =============== INVENTORY + RECIPES
app.get("/api/inventory",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  try{
    const items = db.prepare(`
      SELECT i.code,i.name,i.tier,ui.qty
      FROM user_items ui JOIN items i ON i.id=ui.item_id
      WHERE ui.user_id=? AND ui.qty>0
      ORDER BY i.tier,i.name
    `).all(me.id);
    const recipes = db.prepare(`
      SELECT r.id,r.code,r.name,r.tier,ur.qty
      FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
      WHERE ur.user_id=? AND ur.qty>0
      ORDER BY r.tier,r.name
    `).all(me.id);
    res.json({ok:true, items, recipes});
  }catch(e){ res.status(500).json({ok:false,error:"Server error"}); }
});

app.get("/api/recipes/list",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  const rows = db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,ur.qty
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0
    ORDER BY r.tier,r.name
  `).all(me.id);
  res.json({ok:true, recipes: rows});
});

app.get("/api/recipes/ingredients/:rid",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  const rid = parseInt(req.params.rid,10);
  const r = db.prepare(`SELECT id,code,name,tier,output_item_id FROM recipes WHERE id=?`).get(rid);
  if (!r) return res.status(404).json({ok:false,error:"Recipe not found"});
  const ings = db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,ri.qty,
           COALESCE(ui.qty,0) AS have
    FROM recipe_ingredients ri
    JOIN items i ON i.id=ri.item_id
    LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ri.recipe_id=?
    ORDER BY i.tier,i.name
  `).all(me.id, rid);
  res.json({ok:true, recipe:r, ingredients: ings});
});

// =============== CRAFTING
app.post("/api/craft/do",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  try{
    const { recipe_id } = req.body||{};
    const r = db.prepare("SELECT id,output_item_id,tier FROM recipes WHERE id=?").get(parseInt(recipe_id,10));
    if (!r) return res.status(404).json({ok:false,error:"Recipe not found"});

    const haveRecipe = db.prepare("SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?").get(me.id,r.id);
    if (!haveRecipe || haveRecipe.qty<=0) return res.status(400).json({ok:false,error:"No recipe owned"});

    // collect ingredients
    const ings = db.prepare(`
      SELECT i.id,i.name,ri.qty, COALESCE(ui.qty,0) AS have
      FROM recipe_ingredients ri
      JOIN items i ON i.id=ri.item_id
      LEFT JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
      WHERE ri.recipe_id=?
    `).all(me.id, r.id);
    if (ings.some(x=>x.have < x.qty)) return res.status(400).json({ok:false,error:"Missing ingredients"});

    const fail = (r.tier<6) && (Math.random()<0.10); // 10% fail; no fail for tier6 (not used)
    const outItem = db.prepare("SELECT id,name FROM items WHERE id=?").get(r.output_item_id);

    const tx = db.transaction(()=>{
      // consume ingredients
      for(const ing of ings){
        db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(ing.qty, me.id, ing.id);
      }

      // consume one recipe
      db.prepare("UPDATE user_recipes SET qty=qty-1, attempts=attempts+1 WHERE user_id=? AND recipe_id=?").run(me.id,r.id);

      if (fail){
        const scrap = idByCode("SCRAP");
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(me.id,scrap);
      }else{
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(me.id,outItem.id);
      }
    });
    tx();

    res.json({ok:true, result: fail?"fail":"success", item: outItem.name});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});

app.post("/api/craft/artefact",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  try{
    // distinct T5 items user has (qty>0)
    const t5 = db.prepare(`
      SELECT i.id,i.name,ui.qty
      FROM user_items ui JOIN items i ON i.id=ui.item_id
      WHERE ui.user_id=? AND ui.qty>0 AND i.tier=5
      ORDER BY i.name
    `).all(me.id);
    if (t5.length < 10) return res.status(400).json({ok:false,error:"Need at least 10 distinct T5 items."});

    const pick = t5.slice(0,10); // uzmi 10 različitih
    const arte = idByCode("ARTEFACT");

    const tx = db.transaction(()=>{
      for(const it of pick){
        db.prepare("UPDATE user_items SET qty=qty-1 WHERE user_id=? AND item_id=?").run(me.id,it.id);
      }
      db.prepare(`
        INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
        ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
      `).run(me.id,arte);
    });
    tx();

    res.json({ok:true, crafted:"Artefact" });
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});

// =============== SALES (fixed price)
app.get("/api/sales/market",(req,res)=>{
  try{
    const q = (req.query.q||"").toString().trim().toLowerCase();
    let rows = db.prepare(`
      SELECT s.id,s.qty,s.price_s,s.type,
             COALESCE(i.name,r.name) AS name
      FROM sales s
      LEFT JOIN items i ON i.id=s.item_id
      LEFT JOIN recipes r ON r.id=s.recipe_id
      WHERE s.status='live'
      ORDER BY s.id DESC
      LIMIT 300
    `).all();
    if (q) rows = rows.filter(x=>(x.name||"").toLowerCase().includes(q));
    res.json({ok:true, sales: rows});
  }catch(e){ res.status(500).json({ok:false,error:"Server error"}); }
});

app.get("/api/sales/mine",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  try{
    const rows = db.prepare(`
      SELECT s.id,s.qty,s.price_s,s.status,
             COALESCE(i.name,r.name) AS name
      FROM sales s
      LEFT JOIN items i ON i.id=s.item_id
      LEFT JOIN recipes r ON r.id=s.recipe_id
      WHERE s.seller_user_id=?
      ORDER BY s.id DESC
      LIMIT 300
    `).all(me.id);
    res.json({ok:true, sales: rows});
  }catch(e){ res.status(500).json({ok:false,error:"Server error"}); }
});

app.post("/api/sales/create",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  try{
    const { kind, code, recipe_code, qty=1, gold=0, silver=0 } = req.body||{};
    const q = Math.max(1, parseInt(qty,10)||1);
    const price_s = Math.max(0, (parseInt(gold,10)||0)*100 + (parseInt(silver,10)||0) );
    if (!price_s) return res.status(400).json({ok:false,error:"Price required"});
    if (kind!=="item" && kind!=="recipe") return res.status(400).json({ok:false,error:"Bad kind"});

    const tx = db.transaction(()=>{
      if (kind==="item"){
        const it = db.prepare("SELECT id,name FROM items WHERE code=?").get(code||"");
        if (!it) throw new Error("Unknown item");
        const inv = db.prepare("SELECT qty FROM user_items WHERE user_id=? AND item_id=?").get(me.id,it.id);
        if (!inv || inv.qty<q) throw new Error("Not enough items");
        // move to escrow
        db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(q,me.id,it.id);
        db.prepare(`INSERT INTO inventory_escrow(owner_user_id,type,item_id,qty,created_at) VALUES (?,?,?,?,?)`)
          .run(me.id,'item',it.id,q,nowISO());
        // create sale
        db.prepare(`INSERT INTO sales(seller_user_id,type,item_id,qty,title,price_s,status,created_at)
                    VALUES (?,?,?,?,?,?,'live',?)`)
          .run(me.id,'item',it.id,q,it.name,price_s,nowISO());
      }else{
        const rc = db.prepare("SELECT id,name FROM recipes WHERE code=?").get(recipe_code||"");
        if (!rc) throw new Error("Unknown recipe");
        const inv = db.prepare("SELECT qty FROM user_recipes WHERE user_id=? AND recipe_id=?").get(me.id,rc.id);
        if (!inv || inv.qty<q) throw new Error("Not enough recipes");
        db.prepare("UPDATE user_recipes SET qty=qty-? WHERE user_id=? AND recipe_id=?").run(q,me.id,rc.id);
        db.prepare(`INSERT INTO inventory_escrow(owner_user_id,type,recipe_id,qty,created_at) VALUES (?,?,?,?,?)`)
          .run(me.id,'recipe',rc.id,q,nowISO());
        db.prepare(`INSERT INTO sales(seller_user_id,type,recipe_id,qty,title,price_s,status,created_at)
                    VALUES (?,?,?,?,?,?,'live',?)`)
          .run(me.id,'recipe',rc.id,q,rc.name,price_s,nowISO());
      }
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

app.post("/api/sales/buy",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  try{
    const { id } = req.body||{};
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(parseInt(id,10));
    if (!sale || sale.status!=="live") return res.status(404).json({ok:false,error:"Not found"});
    if (sale.seller_user_id === me.id) return res.status(400).json({ok:false,error:"Own listing"});
    if ((me.balance_silver||0) < sale.price_s) return res.status(400).json({ok:false,error:"Insufficient funds"});

    const tx = db.transaction(()=>{
      // charge buyer
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(sale.price_s, me.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(me.id,-sale.price_s,"SALE_BUY",String(sale.id),nowISO());

      // credit seller
      db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(sale.price_s, sale.seller_user_id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(sale.seller_user_id,+sale.price_s,"SALE_SELL",String(sale.id),nowISO());

      // release escrow to buyer
      if (sale.type==="item"){
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty
        `).run(me.id, sale.item_id, sale.qty);
      }else{
        db.prepare(`
          INSERT INTO user_recipes(user_id,recipe_id,qty,attempts) VALUES (?,?,?,0)
          ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty
        `).run(me.id, sale.recipe_id, sale.qty);
      }
      // mark sold & remove escrow
      db.prepare("UPDATE sales SET status='sold' WHERE id=?").run(sale.id);
      db.prepare("DELETE FROM inventory_escrow WHERE owner_user_id=? AND type=? AND " + (sale.type==="item"?"item_id=?":"recipe_id=?") + " AND qty>=? LIMIT 1")
        .run(sale.seller_user_id, sale.type, (sale.type==="item"?sale.item_id:sale.recipe_id), sale.qty);
    });
    tx();

    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});

app.post("/api/sales/cancel",(req,res)=>{
  const me = requireUser(req,res); if(!me) return;
  try{
    const { id } = req.body||{};
    const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(parseInt(id,10));
    if (!sale || sale.status!=="live") return res.status(404).json({ok:false,error:"Not found"});
    if (sale.seller_user_id !== me.id) return res.status(403).json({ok:false,error:"Forbidden"});

    const tx = db.transaction(()=>{
      // return from escrow to seller
      if (sale.type==="item"){
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty
        `).run(me.id, sale.item_id, sale.qty);
      }else{
        db.prepare(`
          INSERT INTO user_recipes(user_id,recipe_id,qty,attempts) VALUES (?,?,?,0)
          ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty
        `).run(me.id, sale.recipe_id, sale.qty);
      }
      db.prepare("UPDATE sales SET status='canceled' WHERE id=?").run(sale.id);
      db.prepare("DELETE FROM inventory_escrow WHERE owner_user_id=? AND type=? AND " + (sale.type==="item"?"item_id=?":"recipe_id=?") + " AND qty>=? LIMIT 1")
        .run(me.id, sale.type, (sale.type==="item"?sale.item_id:sale.recipe_id), sale.qty);
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:String(e.message||e)}); }
});

// =============== Static admin (tvoj admin.html ostaje kakav je)
app.get("/admin", (req,res)=> res.sendFile(path.join(__dirname,"public","admin.html")) );

// =============== Start
server.listen(PORT, HOST, ()=>{
  console.log(`ARTEFACT running: http://${HOST}:${PORT} (DB: ${DB_FILE})`);
});
