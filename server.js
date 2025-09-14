// === ECONOMY V3 — Shop + Recipes + Craft + Auctions (bid + buy-now + 1% fee) ===
// Currency: SILVER (100s = 1g)

const express = require("express");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ---- Config (PORT & secrets via env, with safe fallbacks for dev) ----
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_NAME = "token";
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key";

// Auctions
const AUCTION_FEE_BPS = 100;            // 1%
const DEFAULT_AUCTION_MINUTES = 60;

// Shop/Drop
const SHOP_T1_COST_S = 100;             // 1g
const DROP_BASE_INTERVAL = 25;          // avg purchases to next recipe
const DROP_JITTER = 5;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "rps.db"));
db.pragma("journal_mode = WAL");

// ---- Helpers ----
function isValidEmail(e){ return typeof e==="string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.toLowerCase()); }
function isValidPassword(p){ return typeof p==="string" && p.length>=6; }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function verifyTokenFromCookies(req){ const t=req.cookies&&req.cookies[TOKEN_NAME]; if(!t) return null; try{ return jwt.verify(t,JWT_SECRET);}catch{ return null; } }
function isAdminRequest(req){
  // either x-admin-key OR a logged-in user with is_admin=1
  if(req.headers && req.headers["x-admin-key"] === ADMIN_KEY) return true;
  const u=verifyTokenFromCookies(req);
  if(!u) return false;
  const r=db.prepare("SELECT is_admin FROM users WHERE id=?").get(u.uid);
  return !!(r && r.is_admin===1);
}
const nowISO = ()=> new Date().toISOString();
const addMinutes = (iso,m)=> new Date(new Date(iso).getTime()+m*60000).toISOString();
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));

// ---- Schema utils ----
function ensureTable(sql){ db.exec(sql); }
function ensureColumn(table, columnDef){
  const name = columnDef.split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if(!cols.some(c=>c.name===name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
}

// ---- Tables ----
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

try{
  // Legacy gold -> silver migration (safe if already done)
  db.prepare(`UPDATE users SET balance_silver=balance_silver+(gold*100), gold=0 WHERE gold IS NOT NULL AND gold<>0`).run();
}catch{}

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

// Auctions
ensureTable(`
CREATE TABLE IF NOT EXISTS auctions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
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
  status TEXT NOT NULL,
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

// ---- Seed (unchanged from your version; keeping core demo items/recipes) ----
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
    const iid=idByCode(c);
    db.prepare("INSERT INTO recipe_ingredients(recipe_id,item_id,qty) VALUES (?,?,?)").run(rid,iid,q);
  }
  return rid;
}

// SCRAP
ensureItem("SKR","Scrap",1,1);

// T1
ensureItem("KAM","Stone",1,0);
ensureItem("DRV","Wood",1,0);
ensureItem("VUN","Wool",1,0);
ensureItem("SMO","Resin",1,0);
ensureItem("BAK","Copper",1,0);
ensureItem("PIJ","Sand",1,0);

// T2
ensureItem("STK","Glass",2,0);
ensureItem("UZE","Rope",2,0);
ensureItem("LJP","Sticky Cloth",2,0);
ensureItem("ZIC","Copper Wire",2,0);
ensureItem("BRP","Bronze Plate",2,0);
ensureItem("PAP","Paper",2,0);
ensureItem("SJC","Blade",2,0);
ensureItem("SMP","Resin Coat",2,0);
ensureItem("DRH","Wooden Handle",2,0);
ensureItem("KLP","Mold",2,0);
ensureItem("SVB","Fiber Bundle",2,0);
ensureItem("JSR","Core Rod",2,0);

// T2 recipes
ensureRecipe("R_STK","Glass",2,"STK",[["PIJ",1],["PIJ",1],["SMO",1]]);
ensureRecipe("R_UZE","Rope",2,"UZE",[["VUN",1],["VUN",1],["DRV",1]]);
ensureRecipe("R_LJP","Sticky Cloth",2,"LJP",[["VUN",1],["SMO",1],["DRV",1]]);
ensureRecipe("R_ZIC","Copper Wire",2,"ZIC",[["BAK",1],["SMO",1],["DRV",1]]);
ensureRecipe("R_BRP","Bronze Plate",2,"BRP",[["BAK",1],["KAM",1],["DRV",1]]);
ensureRecipe("R_PAP","Paper",2,"PAP",[["VUN",1],["DRV",1],["DRV",1]]);
ensureRecipe("R_SJC","Blade",2,"SJC",[["KAM",1],["KAM",1],["DRV",1]]);
ensureRecipe("R_SMP","Resin Coat",2,"SMP",[["SMO",1],["SMO",1],["DRV",1]]);
ensureRecipe("R_DRH","Wooden Handle",2,"DRH",[["DRV",1],["DRV",1],["SMO",1]]);
ensureRecipe("R_KLP","Mold",2,"KLP",[["PIJ",1],["SMO",1],["KAM",1]]);
ensureRecipe("R_SVB","Fiber Bundle",2,"SVB",[["VUN",1],["VUN",1],["SMO",1]]);
ensureRecipe("R_JSR","Core Rod",2,"JSR",[["BAK",1],["KAM",1],["SMO",1]]);

// T3 (sample)
ensureItem("STB","Glass Bottle",3,0);
ensureItem("OKA","Reinforced Cable",3,0);
ensureItem("BRN","Bronze Knife",3,0);
ensureRecipe("R_STB","Glass Bottle",3,"STB",[["STK",1],["LJP",1],["UZE",1]]);
ensureRecipe("R_OKA","Reinforced Cable",3,"OKA",[["ZIC",1],["SVB",1],["SMP",1]]);
ensureRecipe("R_BRN","Bronze Knife",3,"BRN",[["SJC",1],["DRH",1],["SMP",1]]);

// T4
ensureItem("LMP","Lamp",4,0);
ensureItem("PRC","Precision Tool",4,0);
ensureRecipe("R_LMP","Lamp",4,"LMP",[["STB",1],["OKA",1],["BRP",1]]);
ensureRecipe("R_PRC","Precision Tool",4,"PRC",[["BRN",1],["KLP",1],["PAP",1]]);

// T5
ensureItem("GEN","Generator",5,0);
ensureItem("MOD","Module",5,0);
ensureRecipe("R_GEN","Generator",5,"GEN",[["LMP",1],["PRC",1],["JSR",1]]);
ensureRecipe("R_MOD","Module",5,"MOD",[["LMP",1],["OKA",1],["BRN",1]]);

// T6 (artifacts)
ensureItem("AR1","Artifact Alpha",6,0);
ensureItem("AR2","Artifact Beta",6,0);
ensureItem("AR3","Artifact Gamma",6,0);
ensureRecipe("R_AR1","Artifact Alpha",6,"AR1",[["GEN",1],["MOD",1],["PRC",1]]);
ensureRecipe("R_AR2","Artifact Beta",6,"AR2",[["GEN",1],["LMP",1],["BRN",1]]);
ensureRecipe("R_AR3","Artifact Gamma",6,"AR3",[["MOD",1],["PRC",1],["STB",1]]);

// clean volatile scrap on start
try{
  const ids=db.prepare("SELECT id FROM items WHERE volatile=1").all().map(r=>r.id);
  if(ids.length){ db.prepare(`DELETE FROM user_items WHERE item_id IN (${ids.map(()=>"?").join(",")})`).run(...ids); }
}catch{}

// ---- AUTH ----
app.post("/api/register", async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
    if(!isValidPassword(password)) return res.status(400).json({ok:false,error:"Password must be 6+ chars."});
    const ex=db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
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
  const r=db.prepare("SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(u.uid);
  const g=Math.floor((r.balance_silver||0)/100), s=(r.balance_silver||0)%100;
  const buysToNext=(r.next_recipe_at==null)?null:Math.max(0,(r.next_recipe_at|0)-(r.shop_buy_count|0));
  res.json({ok:true,user:{id:r.id,email:r.email,is_admin:!!r.is_admin,gold:g,silver:s,balance_silver:r.balance_silver,shop_buy_count:r.shop_buy_count,next_recipe_at:r.next_recipe_at,buys_to_next:buysToNext}});
});

// ---- ADMIN: balance (grant/take) ----
app.post("/api/admin/adjust-balance",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const {email,gold=0,silver=0,delta_silver}=req.body||{};
  if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
  const u=db.prepare("SELECT id,balance_silver FROM users WHERE email=?").get(email.toLowerCase());
  if(!u) return res.status(404).json({ok:false,error:"User not found."});
  let deltaS=(typeof delta_silver==="number")?Math.trunc(delta_silver):(Math.trunc(gold)*100+Math.trunc(silver));
  if(deltaS===0) return res.status(400).json({ok:false,error:"No change."});
  const tx=db.transaction(()=>{
    const after=(u.balance_silver||0)+deltaS; if(after<0) throw new Error("Insufficient funds.");
    db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after,u.id);
    db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
      .run(u.id,deltaS,"ADMIN_ADJUST",null,nowISO());
  });
  try{ tx(); const updated=db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
    res.json({ok:true,balance_silver:updated,gold:Math.floor((updated||0)/100),silver:(updated||0)%100});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// ---- ADMIN: rescue make-admin ----
app.post("/api/admin/make-admin", (req, res) => {
  if(!(req.headers && req.headers["x-admin-key"] === ADMIN_KEY))
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  const { email } = req.body||{};
  if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
  const u=db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
  if(!u) return res.status(404).json({ok:false,error:"User not found."});
  db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(u.id);
  res.json({ok:true,message:"Admin granted."});
});

// ---- ADMIN: reset password (rescue) ----
app.post("/api/admin/reset-password", async (req,res)=>{
  if(!(req.headers && req.headers["x-admin-key"] === ADMIN_KEY))
    return res.status(401).json({ ok:false, error:"Unauthorized" });
  try{
    const { email, new_password } = req.body||{};
    if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
    if(!isValidPassword(new_password)) return res.status(400).json({ok:false,error:"Password must be 6+ chars."});
    const u=db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
    if(!u) return res.status(404).json({ok:false,error:"User not found."});
    const pass=await bcrypt.hash(new_password,10);
    db.prepare("UPDATE users SET pass_hash=? WHERE id=?").run(pass,u.id);
    res.json({ok:true,message:"Password updated."});
  }catch(e){ res.status(500).json({ok:false,error:"Server error."}); }
});

// ---- ADMIN: enable/disable user ----
app.post("/api/admin/disable-user",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const { email, disabled } = req.body||{};
  if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
  const u=db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
  if(!u) return res.status(404).json({ok:false,error:"User not found."});
  db.prepare("UPDATE users SET is_disabled=? WHERE id=?").run(disabled?1:0,u.id);
  res.json({ok:true});
});

// ---- ADMIN: list users (fixes your crash) ----
app.get("/api/admin/users",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const search=(req.query.search||"").toLowerCase().trim();
  let rows=db.prepare(`SELECT id,email,is_admin,is_disabled,created_at,last_seen,balance_silver,shop_buy_count,next_recipe_at
                       FROM users`).all();
  if(search) rows = rows.filter(r => (r.email||"").toLowerCase().includes(search));
  // active first, then A-Z
  rows.sort((a,b)=>{
    const da=(a.is_disabled|0), dbb=(b.is_disabled|0);
    if(da!==dbb) return da-dbb;
    return (a.email||"").toLowerCase().localeCompare((b.email||"").toLowerCase());
  });
  const users = rows.map(r=>({
    id:r.id,
    email:r.email,
    is_admin:!!r.is_admin,
    is_disabled:!!r.is_disabled,
    gold: Math.floor(((r.balance_silver||0))/100),
    silver: ((r.balance_silver||0))%100,
    created_at:r.created_at||null,
    last_seen:r.last_seen||null,
    shop_buy_count:r.shop_buy_count??null,
    next_recipe_at:r.next_recipe_at??null
  }));
  res.json({ok:true, users});
});

// ---- ADMIN: user inventory (for right column details) ----
app.get("/api/admin/user-inventory",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const { email, user_id } = req.query||{};
  let uid = null;
  if(user_id) uid = parseInt(user_id,10);
  if(!uid && email && isValidEmail(email)){
    const u = db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
    if(u) uid = u.id;
  }
  if(!uid) return res.status(400).json({ok:false,error:"User not found."});
  const items=db.prepare(`
    SELECT i.code,i.name,i.tier,ui.qty
    FROM user_items ui JOIN items i ON i.id=ui.item_id
    WHERE ui.user_id=? AND ui.qty>0 ORDER BY i.tier ASC,i.name ASC`).all(uid);
  const recipes=db.prepare(`
    SELECT r.code,r.name,r.tier,ur.qty,ur.attempts
    FROM user_recipes ur JOIN recipes r ON r.id=ur.recipe_id
    WHERE ur.user_id=? AND ur.qty>0 ORDER BY r.tier ASC,r.name ASC`).all(uid);
  res.json({ok:true, items, recipes});
});

// ---- ADMIN: hard delete user (safe guards) ----
app.post("/api/admin/hard-delete-user",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const { email } = req.body||{};
  if(!isValidEmail(email)) return res.status(400).json({ok:false,error:"Invalid email."});
  const u=db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
  if(!u) return res.status(404).json({ok:false,error:"User not found."});
  try{
    const tx=db.transaction(()=>{
      // active money holds? then block
      const holds=db.prepare("SELECT COUNT(1) c FROM money_holds WHERE user_id=?").get(u.id).c|0;
      const liveAuctions=db.prepare("SELECT COUNT(1) c FROM auctions WHERE seller_user_id=? AND status='live'").get(u.id).c|0;
      if(holds>0 || liveAuctions>0) throw new Error("User has active auctions/holds.");
      db.prepare("DELETE FROM bids WHERE bidder_user_id=?").run(u.id);
      db.prepare("DELETE FROM money_holds WHERE user_id=?").run(u.id);
      db.prepare("DELETE FROM inventory_escrow WHERE owner_user_id=?").run(u.id);
      db.prepare("DELETE FROM user_items WHERE user_id=?").run(u.id);
      db.prepare("DELETE FROM user_recipes WHERE user_id=?").run(u.id);
      db.prepare("DELETE FROM user_trophies WHERE user_id=?").run(u.id);
      db.prepare("DELETE FROM auctions WHERE seller_user_id=?").run(u.id);
      db.prepare("DELETE FROM gold_ledger WHERE user_id=?").run(u.id);
      db.prepare("DELETE FROM users WHERE id=?").run(u.id);
    });
    tx();
    res.json({ok:true,message:"User deleted."});
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// ---- ADMIN: wipe economy (after test period) ----
app.post("/api/admin/wipe-economy",(req,res)=>{
  if(!isAdminRequest(req)) return res.status(401).json({ok:false,error:"Unauthorized"});
  const { confirm } = req.body||{};
  if(confirm!=="WIPE") return res.status(400).json({ok:false,error:"Type WIPE to confirm."});
  const now=nowISO();
  const tx=db.transaction(()=>{
    // cancel live auctions & refund holds
    const lives=db.prepare("SELECT id FROM auctions WHERE status='live'").all();
    for(const a of lives){
      const hold=db.prepare("SELECT * FROM money_holds WHERE auction_id=?").get(a.id);
      if(hold){
        db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(hold.amount_s,hold.user_id);
        db.prepare("DELETE FROM money_holds WHERE auction_id=?").run(a.id);
      }
      // return escrow to owners
      const esc=db.prepare("SELECT * FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if(esc){
        if(esc.item_id){
          db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`).run(esc.owner_user_id,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?)
                      ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`).run(esc.owner_user_id,esc.recipe_id,esc.qty);
        }
        db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);
      }
      db.prepare("UPDATE auctions SET status='canceled', end_time=? WHERE id=?").run(now,a.id);
    }
    db.exec("DELETE FROM bids");
    db.exec("DELETE FROM inventory_escrow");
    db.exec("DELETE FROM auctions");
    db.exec("DELETE FROM user_items");
    db.exec("DELETE FROM user_recipes");
    db.exec("DELETE FROM user_trophies");
    db.exec("UPDATE users SET balance_silver=0, shop_buy_count=0, next_recipe_at=NULL");
    db.exec("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) SELECT id,0,'WIPE',NULL,datetime('now') FROM users");
  });
  tx();
  res.json({ok:true,message:"Economy wiped."});
});

// ---- SHOP ----
const T1_CODES=["KAM","DRV","VUN","SMO","BAK","PIJ"];
const randomT1=()=> T1_CODES[Math.floor(Math.random()*T1_CODES.length)];
function chooseWeighted(arr){const t=arr.reduce((s,a)=>s+a.weight,0); let r=Math.random()*t; for(const a of arr){ if((r-=a.weight)<0) return a; } return arr[arr.length-1];}
function nextInterval(){ const jitter=Math.floor(Math.random()*(DROP_JITTER*2+1))-DROP_JITTER; return Math.max(5,DROP_BASE_INTERVAL+jitter); }
function grantRandomRecipeIfDue(userId){
  const u=db.prepare("SELECT shop_buy_count,next_recipe_at FROM users WHERE id=?").get(userId);
  if(!u) return {granted:false};
  if(u.next_recipe_at==null){
    db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run((u.shop_buy_count|0)+nextInterval(),userId);
    return {granted:false};
  }
  if((u.shop_buy_count|0) < (u.next_recipe_at|0)) return {granted:false};

  const list=db.prepare(`SELECT id,code,name,tier FROM recipes`).all();
  if(!list.length){
    db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run((u.shop_buy_count|0)+nextInterval(),userId);
    return {granted:false};
  }
  const W={2:55,3:28,4:12,5:4,6:1};
  const pick=chooseWeighted(list.map(r=>({...r,weight:W[r.tier]||1})));

  db.prepare(`
    INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
    VALUES (?,?,1,0)
    ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty = qty + 1
  `).run(userId,pick.id);

  db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)")
    .run(userId,0,"RECIPE_DROP",`recipe:${pick.code}`,nowISO());

  db.prepare("UPDATE users SET next_recipe_at=? WHERE id=?").run((u.shop_buy_count|0)+nextInterval(),userId);
  return {granted:true,recipe:{id:pick.id,code:pick.code,name:pick.name,tier:pick.tier}};
}

app.post("/api/shop/buy-t1",(req,res)=>{
  const uTok=verifyTokenFromCookies(req);
  if(!uTok) return res.status(401).json({ok:false,error:"Not logged in."});
  try{
    const result=db.transaction(()=>{
      const user=db.prepare("SELECT id,balance_silver,shop_buy_count FROM users WHERE id=?").get(uTok.uid);
      if((user.balance_silver||0)<SHOP_T1_COST_S) throw new Error("Insufficient funds.");
      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(SHOP_T1_COST_S,user.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(user.id,-SHOP_T1_COST_S,"SHOP_BUY_T1",null,nowISO());

      const code=randomT1(), iid=idByCode(code);
      db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
                  ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1`).run(user.id,iid);

      db.prepare("UPDATE users SET shop_buy_count=shop_buy_count+1 WHERE id=?").run(user.id);
      const drop=grantRandomRecipeIfDue(user.id);

      const bal=db.prepare("SELECT balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(user.id);
      const buysToNext=(bal.next_recipe_at==null)?null:Math.max(0,(bal.next_recipe_at|0)-(bal.shop_buy_count|0));
      const g=Math.floor((bal.balance_silver||0)/100), s=(bal.balance_silver||0)%100;
      const itemRow=db.prepare("SELECT code,name FROM items WHERE id=?").get(iid);

      return { ok:true,
        addedItem:itemRow,
        gold:g, silver:s, balance_silver:bal.balance_silver,
        shop_buy_count:bal.shop_buy_count,
        buys_to_next: buysToNext,
        grantedRecipe: drop.granted ? drop.recipe : null
      };
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// ---- RECIPES ----
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

      for(const ing of ings){ if(ing.have_qty<ing.need_qty) throw new Error(`Missing: ${igSafe(ing.code)} x${ing.need_qty-ing.have_qty}`); }
      for(const ing of ings){ db.prepare("UPDATE user_items SET qty=qty-? WHERE user_id=? AND item_id=?").run(ing.need_qty,u.uid,ing.id); }

      const attempts=clamp((rec.attempts|0),0,5);
      const failP=Math.max(0.15, 0.25 - attempts*0.02);
      const roll=Math.random();

      db.prepare(`
        INSERT INTO user_recipes(user_id,recipe_id,qty,attempts)
        VALUES (?,?,1,1)
        ON CONFLICT(user_id,recipe_id) DO UPDATE SET attempts=MIN(attempts+1,5)
      `).run(u.uid,rec.id);

      if(roll<failP){
        const skr=idByCode("SKR");
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(u.uid,skr);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(u.uid,0,"CRAFT_FAIL",`recipe:${rec.code}`,nowISO());
        return { ok:true, crafted:false, scrap:true, recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier} };
      }else{
        db.prepare(`
          INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,1)
          ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+1
        `).run(u.uid,rec.output_item_id);
        db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(u.uid,0,"CRAFT_SUCCESS",`recipe:${rec.code}`,nowISO());
        const outItem=db.prepare("SELECT code,name,tier FROM items WHERE id=?").get(rec.output_item_id);
        return { ok:true, crafted:true, scrap:false, output:outItem, recipe:{id:rec.id,code:rec.code,name:rec.name,tier:rec.tier} };
      }
    })();
    res.json(out);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
function igSafe(x){ return String(x||"").replace(/[<>\n\r]/g,""); }

// ---- INVENTORY ----
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

// ---- Auctions helpers ----
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

// ---- AUCTIONS CRUD ----
app.post("/api/auctions/create",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const {code,qty=1,start_gold=0,start_silver=0,buy_gold=0,buy_silver=0,duration_min}=req.body||{};
  const look=findItemOrRecipeByCode((code||"").trim());
  if(!look) return res.status(400).json({ok:false,error:"Unknown code (item or recipe)."});
  const q=Math.max(1,Math.trunc(qty));
  const sStart=Math.trunc(start_gold||0)*100 + Math.trunc(start_silver||0);
  const sBuy  =Math.trunc(buy_gold ||0)*100 + Math.trunc(buy_silver ||0);
  if(sStart<=0) return res.status(400).json({ok:false,error:"Start price must be > 0."});
  if(sBuy && sBuy<sStart) return res.status(400).json({ok:false,error:"Buy-now cannot be lower than start."});
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
      if(u.uid===a.seller_user_id) throw new Error("Can't bid on your auction.");
      const minAccept=Math.max(a.start_price_s,(a.highest_bid_s||0)+1);
      if(amount_s<minAccept) throw new Error(`Too low. Min: ${Math.floor(minAccept/100)}g ${minAccept%100}s`);
      const me=db.prepare("SELECT id,balance_silver FROM users WHERE id=?").get(u.uid);
      if((me.balance_silver||0)<amount_s) throw new Error("Insufficient funds.");
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
      return {ok:true,highest_bid_s:amount_s,your_balance_silver:bal,your_gold:Math.floor((bal||0)/100),your_silver:(bal||0)%100};
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
      if(u.uid===a.seller_user_id) throw new Error("Can't buy your auction.");

      const oldHold=db.prepare("SELECT * FROM money_holds WHERE auction_id=?").get(a.id);
      if(oldHold){
        db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(oldHold.amount_s,oldHold.user_id);
        db.prepare("DELETE FROM money_holds WHERE auction_id=?").run(a.id);
      }

      const buyer=db.prepare("SELECT id,balance_silver FROM users WHERE id=?").get(u.uid);
      if((buyer.balance_silver||0)<a.buy_now_price_s) throw new Error("Insufficient funds.");
      const seller=db.prepare("SELECT id FROM users WHERE id=?").get(a.seller_user_id);

      db.prepare("UPDATE users SET balance_silver=balance_silver-? WHERE id=?").run(a.buy_now_price_s,buyer.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(buyer.id,-a.buy_now_price_s,"AUCTION_BUY_NOW",`auction:${a.id}`,nowISO());

      const fee=Math.floor((a.buy_now_price_s*a.fee_bps)/10000), net=a.buy_now_price_s-fee;
      db.prepare("UPDATE users SET balance_silver=balance_silver+? WHERE id=?").run(net,seller.id);
      db.prepare("INSERT INTO gold_ledger(user_id,delta_s,reason,ref,created_at) VALUES (?,?,?,?,?)").run(seller.id,net,"AUCTION_SALE_NET",`auction:${a.id}`,nowISO());

      const esc=db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if(esc){
        if(esc.item_id){
          db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`).run(buyer.id,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?) ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`).run(buyer.id,esc.recipe_id,esc.qty);
        }
      }
      db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);
      db.prepare("UPDATE auctions SET status='paid',sold_price_s=?,winner_user_id=? WHERE id=?").run(a.buy_now_price_s,buyer.id,a.id);

      const info=db.prepare(`SELECT a.id,a.qty,a.sold_price_s,COALESCE(i.code,r.code) code,COALESCE(i.name,r.name) name
                             FROM auctions a LEFT JOIN items i ON i.id=a.item_id LEFT JOIN recipes r ON r.id=a.recipe_id
                             WHERE a.id=?`).get(a.id);
      const balB=db.prepare("SELECT balance_silver FROM users WHERE id=?").get(buyer.id).balance_silver;
      return {ok:true,bought:info,buyer_balance_silver:balB,buyer_gold:Math.floor((balB||0)/100),buyer_silver:(balB||0)%100};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});
app.post("/api/auctions/:id/cancel",(req,res)=>{
  const u=verifyTokenFromCookies(req); if(!u) return res.status(401).json({ok:false,error:"Not logged in."});
  const aid=parseInt(req.params.id,10);
  try{
    const result=db.transaction(()=>{
      const a=db.prepare("SELECT * FROM auctions WHERE id=?").get(aid);
      if(!a||a.seller_user_id!==u.uid) throw new Error("Not your auction.");
      if(a.status!=="live") throw new Error("Auction not active.");
      if(a.highest_bid_s && a.highest_bid_s>0) throw new Error("There are already bids.");

      const esc=db.prepare("SELECT item_id,recipe_id,qty FROM inventory_escrow WHERE auction_id=?").get(a.id);
      if(esc){
        if(esc.item_id){
          db.prepare(`INSERT INTO user_items(user_id,item_id,qty) VALUES (?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`).run(u.uid,esc.item_id,esc.qty);
        }else if(esc.recipe_id){
          db.prepare(`INSERT INTO user_recipes(user_id,recipe_id,qty) VALUES (?,?,?) ON CONFLICT(user_id,recipe_id) DO UPDATE SET qty=qty+excluded.qty`).run(u.uid,esc.recipe_id,esc.qty);
        }
      }
      db.prepare("DELETE FROM inventory_escrow WHERE auction_id=?").run(a.id);
      db.prepare("UPDATE auctions SET status='canceled' WHERE id=?").run(a.id);
      return {ok:true};
    })();
    res.json(result);
  }catch(e){ res.status(400).json({ok:false,error:String(e.message||e)}); }
});

// ---- Health ----
app.get("/api/health",(req,res)=> res.json({ ok:true, msg:"Shop, Recipes, Craft & Auctions ready", fee_bps:AUCTION_FEE_BPS }));
io.on("connection", s => s.emit("hello",{ok:true,msg:"econ v3"}));

server.listen(PORT,HOST,()=>{
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Auctions: fee=${AUCTION_FEE_BPS/100}% • default duration ${DEFAULT_AUCTION_MINUTES}min`);
});
