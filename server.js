// === ARTEFAKT ECONOMY — FULL SERVER (Render-ready) ===
// Currency: SILVER (100s = 1g)

const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");

// ----- Config (ENV first; safe fallbacks for local)
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_NAME = "token";
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";
const DEFAULT_ADMIN_EMAIL = (process.env.DEFAULT_ADMIN_EMAIL || "judi.vinko81@gmail.com").toLowerCase();

// Auctions / fees
const AUCTION_FEE_BPS = 100; // 1%
const DEFAULT_AUCTION_MINUTES = 60;

// Shop / Recipe drop tuning
// Recipe drops exactly per 1000: 800/T2, 150/T3, 37/T4, 12/T5, 1/T6
const RECIPE_DROP_MIN = 4; // inclusive
const RECIPE_DROP_MAX = 8; // inclusive
const TARGET_TIER_MASS = { 2: 800, 3: 150, 4: 37, 5: 12, 6: 1 }; // info only

const SHOP_T1_COST_S = 100; // 1g

// ----- App
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ----- Database (SEPARATE FILE / PERSISTENT PATH)
// Use DB_PATH or DB_DIR envs to keep DB out of the app dir (e.g. mounted volume on Render)
// Defaults to ./data/rps.db (folder is auto-created)
const DB_DIR = process.env.DB_DIR || path.join(process.cwd(), "data");
try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch {}
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, "rps.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ----- Helpers
const nowISO = () => new Date().toISOString();
const addMinutes = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function isValidEmail(e){ return typeof e==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.toLowerCase()); }
function isValidPassword(p){ return typeof p==="string" && p.length>=6; }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function verifyTokenFromCookies(req){
  const t=req.cookies && req.cookies[TOKEN_NAME];
  if(!t) return null;
  try{ return jwt.verify(t, JWT_SECRET); }catch{ return null; }
}
function randInt(a,b){ return a + Math.floor(Math.random()*(b-a+1)); }

// ----- Admin auth check: via header key OR admin cookie user
function isAdminRequest(req){
  const hdr = (req.headers && (req.headers["x-admin-key"] || req.headers["X-Admin-Key"])) || "";
  if (hdr && String(hdr) === String(ADMIN_KEY)) return true;
  const tok = verifyTokenFromCookies(req);
  if (!tok) return false;
  const r = db.prepare("SELECT is_admin FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin === 1);
}

// ----- Schema utils
function ensureTable(sql){ db.exec(sql); }
function ensureColumn(table, columnDef){
  const name = columnDef.split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if(!cols.some(c=>c.name===name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

// ----- Tables
ensureTable(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  gold INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  balance_silver INTEGER NOT NULL DEFAULT 0,
  shop_buy_count INTEGER NOT NULL DEFAULT 0,
  next_recipe_at INTEGER
);`);
ensureColumn("users","balance_silver INTEGER NOT NULL DEFAULT 0");
ensureColumn("users","is_disabled INTEGER NOT NULL DEFAULT 0");
ensureColumn("users","last_seen TEXT");
ensureColumn("users","shop_buy_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("users","next_recipe_at INTEGER");

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

ensureTable(`
CREATE TABLE IF NOT EXISTS user_trophies(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  earned_at TEXT NOT NULL,
  reward_s INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(item_id) REFERENCES items(id)
);`);

ensureTable(`
CREATE TABLE IF NOT EXISTS auctions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- 'item' | 'recipe'
  item_id INTEGER,
  recipe_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT,
  start_price_s INTEGER NOT NULL,
  buy_now_price_s INTEGER,
  highest_bid_s INTEGER,
  highest_bidder_user_id INTEGER,
  fee_bps INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL,                  -- 'live' | 'paid' | 'canceled'
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
ensureTable(`
CREATE TABLE IF NOT EXISTS bids(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL,
  bidder_user_id INTEGER NOT NULL,
  amount_s INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(auction_id) REFERENCES auctions(id),
  FOREIGN KEY(bidder_user_id) REFERENCES users(id)
);`);
ensureTable(`
CREATE TABLE IF NOT EXISTS money_holds(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  amount_s INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(auction_id) REFERENCES auctions(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);`);
ensureTable(`
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

// ----- Initial admin + gold->silver migration
try{
  const u=db.prepare("SELECT id FROM users WHERE email=?").get(DEFAULT_ADMIN_EMAIL);
  if(u) db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(u.id);
}catch{}
try{
  db.prepare(`UPDATE users SET balance_silver=balance_silver+(gold*100), gold=0 WHERE gold IS NOT NULL AND gold<>0`).run();
}catch{}

// ----- Seed helpers
function ensureItem(code,name,tier,volatile=0){
  const r=db.prepare("SELECT id FROM items WHERE code=?").get(code);
  if(r){ db.prepare("UPDATE items SET name=?,tier=?,volatile=? WHERE code=?").run(name,tier,volatile,code); return r.id; }
  db.prepare("INSERT INTO items(code,name,tier,volatile) VALUES (?,?,?,?)").run(code,name,tier,volatile);
  return db.prepare("SELECT id FROM items WHERE code=?").get(code).id;
}
function idByCode(code){ const r=db.prepare("SELECT id FROM items WHERE code=?").get(code); return r&&r.id; }
function ensureRecipe(code,name,tier,outCode,ings){
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
  for(const [c,q] of ings){
    const iid=idByCode(c); if(!iid) throw new Error("Missing ingredient item "+c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,?)").run(rid,iid,q);
  }
  return rid;
}

// ----- Minimal seed (compatible with UI). Add/extend as needed.
// Scrap (volatile)
ensureItem("SCRAP","Scrap",1,1);

// T1 base materials
ensureItem("STONE","Stone",1,0);
ensureItem("WOOD","Wood",1,0);
ensureItem("WOOL","Wool",1,0);
ensureItem("RESIN","Resin",1,0);
ensureItem("COPPER","Copper",1,0);
ensureItem("SAND","Sand",1,0);

// T2 components
ensureItem("GLASS","Glass",2,0);
ensureItem("ROPE","Rope",2,0);
ensureItem("TARP","Sticky cloth",2,0);
ensureItem("WIRE","Copper wire",2,0);
ensureItem("BRONZE_PLATE","Bronze plate",2,0);
ensureItem("PAPER","Paper",2,0);
ensureItem("BLADE","Blade",2,0);
ensureItem("COAT","Resin coat",2,0);
ensureItem("HANDLE","Wood handle",2,0);
ensureItem("MOLD","Mold",2,0);
ensureItem("FIBER_BUNDLE","Fiber bundle",2,0);
ensureItem("CORE_ROD","Core rod",2,0);

// T2 recipes (examples; safe with UI)
ensureRecipe("R_GLASS","Glass",2,"GLASS",[["SAND",2],["RESIN",1]]);
ensureRecipe("R_ROPE","Rope",2,"ROPE",[["WOOL",2],["WOOD",1]]);
ensureRecipe("R_TARP","Sticky cloth",2,"TARP",[["WOOL",1],["RESIN",1],["WOOD",1]]);
ensureRecipe("R_WIRE","Copper wire",2,"WIRE",[["COPPER",1],["RESIN",1],["WOOD",1]]);
ensureRecipe("R_BRONZE_PLATE","Bronze plate",2,"BRONZE_PLATE",[["COPPER",1],["STONE",1],["WOOD",1]]);
ensureRecipe("R_PAPER","Paper",2,"PAPER",[["WOOL",1],["WOOD",2]]);
ensureRecipe("R_BLADE","Blade",2,"BLADE",[["STONE",2],["WOOD",1]]);
ensureRecipe("R_COAT","Resin coat",2,"COAT",[["RESIN",2],["WOOD",1]]);
ensureRecipe("R_HANDLE","Wood handle",2,"HANDLE",[["WOOD",2],["RESIN",1]]);
ensureRecipe("R_MOLD","Mold",2,"MOLD",[["SAND",1],["RESIN",1],["STONE",1]]);
ensureRecipe("R_FIBER_BUNDLE","Fiber bundle",2,"FIBER_BUNDLE",[["WOOL",2],["RESIN",1]]);
ensureRecipe("R_CORE_ROD","Core rod",2,"CORE_ROD",[["COPPER",1],["STONE",1],["RESIN",1]]);

// Maintenance: purge orphans
try{
  db.exec(`DELETE FROM user_recipes WHERE recipe_id NOT IN (SELECT id FROM recipes);`);
  db.exec(`DELETE FROM user_items   WHERE item_id   NOT IN (SELECT id FROM items);`);
}catch{}

// On boot: remove volatile items (scrap) from inventories
try{
  const ids=db.prepare("SELECT id FROM items WHERE volatile=1").all().map(r=>r.id);
  if(ids.length){ db.prepare(`DELETE FROM user_items WHERE item_id IN (${ids.map(()=>"?").join(",")})`).run(...ids); }
}catch{}

// ================== AUTH ==================
app.post("/api/register", async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
    if(!isValidPassword(password)) return res.status(400).json({ok:false,error:"Password must be at least 6 chars."});
    const ex=db.prepare("SELECT id FROM users WHERE email=?").get((email||"").toLowerCase());
    if(ex) return res.status(409).json({ok:false,error:"User already exists."});
    const pass=await bcrypt.hash(password,10);
    db.prepare("INSERT INTO users(email,pass_hash,created_at) VALUES (?,?,?)").run(email.toLowerCase(),pass,nowISO());
    res.json({ok:true,message:"Registration successful. You can log in now."});
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
    FROM users WHERE id=?
  `).get(u.uid);
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

// ================== ADMIN ==================
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
    });
    tx();
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
app.post("/api/admin/make-admin",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email}=req.body||{};
  if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  const u=db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email);
  if(!u) return res.status(404).json({ok:false,error:"User not found"});
  db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(u.id);
  res.json({ok:true,message:"User promoted to admin."});
});
app.post("/api/admin/reset-password", async (req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email,new_password}=req.body||{};
  if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Bad email"});
  if(!isValidPassword(new_password)) return res.status(400).json({ok:false,error:"Password must be at least 6 chars."});
  const u=db.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(email);
  if(!u) return res.status(404).json({ok:false,error:"User not found"});
  const pass=await bcrypt.hash(new_password,10);
  db.prepare("UPDATE users SET pass_hash=? WHERE id=?").run(pass,u.id);
  res.json({ok:true,message:"Password reset."});
});
app.get("/api/admin/user/:id/inventory",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const uid=parseInt(req.params.id,10);
  if(!Number.isFinite(uid)) return res.status(400).json({ok:false,error:"Bad user id"});
  const has=db.prepare("SELECT id FROM users WHERE id=?").get(uid);
  if(!has) return res.status(404).json({ok:false,error:"User not found"});
  const items=db.prepare(`
    SELECT i.id,i.code,i.name,i.tier,COALESCE(ui.qty,0) qty
    FROM items i JOIN user_items ui ON ui.item_id=i.id AND ui.user_id=?
    WHERE ui.qty>0 ORDER BY i.tier ASC,i.name ASC
  `).all(uid);
  const recipes=db.prepare(`
    SELECT r.id,r.code,r.name,r.tier,COALESCE(ur.qty,0) qty, COALESCE(ur.attempts,0) attempts
    FROM recipes r JOIN user_recipes ur ON ur.recipe_id=r.id AND ur.user_id=?
    WHERE ur.qty>0 ORDER BY r.tier ASC,r.name ASC
  `).all(uid);
  res.json({ok:true,items,recipes});
});

// ================== SHOP (recipe replaces material) ==================
const T1_CODES=["STONE","WOOD","WOOL","RESIN","COPPER","SAND"];

// NEW: strict per-1000 distribution (T6:1, T5:12, T4:37, T3:150, T2:800)
function pickWeightedRecipe(){
  const list = db.prepare(`SELECT id, code, name, tier FROM recipes`).all();
  if (!list.length) return null;
  const byTier = {};
  for (const r of list){
    (byTier[r.tier] ||= []).push(r);
  }
  const roll = randInt(1, 1000);
  let targetTier;
  if (roll === 1) targetTier = 6;
  else if (roll <= 1 + 12) targetTier = 5;
  else if (roll <= 1 + 12 + 37) targetTier = 4;
  else if (roll <= 1 + 12 + 37 + 150) targetTier = 3;
  else targetTier = 2;

  let tier = targetTier;
  while (tier >= 2 && !byTier[tier]) tier--;
  if (!byTier[tier]) tier = 2;
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

      // init first drop target if missing
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

// ================== RECIPES ==================
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
    WHERE ri.recipe_id=? ORDER BY i.tier ASC,i.name ASC
  `).all(u.uid,rid);
  const enriched=ings.map(x=>({ item_id:x.id, code:x.code, name:x.name, tier:x.tier, need_qty:x.need_qty, have_qty:x.have_qty, missing:Math.max(0,x.need_qty-x.have_qty)}));
  const can_craft=enriched.every(x=>x.have_qty>=x.need_qty);
  res.json({ ok:true, recipe:{ id:rec.id,code:rec.code,name:rec.name,tier:rec.tier,attempts:rec.attempts,output_item_id:rec.output_item_id }, ingredients:enriched, can_craft });
});

// Craft — T6 no scrap; others 10% scrap
app.post("/api/recipes/:id/craft", (req, res) => {
  const u = verifyTokenFromCookies(req);
  if (!u) return res.status(401).json({ ok:false, error:"Not logged in." });
  const rid = parseInt(req.params.id, 10);

  try{
    const out = db.transaction(() => {
      const rec = db.prepare(`
        SELECT r.id, r.code, r.name, r.tier, r.output_item_id,
               COALESCE(ur.qty,0) have_qty, COALESCE(ur.attempts,0) attempts
        FROM recipes r
        LEFT JOIN user_recipes ur ON ur.recipe_id = r.id AND ur.user_id = ?
        WHERE r.id = ?
      `).get(u.uid, rid);
      if (!rec || !rec.have_qty) throw new Error("You don't own this recipe.");

      const ings = db.prepare(`
        SELECT i.id, i.code, i.name, ri.qty need_qty, COALESCE(ui.qty,0) have_qty
        FROM recipe_ingredients ri
        JOIN items i ON i.id = ri.item_id
        LEFT JOIN user_items ui ON ui.item_id = i.id AND ui.user_id = ?
        WHERE ri.recipe_id = ?
      `).all(u.uid, rid);

      for (const ing of ings){
        if (ing.have_qty < ing.need_qty){
          throw new Error(`Missing: ${ing.code} x${ing.need_qty - ing.have_qty}`);
        }
      }
      for (const ing of ings){
        db.prepare("UPDATE user_items SET qty = qty - ? WHERE user_id = ? AND item_id = ?")
          .run(ing.need_qty, u.uid, ing.id);
      }

      // Fail chance: T6 output => 0%; others => 10%
      const outTierRow = db.prepare("SELECT tier FROM items WHERE id = ?").get(rec.output_item_id);
      const outTier = outTierRow ? (outTierRow.tier|0) : rec.tier;
      const failP = (outTier >= 6) ? 0.0 : 0.10;
      const roll = Math.random();

      // track attempts (UI shows this)
      db.prepare("UPDATE user_recipes SET attempts = MIN(attempts + 1, 5) WHERE user_id = ? AND recipe_id = ?")
        .run(u.uid, rec.id);

      if (roll < failP){
        const scrap=idByCode("SCRAP");
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(u.uid,scrap);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
          .run(u.uid,0,"CRAFT_FAIL",`recipe:${rec.code}`,nowISO());
        return { ok:true, crafted:false, scrap:true, recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier} };
      }else{
        const ch = db.prepare("UPDATE user_recipes SET qty = qty - 1 WHERE user_id = ? AND recipe_id = ? AND qty > 0")
                      .run(u.uid, rec.id).changes;
        if (ch === 0) throw new Error("Recipe not available any more.");

        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty)
          VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(u.uid,rec.output_item_id);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
          .run(u.uid,0,"CRAFT_SUCCESS",`recipe:${rec.code}`,nowISO());
        const outItem=db.prepare("SELECT code,name,tier FROM items WHERE id=?").get(rec.output_item_id);
        return { ok:true, crafted:true, scrap:false, output:outItem, recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier} };
      }
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// ================== INVENTORY (for auctions)
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

// ================== AUCTIONS
app.post("/api/auctions/create",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const {code,qty=1,start_gold=0,start_silver=0,buy_gold=0,buy_silver=0,duration_min}=req.body||{};
  const look=findItemOrRecipeByCode((code||"").trim());
  if(!look) return res.status(400).json({ok:false,error:"Unknown code (item or recipe)."});
  const q=Math.max(1,Math.trunc(qty));
  const sStart=Math.trunc(start_gold||0)*100 + Math.trunc(start_silver||0);
  const sBuy  =Math.trunc(buy_gold ||0)*100 + Math.trunc(buy_silver ||0);
  if(sStart<=0) return res.status(400).json({ok:false,error:"Start price must be > 0."});
  if(sBuy && sBuy<sStart) return res.status(400).json({ok:false,error:"Buy-now must be >= start price."});
  const fee_bps=AUCTION_FEE_BPS;
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
      const end=addMinutes(now, Number.isFinite(duration_min)?Math.max(5,Math.trunc(duration_min)):DEFAULT_AUCTION_MINUTES);
      db.prepare(`
        INSERT INTO auctions
        (seller_user_id,type,item_id,recipe_id,qty,title,description,start_price_s,buy_now_price_s,highest_bid_s,highest_bidder_user_id,fee_bps,status,start_time,end_time,created_at)
        VALUES (?,?,?,?,?,?,?, ?,?,?,NULL,?, 'live',?,?,?)
      `).run(u.uid,look.kind,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,
              look.kind==="item"?`${look.it.code}`:`${look.rec.code}`,null,sStart,sBuy||null,null,fee_bps,now,end,now);
      const aid=db.prepare("SELECT last_insert_rowid() id").get().id;
      db.prepare("INSERT INTO inventory_escrow(auction_id,owner_user_id,item_id,recipe_id,qty,created_at) VALUES (?,?,?,?,?,?)")
        .run(aid,u.uid,look.kind==="item"?look.it.id:null,look.kind==="recipe"?look.rec.id:null,q,now);
      const a=db.prepare(`
        SELECT a.id,a.type,a.qty,a.start_price_s,a.buy_now_price_s,a.end_time,COALESCE(i.code,r.code) code,COALESCE(i.name,r.name) name
        FROM auctions a LEFT JOIN items i ON i.id=a.item_id LEFT JOIN recipes r ON r.id=a.recipe_id WHERE a.id=?
      `).get(aid);
      return {ok:true,auction:a};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.get("/api/auctions/live",(req,res)=>{
  const rows=db.prepare(`
    SELECT a.id,a.type,a.qty,a.start_price_s,a.buy_now_price_s,a.highest_bid_s,a.end_time,a.status,
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
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false});
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
app.post("/api/auctions/:id/bid",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
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
      return {ok:true,highest_bid_s:amount_s,your_balance_silver:bal,your_gold:Math.floor(bal/100),your_silver:bal%100};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.post("/api/auctions/:id/buy-now",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const aid=parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const a=db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if(!a||a.status!=="live") throw new Error("Auction not active.");
      if(!a.buy_now_price_s) throw new Error("No buy-now price.");
      if(u.uid===a.seller_user_id) throw new Error("Can't buy your own auction.");

      const oldHold = db.prepare("SELECT * FROM money_holds WHERE auction_id=?").get(a.id);
      if (oldHold) {
        db.prepare("UPDATE users SET balance_silver = balance_silver + ? WHERE id = ?")
          .run(oldHold.amount_s, oldHold.user_id);
        db.prepare("DELETE FROM money_holds WHERE auction_id = ?").run(a.id);
      }

      const buyer = db.prepare("SELECT id,balance_silver FROM users WHERE id=?").get(u.uid);
      if (!buyer) throw new Error("Session expired. Log in again.");
      if (buyer.balance_silver < a.buy_now_price_s) throw new Error("Insufficient funds.");
      const seller = db.prepare("SELECT id FROM users WHERE id=?").get(a.seller_user_id);

      db.prepare("UPDATE users SET balance_silver = balance_silver - ? WHERE id = ?")
        .run(a.buy_now_price_s, buyer.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(buyer.id, -a.buy_now_price_s, "AUCTION_BUY_NOW", `auction:${a.id}`, nowISO());

      const fee = Math.floor((a.buy_now_price_s * a.fee_bps) / 10000);
      const net = a.buy_now_price_s - fee;
      db.prepare("UPDATE users SET balance_silver = balance_silver + ? WHERE id = ?")
        .run(net, seller.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
        .run(seller.id, net, "AUCTION_SALE_NET", `auction:${a.id}`, nowISO());

      const esc = db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if (esc) {
        if (esc.item_id) {
          db.prepare(`
            INSERT INTO user_items(user_id,item_id,qty)
            VALUES (?,?,?)
            ON CONFLICT(user_id,item_id) DO UPDATE SET qty = qty + excluded.qty
          `).run(buyer.id, esc.item_id, esc.qty);
        } else if (esc.recipe_id) {
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty)
            VALUES (?,?,?)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty = qty + excluded.qty
          `).run(buyer.id, esc.recipe_id, esc.qty);
        }
      }
      db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);

      db.prepare("UPDATE auctions SET status='paid', sold_price_s=?, winner_user_id=? WHERE id=?")
        .run(a.buy_now_price_s, buyer.id, a.id);

      const info = db.prepare(`
        SELECT a.id,a.qty,a.sold_price_s,COALESCE(i.code,r.code) code,COALESCE(i.name,r.name) name
        FROM auctions a
        LEFT JOIN items i ON i.id=a.item_id
        LEFT JOIN recipes r ON r.id=a.recipe_id
        WHERE a.id=?
      `).get(a.id);
      const balB = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(buyer.id).balance_silver;

      return {
        ok: true,
        bought: info,
        buyer_balance_silver: balB,
        buyer_gold: Math.floor(balB / 100),
        buyer_silver: balB % 100
      };
    })();
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});
app.post("/api/auctions/:id/cancel", (req, res) => {
  const u = verifyTokenFromCookies(req); if (!u) return res.status(401).json({ ok: false, error: "Not logged in." });
  const aid = parseInt(req.params.id, 10);
  try {
    const result = db.transaction(() => {
      const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if (!a || a.seller_user_id !== u.uid) throw new Error("Not your auction.");
      if (a.status !== "live") throw new Error("Auction not active.");
      if (a.highest_bid_s && a.highest_bid_s > 0) throw new Error("Already has bids.");

      const esc = db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if (esc) {
        if (esc.item_id) {
          db.prepare(`
            INSERT INTO user_items(user_id,item_id,qty)
            VALUES (?,?,?)
            ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty
          `).run(u.uid, esc.item_id, esc.qty);
        } else if (esc.recipe_id) {
          db.prepare(`
            INSERT INTO user_recipes(user_id,recipe_id,qty)
            VALUES (?,?,?)
            ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty
          `).run(u.uid, esc.recipe_id, esc.qty);
        }
      }
      db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);
      db.prepare("UPDATE auctions SET status='canceled' WHERE id=?").run(a.id);
      return { ok: true };
    })();
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// ============== HEALTH ==============
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    msg: "Shop, Recipes, Craft & Auctions ready",
    fee_bps: AUCTION_FEE_BPS,
    recipe_drop: { min: RECIPE_DROP_MIN, max: RECIPE_DROP_MAX, approx_every: "~6 buys (random 4–8), replaces T1" },
    distribution_per_1000: TARGET_TIER_MASS,
    db_path: DB_PATH
  });
});

// ============== SOCKET.IO (optional hello) ==============
io.on("connection", s => {
  s.emit("hello", { ok: true, msg: "artefakt econ v1" });
});

// ============== START SERVER ==============
server.listen(PORT, HOST, () => {
  console.log(`DB @ ${DB_PATH}`);
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Auctions: fee=${AUCTION_FEE_BPS/100}% • default duration ${DEFAULT_AUCTION_MINUTES}min`);
  console.log(`Recipe drop per 1000: T2=800, T3=150, T4=37, T5=12, T6=1`);
});
