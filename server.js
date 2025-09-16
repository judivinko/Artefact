// ===============================
// FILE: server.js  (English)
// Express + better-sqlite3 • Recipes (T2–T6), Store, Auctions (1% fee)
// + Auth (register/login via JWT cookie) + Admin API (x-admin-key or admin JWT)
// Static client in /public (see Part 2/2 for index.html)
// ===============================

const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---- Config
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key"; // change in Render env var
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_NAME = "token";

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ---- helpers
function ensureColumn(table, columnDef){
  const name = columnDef.split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}
function normalizeEmail(e){ return String(e||"").trim().toLowerCase(); }
function now(){ return Date.now(); }
function signToken(u){ return jwt.sign({ uid:u.id, email:u.email }, JWT_SECRET, { expiresIn:"7d" }); }
function verifyTokenFromCookies(req){
  const t=req.cookies && req.cookies[TOKEN_NAME];
  if(!t) return null;
  try{ return jwt.verify(t, JWT_SECRET); }catch{ return null; }
}

// ---- schema
db.exec(`
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  tier INTEGER NOT NULL CHECK (tier IN (2,3,4,5,6))
);
CREATE TABLE IF NOT EXISTS recipe_parts (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  part_name TEXT NOT NULL,
  UNIQUE(item_id, part_name),
  FOREIGN KEY(item_id) REFERENCES items(id)
);
CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ref_name, tier)
);
CREATE TABLE IF NOT EXISTS store_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  price INTEGER NOT NULL,
  stock INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  buyer TEXT NOT NULL,
  item_name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  price_each INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auctions (
  id INTEGER PRIMARY KEY,
  seller TEXT NOT NULL,
  item_name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  qty INTEGER NOT NULL CHECK(qty>0),
  start_price INTEGER NOT NULL CHECK(start_price>=0),
  buyout_price INTEGER,
  fee_paid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active|sold|canceled
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auction_bids (
  id INTEGER PRIMARY KEY,
  auction_id INTEGER NOT NULL,
  bidder TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (auction_id) REFERENCES auctions(id)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  balance_silver INTEGER NOT NULL DEFAULT 0,
  shop_buy_count INTEGER NOT NULL DEFAULT 0,
  next_recipe_at INTEGER
);
`);

// ---- seed helpers
function upsertMaterial(name){ db.prepare("INSERT OR IGNORE INTO materials(name) VALUES (?)").run(name); }
function ensureItem(name,tier){
  const row = db.prepare("SELECT id FROM items WHERE name=?").get(name);
  if (row) return row.id;
  return db.prepare("INSERT INTO items(name,tier) VALUES (?,?)").run(name,tier).lastInsertRowid;
}
function setRecipe(itemName,tier,parts){
  if (!Array.isArray(parts) || parts.length<4 || parts.length>7) throw new Error(`Recipe ${itemName} must have 4–7 unique parts`);
  const s = new Set(parts);
  if (s.size !== parts.length) throw new Error(`Recipe ${itemName} has duplicate parts`);
  const id = ensureItem(itemName,tier);
  db.prepare("DELETE FROM recipe_parts WHERE item_id=?").run(id);
  const ins = db.prepare("INSERT INTO recipe_parts(item_id,part_name) VALUES (?,?)");
  for (const p of parts) ins.run(id,p);
}
function ensureUser(email){
  const em = normalizeEmail(email);
  if (!em) throw new Error("Unknown user");
  const row = db.prepare("SELECT id,email FROM users WHERE email=?").get(em);
  if (row) return row;
  const id = db.prepare("INSERT INTO users(email,created_at) VALUES (?,?)").run(em, now()).lastInsertRowid;
  return { id, email: em };
}
function touchUser(email){ db.prepare("UPDATE users SET last_seen=? WHERE email=?").run(now(), normalizeEmail(email)); }
function invAdd(user, name, tier, delta){
  const r = db.prepare("SELECT qty FROM inventory WHERE user_id=? AND ref_name=? AND tier=?").get(user,name,tier);
  if (!r){
    db.prepare("INSERT INTO inventory(user_id,ref_name,tier,qty) VALUES (?,?,?,?)").run(user,name,tier,Math.max(0,delta));
  }else{
    const q = r.qty + delta; if(q<0) throw new Error("Inventory would go negative");
    db.prepare("UPDATE inventory SET qty=? WHERE user_id=? AND ref_name=? AND tier=?").run(q,user,name,tier);
  }
}
function invGet(user){
  return db.prepare("SELECT ref_name AS name, tier, qty FROM inventory WHERE user_id=? ORDER BY tier,name").all(user);
}

// ---- seed data (ENGLISH NAMES)
const MATERIALS = ["Bronze","Iron","Silver","Gold","Wood","Stone","Leather","Cloth","Crystal","Obsidian"];

const T2 = [
  { name: "Nor Bronze Door",     parts: ["Bronze","Iron","Wood","Stone"] },
  { name: "Nor Silver Goblet",   parts: ["Silver","Gold","Crystal","Cloth","Leather"] },
  { name: "Nor Golden Ring",     parts: ["Gold","Silver","Crystal","Obsidian","Cloth","Leather"] },
  { name: "Nor Wooden Chest",    parts: ["Wood","Stone","Leather","Iron","Cloth","Bronze","Silver"] },
  { name: "Nor Stone Pillar",    parts: ["Stone","Wood","Iron","Cloth"] },
  { name: "Nor Leather Bag",     parts: ["Leather","Cloth","Wood","Silver","Crystal"] },
  { name: "Nor Canvas Tent",     parts: ["Cloth","Leather","Wood","Stone","Iron","Obsidian"] },
  { name: "Nor Crystal Orb",     parts: ["Crystal","Obsidian","Gold","Cloth","Wood","Leather","Bronze"] },
  { name: "Nor Obsidian Knife",  parts: ["Obsidian","Crystal","Iron","Bronze"] },
  { name: "Nor Iron Armor",      parts: ["Iron","Bronze","Leather","Cloth","Stone"] },
];

const T3 = [
  { name: "Nor Gate of Might",   parts: ["Nor Bronze Door","Nor Silver Goblet","Nor Golden Ring","Nor Wooden Chest"] },
  { name: "Nor Goblet of Wisdom",parts: ["Nor Silver Goblet","Nor Golden Ring","Nor Stone Pillar","Nor Leather Bag","Nor Canvas Tent"] },
  { name: "Nor Ring of Gleam",   parts: ["Nor Golden Ring","Nor Wooden Chest","Nor Stone Pillar","Nor Leather Bag","Nor Crystal Orb","Nor Obsidian Knife"] },
  { name: "Nor Chest of Secrets",parts: ["Nor Wooden Chest","Nor Stone Pillar","Nor Leather Bag","Nor Canvas Tent","Nor Crystal Orb","Nor Obsidian Knife","Nor Iron Armor"] },
  { name: "Nor Pillar of Strength",parts:["Nor Stone Pillar","Nor Leather Bag","Nor Canvas Tent","Nor Crystal Orb"] },
  { name: "Nor Traveler’s Bag",  parts: ["Nor Leather Bag","Nor Canvas Tent","Nor Crystal Orb","Nor Obsidian Knife","Nor Bronze Door"] },
  { name: "Nor Nomad Tent",      parts: ["Nor Canvas Tent","Nor Crystal Orb","Nor Obsidian Knife","Nor Bronze Door","Nor Iron Armor","Nor Silver Goblet"] },
  { name: "Nor Orb of Vision",   parts: ["Nor Crystal Orb","Nor Obsidian Knife","Nor Bronze Door","Nor Silver Goblet","Nor Wooden Chest","Nor Traveler’s Bag","Nor Golden Ring"] },
  { name: "Nor Knife of Gloom",  parts: ["Nor Obsidian Knife","Nor Bronze Door","Nor Iron Armor","Nor Wooden Chest"] },
  { name: "Nor Armor of Warding",parts: ["Nor Iron Armor","Nor Silver Goblet","Nor Golden Ring","Nor Leather Bag","Nor Canvas Tent"] },
];

const T4 = [
  { name: "Nor Gate of Kings",   parts: ["Nor Gate of Might","Nor Goblet of Wisdom","Nor Ring of Gleam","Nor Chest of Secrets"] },
  { name: "Nor Goblet of Life",  parts: ["Nor Goblet of Wisdom","Nor Ring of Gleam","Nor Chest of Secrets","Nor Pillar of Strength","Nor Traveler’s Bag"] },
  { name: "Nor Ring Eternal",    parts: ["Nor Ring of Gleam","Nor Chest of Secrets","Nor Pillar of Strength","Nor Traveler’s Bag","Nor Nomad Tent","Nor Orb of Vision"] },
  { name: "Nor Chest of Gods",   parts: ["Nor Chest of Secrets","Nor Pillar of Strength","Nor Traveler’s Bag","Nor Nomad Tent","Nor Orb of Vision","Nor Knife of Gloom","Nor Armor of Warding"] },
  { name: "Nor Pillar of Fate",  parts: ["Nor Pillar of Strength","Nor Traveler’s Bag","Nor Nomad Tent","Nor Orb of Vision"] },
  { name: "Nor Wanderer’s Bag",  parts: ["Nor Traveler’s Bag","Nor Nomad Tent","Nor Orb of Vision","Nor Knife of Gloom","Nor Gate of Might"] },
  { name: "Nor Tent of Destiny", parts: ["Nor Nomad Tent","Nor Orb of Vision","Nor Knife of Gloom","Nor Gate of Might","Nor Armor of Warding","Nor Goblet of Wisdom"] },
  { name: "Nor Orb of Prophecy", parts: ["Nor Orb of Vision","Nor Knife of Gloom","Nor Gate of Might","Nor Goblet of Wisdom","Nor Chest of Secrets","Nor Wanderer’s Bag","Nor Pillar of Strength"] },
  { name: "Nor Knife of Blood",  parts: ["Nor Knife of Gloom","Nor Gate of Might","Nor Armor of Warding","Nor Chest of Secrets"] },
  { name: "Nor Hero’s Armor",    parts: ["Nor Armor of Warding","Nor Goblet of Wisdom","Nor Ring of Gleam","Nor Chest of Secrets","Nor Pillar of Strength"] },
];

const T5 = [
  { name: "Nor Gate of Light",   parts: ["Nor Gate of Kings","Nor Goblet of Life","Nor Ring Eternal","Nor Chest of Gods"] },
  { name: "Nor Goblet of Blood", parts: ["Nor Goblet of Life","Nor Ring Eternal","Nor Chest of Gods","Nor Pillar of Fate","Nor Wanderer’s Bag"] },
  { name: "Nor Ring of Destiny", parts: ["Nor Ring Eternal","Nor Chest of Gods","Nor Pillar of Fate","Nor Wanderer’s Bag","Nor Tent of Destiny","Nor Orb of Prophecy"] },
  { name: "Nor Chest Infinite",  parts: ["Nor Chest of Gods","Nor Pillar of Fate","Nor Wanderer’s Bag","Nor Tent of Destiny","Nor Orb of Prophecy","Nor Knife of Blood","Nor Hero’s Armor"] },
  { name: "Nor Pillar of Time",  parts: ["Nor Pillar of Fate","Nor Wanderer’s Bag","Nor Tent of Destiny","Nor Orb of Prophecy"] },
  { name: "Nor Bag of Paths",    parts: ["Nor Wanderer’s Bag","Nor Tent of Destiny","Nor Orb of Prophecy","Nor Knife of Blood","Nor Gate of Kings"] },
  { name: "Nor Ghost Tent",      parts: ["Nor Tent of Destiny","Nor Orb of Prophecy","Nor Knife of Blood","Nor Gate of Kings","Nor Hero’s Armor","Nor Goblet of Life"] },
  { name: "Nor Orb of Power",    parts: ["Nor Orb of Prophecy","Nor Knife of Blood","Nor Gate of Kings","Nor Goblet of Life","Nor Chest of Gods","Nor Pillar of Time","Nor Bag of Paths"] },
  { name: "Nor Knife of Wind",   parts: ["Nor Knife of Blood","Nor Gate of Kings","Nor Hero’s Armor","Nor Chest of Gods"] },
  { name: "Nor Armor of Shadow", parts: ["Nor Hero’s Armor","Nor Goblet of Life","Nor Ring Eternal","Nor Chest of Gods","Nor Pillar of Fate"] },
];

const T6 = { name: "Artefact", requireDistinctT5: 10 };

// seed
(function seed(){
  if (db.prepare("SELECT COUNT(*) c FROM materials").get().c === 0) MATERIALS.forEach(upsertMaterial);
  for (const r of T2) setRecipe(r.name,2,r.parts);
  for (const r of T3) setRecipe(r.name,3,r.parts);
  for (const r of T4) setRecipe(r.name,4,r.parts);
  for (const r of T5) setRecipe(r.name,5,r.parts);
  ensureItem(T6.name,6);

  if (db.prepare("SELECT COUNT(*) c FROM store_items").get().c === 0) {
    const add = db.prepare("INSERT INTO store_items(name,tier,price,stock) VALUES (?,?,?,?)");
    add.run("Nor Bronze Door",2,120,50);
    add.run("Nor Silver Goblet",2,180,40);
    add.run("Nor Golden Ring",2,260,30);
    add.run("Nor Gate of Might",3,900,25);
    add.run("Nor Chest of Secrets",3,1400,15);
  }
})();

// ================== AUTH ==================
app.post("/api/register", async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    const em=normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).json({ok:false,error:"Invalid email."});
    if (typeof password!=="string" || password.length<6) return res.status(400).json({ok:false,error:"Password must be at least 6 chars."});
    const ex = db.prepare("SELECT id FROM users WHERE email=?").get(em);
    if (ex) return res.status(409).json({ok:false,error:"User already exists."});
    const pass = await bcrypt.hash(password,10);
    const id = db.prepare("INSERT INTO users(email,pass_hash,created_at) VALUES (?,?,?)").run(em,pass,now()).lastInsertRowid;
    const token = signToken({ id, email: em });
    res.cookie(TOKEN_NAME,token,{httpOnly:true,sameSite:"lax",secure:false,maxAge:7*24*60*60*1000});
    res.json({ok:true,message:"Registration successful."});
  }catch(e){ res.status(500).json({ok:false,error:"Server error."}); }
});

app.post("/api/login", async (req,res)=>{
  try{
    const {email,password}=req.body||{};
    const em=normalizeEmail(email);
    const u=db.prepare("SELECT id,email,pass_hash,is_disabled,is_admin,balance_silver FROM users WHERE email=?").get(em);
    if(!u) return res.status(404).json({ok:false,error:"User not found."});
    if(u.is_disabled) return res.status(403).json({ok:false,error:"Account disabled."});
    const ok = await bcrypt.compare(password||"", u.pass_hash||"");
    if(!ok) return res.status(401).json({ok:false,error:"Wrong password."});
    db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(now(),u.id);
    const token = signToken(u);
    res.cookie(TOKEN_NAME,token,{httpOnly:true,sameSite:"lax",secure:false,maxAge:7*24*60*60*1000});
    res.json({ok:true,message:"Logged in."});
  }catch(e){ res.status(500).json({ok:false,error:"Server error."}); }
});

app.get("/api/logout",(req,res)=>{
  const t=verifyTokenFromCookies(req);
  if(t) db.prepare("UPDATE users SET last_seen=? WHERE id=?").run(now(),t.uid);
  res.clearCookie(TOKEN_NAME,{httpOnly:true,sameSite:"lax",secure:false});
  res.json({ok:true,message:"Logged out."});
});

app.get("/api/me",(req,res)=>{
  const tok=verifyTokenFromCookies(req); if(!tok) return res.status(401).json({ok:false});
  const u=db.prepare("SELECT id,email,is_admin,balance_silver,shop_buy_count,next_recipe_at FROM users WHERE id=?").get(tok.uid);
  if(!u){ res.clearCookie(TOKEN_NAME,{httpOnly:true,sameSite:"lax",secure:false}); return res.status(401).json({ok:false}); }
  const g=Math.floor((u.balance_silver||0)/100), s=(u.balance_silver||0)%100;
  const buysToNext=(u.next_recipe_at==null)?null:Math.max(0,(u.next_recipe_at)-(u.shop_buy_count||0));
  res.json({ok:true,user:{ id:u.id,email:u.email,is_admin:!!u.is_admin,gold:g,silver:s,balance_silver:u.balance_silver,shop_buy_count:u.shop_buy_count,next_recipe_at:u.next_recipe_at,buys_to_next:buysToNext }});
});

// ================== RECIPES ==================
app.get("/api/recipes", (_req,res)=>{
  const readTier=(t)=>db.prepare("SELECT id,name FROM items WHERE tier=? ORDER BY name").all(t).map(it=>({
    name:it.name,
    parts: db.prepare("SELECT part_name FROM recipe_parts WHERE item_id=? ORDER BY part_name").all(it.id).map(r=>r.part_name)
  }));
  const materials = db.prepare("SELECT name FROM materials ORDER BY name").all().map(r=>r.name);
  res.json({ materials, t2:readTier(2), t3:readTier(3), t4:readTier(4), t5:readTier(5), t6:{ name:T6.name, requireDistinctT5:T6.requireDistinctT5 } });
});

app.get("/api/recipes/:tier",(req,res)=>{
  const map={t2:2,t3:3,t4:4,t5:5,"2":2,"3":3,"4":4,"5":5, materials:"materials"};
  const key=String(req.params.tier).toLowerCase();
  if(map[key]==="materials"){ return res.json(db.prepare("SELECT name FROM materials ORDER BY name").all().map(r=>r.name)); }
  const t=map[key]; if(!t) return res.status(404).json({error:"Unknown tier"});
  const rows=db.prepare("SELECT id,name FROM items WHERE tier=? ORDER BY name").all(t).map(it=>({
    name:it.name,
    parts: db.prepare("SELECT part_name FROM recipe_parts WHERE item_id=? ORDER BY part_name").all(it.id).map(r=>r.part_name)
  }));
  res.json(rows);
});

// ================== STORE ==================
app.get("/api/store", (_req,res)=>{
  res.json(db.prepare("SELECT id,name,tier,price,stock FROM store_items ORDER BY tier,name").all());
});

app.post("/api/store/buy",(req,res)=>{
  try{
    const { buyer, id, qty } = req.body||{};
    if(!buyer||!id||!qty) return res.status(400).json({error:"buyer, id, qty are required"});
    const row = db.prepare("SELECT id,name,tier,price,stock FROM store_items WHERE id=?").get(id);
    if(!row) return res.status(404).json({error:"Store item not found"});
    if(row.stock < qty) return res.status(400).json({error:"Not enough stock"});
    const tx = db.transaction(()=>{
      ensureUser(buyer); touchUser(buyer);
      db.prepare("UPDATE store_items SET stock=stock-? WHERE id=?").run(qty,id);
      db.prepare("INSERT INTO purchases(buyer,item_name,tier,qty,price_each,created_at) VALUES (?,?,?,?,?,?)")
        .run(buyer,row.name,row.tier,qty,row.price,now());
      invAdd(buyer,row.name,row.tier,qty);
    });
    tx();
    res.json({ok:true,item:row,qty});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

// ================== INVENTORY (debug/simple) ==================
app.get("/api/inventory/:user",(req,res)=>{
  const u = req.params.user; ensureUser(u); touchUser(u);
  res.json(invGet(u));
});

// ================== AUCTIONS (1% listing fee) ==================
function highestBid(auctionId){
  const b = db.prepare("SELECT MAX(amount) AS max FROM auction_bids WHERE auction_id=?").get(auctionId);
  return b && b.max ? b.max : 0;
}

app.get("/api/auctions",(_req,res)=>{
  const list = db.prepare("SELECT * FROM auctions WHERE status='active' ORDER BY created_at DESC").all()
    .map(a => ({...a, highest_bid: highestBid(a.id)}));
  res.json(list);
});

app.post("/api/auctions/create",(req,res)=>{
  try{
    const { seller,item_name,tier,qty,start_price,buyout_price } = req.body||{};
    if(!seller||!item_name||!tier||!qty||start_price==null) return res.status(400).json({error:"required: seller,item_name,tier,qty,start_price"});
    const inv = db.prepare("SELECT qty FROM inventory WHERE user_id=? AND ref_name=? AND tier=?").get(seller,item_name,tier);
    const have = inv ? inv.qty : 0; if (have < qty) return res.status(400).json({error:"Not enough in inventory"});
    const fee = Math.max(1, Math.ceil(start_price * qty * 0.01));
    const tx = db.transaction(()=>{
      ensureUser(seller); touchUser(seller);
      invAdd(seller,item_name,tier,-qty); // escrow (simple)
      db.prepare("INSERT INTO auctions(seller,item_name,tier,qty,start_price,buyout_price,fee_paid,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(seller,item_name,tier,qty,start_price,buyout_price||null,fee,'active',now());
    });
    tx();
    res.json({ok:true,fee});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

app.post("/api/auctions/bid",(req,res)=>{
  try{
    const { auction_id,bidder,amount } = req.body||{};
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if(!a || a.status!=="active") return res.status(404).json({error:"Auction not active"});
    const min = Math.max(a.start_price, highestBid(a.id)+1);
    if(!bidder || !amount || amount < min) return res.status(400).json({error:`Bid must be ≥ ${min}`});
    ensureUser(bidder); touchUser(bidder);
    db.prepare("INSERT INTO auction_bids(auction_id,bidder,amount,created_at) VALUES (?,?,?,?)").run(a.id,bidder,amount,now());
    res.json({ok:true,highest:amount});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

app.post("/api/auctions/buyout",(req,res)=>{
  try{
    const { auction_id,buyer } = req.body||{};
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if(!a || a.status!=="active") return res.status(404).json({error:"Auction not active"});
    if(!a.buyout_price) return res.status(400).json({error:"No buyout price"});
    const tx = db.transaction(()=>{
      ensureUser(buyer); touchUser(buyer);
      db.prepare("UPDATE auctions SET status='sold' WHERE id=?").run(a.id);
      invAdd(buyer,a.item_name,a.tier,a.qty);
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

app.post("/api/auctions/cancel",(req,res)=>{
  try{
    const { auction_id,seller } = req.body||{};
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if(!a || a.status!=="active") return res.status(404).json({error:"Auction not active"});
    if(a.seller !== seller) return res.status(403).json({error:"Not your auction"});
    const tx = db.transaction(()=>{
      ensureUser(seller); touchUser(seller);
      db.prepare("UPDATE auctions SET status='canceled' WHERE id=?").run(a.id);
      invAdd(seller,a.item_name,a.tier,a.qty); // return item; fee lost
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

// ================== ADMIN (x-admin-key or admin JWT) ==================
function isAdminReq(req){
  const hdr = req.headers["x-admin-key"] || req.headers["X-Admin-Key"];
  if (String(hdr||"") === String(ADMIN_KEY)) return true;
  const tok = verifyTokenFromCookies(req); if (!tok) return false;
  const r = db.prepare("SELECT is_admin FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin===1);
}
function requireAdmin(req,res,next){ if(!isAdminReq(req)) return res.status(401).json({ok:false,error:"Unauthorized"}); next(); }

app.get("/api/admin/ping", requireAdmin, (_req,res)=> res.json({ok:true,message:"Admin OK"}));
app.get("/api/admin/users", requireAdmin, (_req,res)=>{
  const rows=db.prepare(`
    SELECT id,email,is_admin,is_disabled,created_at,last_seen,balance_silver,shop_buy_count,next_recipe_at
    FROM users ORDER BY is_disabled ASC, lower(email) ASC
  `).all();
  const users = rows.map(u=>({
    id:u.id,email:u.email,is_admin:!!u.is_admin,is_disabled:!!u.is_disabled,
    created_at:u.created_at,last_seen:u.last_seen,
    balance_silver:u.balance_silver,
    gold: Math.floor((u.balance_silver||0)/100), silver: (u.balance_silver||0)%100,
    shop_buy_count:u.shop_buy_count||0, next_recipe_at:u.next_recipe_at??null
  }));
  res.json({ok:true,users});
});
app.post("/api/admin/adjust-balance", requireAdmin, (req,res)=>{
  const { email, gold=0, silver=0, delta_silver } = req.body||{};
  const em=normalizeEmail(email); if(!em) return res.status(400).json({ok:false,error:"Bad email"});
  ensureUser(em);
  const deltaS = (typeof delta_silver==="number") ? Math.trunc(delta_silver) : (Math.trunc(gold)*100 + Math.trunc(silver));
  if(!Number.isFinite(deltaS) || deltaS===0) return res.status(400).json({ok:false,error:"No change"});
  const u = db.prepare("SELECT id,balance_silver FROM users WHERE email=?").get(em);
  const after = (u.balance_silver||0)+deltaS; if(after<0) return res.status(400).json({ok:false,error:"Insufficient funds"});
  db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after,u.id);
  const updated = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
  res.json({ok:true,balance_silver:updated,gold:Math.floor(updated/100),silver:updated%100});
});
app.post("/api/admin/disable-user", requireAdmin, (req,res)=>{
  const { email, disabled } = req.body||{};
  const em = normalizeEmail(email); if(!em) return res.status(400).json({ok:false,error:"Bad email"});
  ensureUser(em);
  const flag = disabled ? 1 : 0;
  const r = db.prepare("UPDATE users SET is_disabled=? WHERE lower(email)=lower(?)").run(flag,em);
  if(!r.changes) return res.status(404).json({ok:false,error:"User not found"});
  res.json({ok:true});
});
app.get("/api/admin/user/:id/inventory", requireAdmin, (req,res)=>{
  const id=parseInt(req.params.id,10);
  const u=db.prepare("SELECT email FROM users WHERE id=?").get(id);
  if(!u) return res.status(404).json({ok:false,error:"User not found"});
  const items=db.prepare("SELECT ref_name AS name, tier, qty FROM inventory WHERE user_id=? ORDER BY tier,name").all(u.email);
  const recipes=[]; // this build does not track per-user recipe ownership
  res.json({ok:true,items,recipes});
});

// ================== Static files ==================
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (_req,res)=> res.sendFile(path.join(__dirname,"public","admin.html")));

app.listen(PORT, HOST, ()=>{
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
// ================== RECIPES ==================
app.get("/api/recipes", (_req,res)=>{
  const readTier=(t)=>db.prepare("SELECT id,name FROM items WHERE tier=? ORDER BY name").all(t).map(it=>({
    name:it.name,
    parts: db.prepare("SELECT part_name FROM recipe_parts WHERE item_id=? ORDER BY part_name").all(it.id).map(r=>r.part_name)
  }));
  const materials = db.prepare("SELECT name FROM materials ORDER BY name").all().map(r=>r.name);
  res.json({
    materials,
    t2: readTier(2), t3: readTier(3), t4: readTier(4), t5: readTier(5),
    t6: { name: T6.name, requireDistinctT5: T6.requireDistinctT5 }
  });
});

app.get("/api/recipes/:tier",(req,res)=>{
  const map={t2:2,t3:3,t4:4,t5:5,"2":2,"3":3,"4":4,"5":5, materials:"materials"};
  const key=String(req.params.tier).toLowerCase();
  if(map[key]==="materials"){
    return res.json(db.prepare("SELECT name FROM materials ORDER BY name").all().map(r=>r.name));
  }
  const t=map[key]; if(!t) return res.status(404).json({error:"Unknown tier"});
  const rows=db.prepare("SELECT id,name FROM items WHERE tier=? ORDER BY name").all(t).map(it=>({
    name:it.name,
    parts: db.prepare("SELECT part_name FROM recipe_parts WHERE item_id=? ORDER BY part_name").all(it.id).map(r=>r.part_name)
  }));
  res.json(rows);
});

// ================== STORE ==================
app.get("/api/store", (_req,res)=>{
  res.json(db.prepare("SELECT id,name,tier,price,stock FROM store_items ORDER BY tier,name").all());
});

app.post("/api/store/buy",(req,res)=>{
  try{
    const { buyer, id, qty } = req.body||{};
    if(!buyer||!id||!qty) return res.status(400).json({error:"buyer, id, qty are required"});
    const row = db.prepare("SELECT id,name,tier,price,stock FROM store_items WHERE id=?").get(id);
    if(!row) return res.status(404).json({error:"Store item not found"});
    if(row.stock < qty) return res.status(400).json({error:"Not enough stock"});
    const tx = db.transaction(()=>{
      ensureUser(buyer); touchUser(buyer);
      db.prepare("UPDATE store_items SET stock=stock-? WHERE id=?").run(qty,id);
      db.prepare("INSERT INTO purchases(buyer,item_name,tier,qty,price_each,created_at) VALUES (?,?,?,?,?,?)")
        .run(buyer,row.name,row.tier,qty,row.price,now());
      invAdd(buyer,row.name,row.tier,qty);
    });
    tx();
    res.json({ok:true,item:row,qty});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

// ================== INVENTORY (simple) ==================
app.get("/api/inventory/:user",(req,res)=>{
  const u = req.params.user; ensureUser(u); touchUser(u);
  res.json(invGet(u));
});

// ================== AUCTIONS (1% listing fee) ==================
function highestBid(auctionId){
  const b = db.prepare("SELECT MAX(amount) AS max FROM auction_bids WHERE auction_id=?").get(auctionId);
  return b && b.max ? b.max : 0;
}

app.get("/api/auctions",(_req,res)=>{
  const list = db.prepare("SELECT * FROM auctions WHERE status='active' ORDER BY created_at DESC").all()
    .map(a => ({...a, highest_bid: highestBid(a.id)}));
  res.json(list);
});

app.post("/api/auctions/create",(req,res)=>{
  try{
    const { seller,item_name,tier,qty,start_price,buyout_price } = req.body||{};
    if(!seller||!item_name||!tier||!qty||start_price==null) {
      return res.status(400).json({error:"required: seller,item_name,tier,qty,start_price"});
    }
    const inv = db.prepare("SELECT qty FROM inventory WHERE user_id=? AND ref_name=? AND tier=?").get(seller,item_name,tier);
    const have = inv ? inv.qty : 0; if (have < qty) return res.status(400).json({error:"Not enough in inventory"});
    const fee = Math.max(1, Math.ceil(start_price * qty * 0.01)); // 1% fee
    const tx = db.transaction(()=>{
      ensureUser(seller); touchUser(seller);
      invAdd(seller,item_name,tier,-qty); // escrow (simple)
      db.prepare("INSERT INTO auctions(seller,item_name,tier,qty,start_price,buyout_price,fee_paid,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(seller,item_name,tier,qty,start_price,buyout_price||null,fee,'active',now());
    });
    tx();
    res.json({ok:true,fee});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

app.post("/api/auctions/bid",(req,res)=>{
  try{
    const { auction_id,bidder,amount } = req.body||{};
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if(!a || a.status!=="active") return res.status(404).json({error:"Auction not active"});
    const min = Math.max(a.start_price, highestBid(a.id)+1);
    if(!bidder || !amount || amount < min) return res.status(400).json({error:`Bid must be ≥ ${min}`});
    ensureUser(bidder); touchUser(bidder);
    db.prepare("INSERT INTO auction_bids(auction_id,bidder,amount,created_at) VALUES (?,?,?,?)").run(a.id,bidder,amount,now());
    res.json({ok:true,highest:amount});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

app.post("/api/auctions/buyout",(req,res)=>{
  try{
    const { auction_id,buyer } = req.body||{};
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if(!a || a.status!=="active") return res.status(404).json({error:"Auction not active"});
    if(!a.buyout_price) return res.status(400).json({error:"No buyout price"});
    const tx = db.transaction(()=>{
      ensureUser(buyer); touchUser(buyer);
      db.prepare("UPDATE auctions SET status='sold' WHERE id=?").run(a.id);
      invAdd(buyer,a.item_name,a.tier,a.qty);
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

app.post("/api/auctions/cancel",(req,res)=>{
  try{
    const { auction_id,seller } = req.body||{};
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if(!a || a.status!=="active") return res.status(404).json({error:"Auction not active"});
    if(a.seller !== seller) return res.status(403).json({error:"Not your auction"});
    const tx = db.transaction(()=>{
      ensureUser(seller); touchUser(seller);
      db.prepare("UPDATE auctions SET status='canceled' WHERE id=?").run(a.id);
      invAdd(seller,a.item_name,a.tier,a.qty); // return item; fee stays spent
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});

// ================== ADMIN (x-admin-key or admin JWT) ==================
function isAdminReq(req){
  const hdr = req.headers["x-admin-key"] || req.headers["X-Admin-Key"];
  if (String(hdr||"") === String(ADMIN_KEY)) return true;
  const tok = verifyTokenFromCookies(req); if (!tok) return false;
  const r = db.prepare("SELECT is_admin FROM users WHERE id=?").get(tok.uid);
  return !!(r && r.is_admin===1);
}
function requireAdmin(req,res,next){ if(!isAdminReq(req)) return res.status(401).json({ok:false,error:"Unauthorized"}); next(); }

app.get("/api/admin/ping", requireAdmin, (_req,res)=> res.json({ok:true,message:"Admin OK"}));

app.get("/api/admin/users", requireAdmin, (_req,res)=>{
  const rows=db.prepare(`
    SELECT id,email,is_admin,is_disabled,created_at,last_seen,balance_silver,shop_buy_count,next_recipe_at
    FROM users ORDER BY is_disabled ASC, lower(email) ASC
  `).all();
  const users = rows.map(u=>({
    id:u.id,email:u.email,is_admin:!!u.is_admin,is_disabled:!!u.is_disabled,
    created_at:u.created_at,last_seen:u.last_seen,
    balance_silver:u.balance_silver,
    gold: Math.floor((u.balance_silver||0)/100), silver: (u.balance_silver||0)%100,
    shop_buy_count:u.shop_buy_count||0, next_recipe_at:u.next_recipe_at??null
  }));
  res.json({ok:true,users});
});

app.post("/api/admin/adjust-balance", requireAdmin, (req,res)=>{
  const { email, gold=0, silver=0, delta_silver } = req.body||{};
  const em=normalizeEmail(email); if(!em) return res.status(400).json({ok:false,error:"Bad email"});
  ensureUser(em);
  const deltaS = (typeof delta_silver==="number") ? Math.trunc(delta_silver) : (Math.trunc(gold)*100 + Math.trunc(silver));
  if(!Number.isFinite(deltaS) || deltaS===0) return res.status(400).json({ok:false,error:"No change"});
  const u = db.prepare("SELECT id,balance_silver FROM users WHERE email=?").get(em);
  const after = (u.balance_silver||0)+deltaS; if(after<0) return res.status(400).json({ok:false,error:"Insufficient funds"});
  db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after,u.id);
  const updated = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
  res.json({ok:true,balance_silver:updated,gold:Math.floor(updated/100),silver:updated%100});
});

app.post("/api/admin/disable-user", requireAdmin, (req,res)=>{
  const { email, disabled } = req.body||{};
  const em = normalizeEmail(email); if(!em) return res.status(400).json({ok:false,error:"Bad email"});
  ensureUser(em);
  const flag = disabled ? 1 : 0;
  const r = db.prepare("UPDATE users SET is_disabled=? WHERE lower(email)=lower(?)").run(flag,em);
  if(!r.changes) return res.status(404).json({ok:false,error:"User not found"});
  res.json({ok:true});
});

app.get("/api/admin/user/:id/inventory", requireAdmin, (req,res)=>{
  const id=parseInt(req.params.id,10);
  const u=db.prepare("SELECT email FROM users WHERE id=?").get(id);
  if(!u) return res.status(404).json({ok:false,error:"User not found"});
  const items=db.prepare("SELECT ref_name AS name, tier, qty FROM inventory WHERE user_id=? ORDER BY tier,name").all(u.email);
  const recipes=[]; // this build does not track per-user recipe ownership
  res.json({ok:true,items,recipes});
});

// ================== Static files & Admin page ==================
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (_req,res)=> res.sendFile(path.join(__dirname,"public","admin.html")));

// ================== START ==================
app.listen(PORT, HOST, ()=>{
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
