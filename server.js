// ===============================
// FILE: server.js
// Express + better-sqlite3 • Recepti (T2–T6), Prodavnica, Aukcija (sa taksom 1%)
// + Admin API (x-admin-key) kompatibilan sa /public/admin.html
// Drop-in: kopiraj u root repozitorija. Render start: `node server.js`
// ===============================

const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const ADMIN_KEY = process.env.ADMIN_KEY || "dev-admin-key"; // promijeni u Render varijabli
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

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
-- jednostavan inventar
CREATE TABLE IF NOT EXISTS inventory (
  user_id TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  tier INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, ref_name, tier)
);
-- prodavnica
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
-- aukcije
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
-- users (za admin panel)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_disabled INTEGER NOT NULL DEFAULT 0,
  balance_silver INTEGER NOT NULL DEFAULT 0,
  shop_buy_count INTEGER NOT NULL DEFAULT 0,
  next_recipe_at INTEGER
);
`);

// --------------------------------------
// Seed — materijali, recepti, prodavnica
// --------------------------------------
const MATERIALS = [
  "Bronza","Željezo","Srebro","Zlato","Drvo","Kamen","Koža","Platno","Kristal","Obsidijan"
];

const T2 = [
  { name: "Nor bronzena vrata", parts: ["Bronza","Željezo","Drvo","Kamen"] },
  { name: "Nor srebrni pehar", parts: ["Srebro","Zlato","Kristal","Platno","Koža"] },
  { name: "Nor zlatni prsten", parts: ["Zlato","Srebro","Kristal","Obsidijan","Platno","Koža"] },
  { name: "Nor drvena škrinja", parts: ["Drvo","Kamen","Koža","Željezo","Platno","Bronza","Srebro"] },
  { name: "Nor kameni stub", parts: ["Kamen","Drvo","Željezo","Platno"] },
  { name: "Nor kožna torba", parts: ["Koža","Platno","Drvo","Srebro","Kristal"] },
  { name: "Nor platneni šator", parts: ["Platno","Koža","Drvo","Kamen","Željezo","Obsidijan"] },
  { name: "Nor kristalna kugla", parts: ["Kristal","Obsidijan","Zlato","Platno","Drvo","Koža","Bronza"] },
  { name: "Nor obsidijanski nož", parts: ["Obsidijan","Kristal","Željezo","Bronza"] },
  { name: "Nor željezni oklop", parts: ["Željezo","Bronza","Koža","Platno","Kamen"] },
];

const T3 = [
  { name: "Nor vrata moći", parts: ["Nor bronzena vrata","Nor srebrni pehar","Nor zlatni prsten","Nor drvena škrinja"] },
  { name: "Nor pehar mudrosti", parts: ["Nor srebrni pehar","Nor zlatni prsten","Nor kameni stub","Nor kožna torba","Nor platneni šator"] },
  { name: "Nor prsten sjaja", parts: ["Nor zlatni prsten","Nor drvena škrinja","Nor kameni stub","Nor kožna torba","Nor kristalna kugla","Nor obsidijanski nož"] },
  { name: "Nor škrinja tajni", parts: ["Nor drvena škrinja","Nor kameni stub","Nor kožna torba","Nor platneni šator","Nor kristalna kugla","Nor obsidijanski nož","Nor željezni oklop"] },
  { name: "Nor stub snage", parts: ["Nor kameni stub","Nor kožna torba","Nor platneni šator","Nor kristalna kugla"] },
  { name: "Nor torba putnika", parts: ["Nor kožna torba","Nor platneni šator","Nor kristalna kugla","Nor obsidijanski nož","Nor bronzena vrata"] },
  { name: "Nor šator nomada", parts: ["Nor platneni šator","Nor kristalna kugla","Nor obsidijanski nož","Nor bronzena vrata","Nor željezni oklop","Nor srebrni pehar"] },
  { name: "Nor kugla vizije", parts: ["Nor kristalna kugla","Nor obsidijanski nož","Nor bronzena vrata","Nor srebrni pehar","Nor drvena škrinja","Nor torba putnika","Nor zlatni prsten"] },
  { name: "Nor nož tame", parts: ["Nor obsidijanski nož","Nor bronzena vrata","Nor željezni oklop","Nor drvena škrinja"] },
  { name: "Nor oklop zaštite", parts: ["Nor željezni oklop","Nor srebrni pehar","Nor zlatni prsten","Nor kožna torba","Nor platneni šator"] },
];

const T4 = [
  { name: "Nor vrata kraljeva", parts: ["Nor vrata moći","Nor pehar mudrosti","Nor prsten sjaja","Nor škrinja tajni"] },
  { name: "Nor pehar života", parts: ["Nor pehar mudrosti","Nor prsten sjaja","Nor škrinja tajni","Nor stub snage","Nor torba putnika"] },
  { name: "Nor prsten vječnosti", parts: ["Nor prsten sjaja","Nor škrinja tajni","Nor stub snage","Nor torba putnika","Nor šator nomada","Nor kugla vizije"] },
  { name: "Nor škrinja bogova", parts: ["Nor škrinja tajni","Nor stub snage","Nor torba putnika","Nor šator nomada","Nor kugla vizije","Nor nož tame","Nor oklop zaštite"] },
  { name: "Nor stub sudbine", parts: ["Nor stub snage","Nor torba putnika","Nor šator nomada","Nor kugla vizije"] },
  { name: "Nor torba lutalica", parts: ["Nor torba putnika","Nor šator nomada","Nor kugla vizije","Nor nož tame","Nor vrata moći"] },
  { name: "Nor šator sudbine", parts: ["Nor šator nomada","Nor kugla vizije","Nor nož tame","Nor vrata moći","Nor oklop zaštite","Nor pehar mudrosti"] },
  { name: "Nor kugla proroštva", parts: ["Nor kugla vizije","Nor nož tame","Nor vrata moći","Nor pehar mudrosti","Nor škrinja tajni","Nor torba lutalica","Nor stub snage"] },
  { name: "Nor nož krvi", parts: ["Nor nož tame","Nor vrata moći","Nor oklop zaštite","Nor škrinja tajni"] },
  { name: "Nor oklop heroja", parts: ["Nor oklop zaštite","Nor pehar mudrosti","Nor prsten sjaja","Nor škrinja tajni","Nor stub snage"] },
];

const T5 = [
  { name: "Nor vrata svjetla", parts: ["Nor vrata kraljeva","Nor pehar života","Nor prsten vječnosti","Nor škrinja bogova"] },
  { name: "Nor pehar krvi", parts: ["Nor pehar života","Nor prsten vječnosti","Nor škrinja bogova","Nor stub sudbine","Nor torba lutalica"] },
  { name: "Nor prsten sudbine", parts: ["Nor prsten vječnosti","Nor škrinja bogova","Nor stub sudbine","Nor torba lutalica","Nor šator sudbine","Nor kugla proroštva"] },
  { name: "Nor škrinja beskraja", parts: ["Nor škrinja bogova","Nor stub sudbine","Nor torba lutalica","Nor šator sudbine","Nor kugla proroštva","Nor nož krvi","Nor oklop heroja"] },
  { name: "Nor stub vremena", parts: ["Nor stub sudbine","Nor torba lutalica","Nor šator sudbine","Nor kugla proroštva"] },
  { name: "Nor torba putova", parts: ["Nor torba lutalica","Nor šator sudbine","Nor kugla proroštva","Nor nož krvi","Nor vrata kraljeva"] },
  { name: "Nor šator duhova", parts: ["Nor šator sudbine","Nor kugla proroštva","Nor nož krvi","Nor vrata kraljeva","Nor oklop heroja","Nor pehar života"] },
  { name: "Nor kugla moći", parts: ["Nor kugla proroštva","Nor nož krvi","Nor vrata kraljeva","Nor pehar života","Nor škrinja bogova","Nor stub vremena","Nor torba putova"] },
  { name: "Nor nož vjetra", parts: ["Nor nož krvi","Nor vrata kraljeva","Nor oklop heroja","Nor škrinja bogova"] },
  { name: "Nor oklop tame", parts: ["Nor oklop heroja","Nor pehar života","Nor prsten vječnosti","Nor škrinja bogova","Nor stub sudbine"] },
];

const T6 = { name: "Artefakt", requireDistinctT5: 10 };

// Helpers (seed & inventory & users)
function upsertMaterial(name){ db.prepare("INSERT OR IGNORE INTO materials(name) VALUES (?)").run(name); }
function ensureItem(name,tier){
  const got = db.prepare("SELECT id FROM items WHERE name=?").get(name);
  if (got) return got.id;
  return db.prepare("INSERT INTO items(name,tier) VALUES (?,?)").run(name,tier).lastInsertRowid;
}
function setRecipe(itemName,tier,parts){
  if (!Array.isArray(parts) || parts.length<4 || parts.length>7) throw new Error(`Recept ${itemName} mora imati 4–7 dijelova`);
  const set = new Set(parts); if (set.size!==parts.length) throw new Error(`Recept ${itemName} ima duplikate`);
  const id = ensureItem(itemName,tier);
  db.prepare("DELETE FROM recipe_parts WHERE item_id=?").run(id);
  const ins = db.prepare("INSERT INTO recipe_parts(item_id,part_name) VALUES (?,?)");
  for(const p of parts) ins.run(id,p);
}
function seed(){
  if (db.prepare("SELECT COUNT(*) c FROM materials").get().c===0) MATERIALS.forEach(upsertMaterial);
  for (const r of T2) setRecipe(r.name,2,r.parts);
  for (const r of T3) setRecipe(r.name,3,r.parts);
  for (const r of T4) setRecipe(r.name,4,r.parts);
  for (const r of T5) setRecipe(r.name,5,r.parts);
  ensureItem(T6.name,6);
  // seed prodavnice (par stavki)
  if (db.prepare("SELECT COUNT(*) c FROM store_items").get().c===0){
    const add = db.prepare("INSERT INTO store_items(name,tier,price,stock) VALUES (?,?,?,?)");
    add.run("Nor bronzena vrata",2,120,50);
    add.run("Nor srebrni pehar",2,180,40);
    add.run("Nor zlatni prsten",2,260,30);
    add.run("Nor vrata moći",3,900,25);
    add.run("Nor škrinja tajni",3,1400,15);
  }
}
seed();

function normalizeEmail(e){ return String(e||"").trim().toLowerCase(); }
function ensureUser(email){
  const em = normalizeEmail(email);
  if (!em) throw new Error("Nepoznat korisnik");
  let u = db.prepare("SELECT id FROM users WHERE email=?").get(em);
  if (!u){
    const id = db.prepare("INSERT INTO users(email,created_at,is_admin,is_disabled,balance_silver,shop_buy_count) VALUES (?,?,?,?,?,?)")
      .run(em, Date.now(), 0, 0, 0, 0).lastInsertRowid;
    return { id, email: em };
  }
  return { id: u.id, email: em };
}
function touchUser(email){ db.prepare("UPDATE users SET last_seen=? WHERE email=?").run(Date.now(), normalizeEmail(email)); }

function invAdd(user, name, tier, delta){
  const row = db.prepare("SELECT qty FROM inventory WHERE user_id=? AND ref_name=? AND tier=?").get(user,name,tier);
  if (!row) db.prepare("INSERT INTO inventory(user_id,ref_name,tier,qty) VALUES (?,?,?,?)").run(user,name,tier,Math.max(0,delta));
  else{
    const q = row.qty + delta; if (q<0) throw new Error("Negativan inventar");
    db.prepare("UPDATE inventory SET qty=? WHERE user_id=? AND ref_name=? AND tier=?").run(q,user,name,tier);
  }
}
function invGet(user){
  return db.prepare("SELECT ref_name AS name, tier, qty FROM inventory WHERE user_id=? ORDER BY tier,name").all(user);
}

// -----------------
// AUTH-lite (stub za admin panel)
// -----------------
app.get("/api/me", (_req,res)=>{ res.json({ ok:false }); });

// -----------------
// API — Recepti
// -----------------
app.get("/api/recipes", (_req,res)=>{
  const readTier=(t)=>db.prepare("SELECT id,name FROM items WHERE tier=? ORDER BY name").all(t).map(it=>({
    name:it.name,
    parts: db.prepare("SELECT part_name FROM recipe_parts WHERE item_id=? ORDER BY part_name").all(it.id).map(r=>r.part_name)
  }));
  const materials = db.prepare("SELECT name FROM materials ORDER BY name").all().map(r=>r.name);
  res.json({ materials, t2:readTier(2), t3:readTier(3), t4:readTier(4), t5:readTier(5), t6:{ name:T6.name, requireDistinctT5:T6.requireDistinctT5 } });
});

app.get("/api/recipes/:tier", (req,res)=>{
  const map={t2:2,t3:3,t4:4,t5:5,"2":2,"3":3,"4":4,"5":5, materials:"materials"};
  const key = String(req.params.tier).toLowerCase();
  if (map[key]==="materials"){ return res.json(db.prepare("SELECT name FROM materials ORDER BY name").all().map(r=>r.name)); }
  const t = map[key]; if(!t) return res.status(404).json({error:"Nepoznat tier"});
  const rows = db.prepare("SELECT id,name FROM items WHERE tier=? ORDER BY name").all(t).map(it=>({name:it.name, parts: db.prepare("SELECT part_name FROM recipe_parts WHERE item_id=? ORDER BY part_name").all(it.id).map(r=>r.part_name)}));
  res.json(rows);
});

// -----------------
// API — Prodavnica
// -----------------
app.get("/api/store", (_req,res)=>{
  res.json(db.prepare("SELECT id,name,tier,price,stock FROM store_items ORDER BY tier,name").all());
});

app.post("/api/store/buy", (req,res)=>{
  try{
    const { buyer, id, qty } = req.body; // id store stavke
    if (!buyer || !id || !qty) return res.status(400).json({error:"buyer, id, qty obavezni"});
    const row = db.prepare("SELECT id,name,tier,price,stock FROM store_items WHERE id=?").get(id);
    if (!row) return res.status(404).json({error:"stavka ne postoji"});
    if (row.stock < qty) return res.status(400).json({error:"nema dovoljno na stanju"});
    const now = Date.now();
    const tx = db.transaction(()=>{
      ensureUser(buyer); touchUser(buyer);
      db.prepare("UPDATE store_items SET stock=stock-? WHERE id=?").run(qty, id);
      db.prepare("INSERT INTO purchases(buyer,item_name,tier,qty,price_each,created_at) VALUES (?,?,?,?,?,?)").run(buyer,row.name,row.tier,qty,row.price,now);
      invAdd(buyer,row.name,row.tier,qty);
    });
    tx();
    res.json({ok:true, item: row, qty});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// -----------------
// API — Inventar (debug)
// -----------------
app.get("/api/inventory/:user", (req,res)=>{ ensureUser(req.params.user); touchUser(req.params.user); res.json(invGet(req.params.user)); });

// -----------------
// API — Aukcija (1% taksa pri postavljanju)
// -----------------
function highestBid(auctionId){
  const b = db.prepare("SELECT MAX(amount) AS max FROM auction_bids WHERE auction_id=?").get(auctionId);
  return b && b.max ? b.max : 0;
}

app.get("/api/auctions", (_req,res)=>{
  const list = db.prepare("SELECT * FROM auctions WHERE status='active' ORDER BY created_at DESC").all()
    .map(a=>({ ...a, highest_bid: highestBid(a.id) }));
  res.json(list);
});

app.post("/api/auctions/create", (req,res)=>{
  try{
    const { seller, item_name, tier, qty, start_price, buyout_price } = req.body;
    if(!seller||!item_name||!tier||!qty||start_price==null) return res.status(400).json({error:"obavezna polja: seller,item_name,tier,qty,start_price"});
    // provjeri inventar
    const inv = db.prepare("SELECT qty FROM inventory WHERE user_id=? AND ref_name=? AND tier=?").get(seller,item_name,tier);
    const have = inv? inv.qty : 0; if (have < qty) return res.status(400).json({error:"nema dovoljno u inventaru"});
    const fee = Math.max(1, Math.ceil(start_price * qty * 0.01)); // 1% taksa, min 1
    const now = Date.now();
    const tx = db.transaction(()=>{
      ensureUser(seller); touchUser(seller);
      invAdd(seller,item_name,tier,-qty); // predmet ide na aukciju
      db.prepare("INSERT INTO auctions(seller,item_name,tier,qty,start_price,buyout_price,fee_paid,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(seller,item_name,tier,qty,start_price,buyout_price||null,fee,'active',now);
    });
    tx();
    res.json({ok:true, fee});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/auctions/bid", (req,res)=>{
  try{
    const { auction_id, bidder, amount } = req.body;
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if (!a || a.status!=="active") return res.status(404).json({error:"aukcija nije aktivna"});
    const current = highestBid(a.id);
    const min = Math.max(a.start_price, current+1);
    if (!bidder || !amount || amount < min) return res.status(400).json({error:`ponuda mora biti ≥ ${min}`});
    ensureUser(bidder); touchUser(bidder);
    db.prepare("INSERT INTO auction_bids(auction_id,bidder,amount,created_at) VALUES (?,?,?,?)").run(a.id,bidder,amount,Date.now());
    res.json({ok:true, highest: amount});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/auctions/buyout", (req,res)=>{
  try{
    const { auction_id, buyer } = req.body;
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if (!a || a.status!=="active") return res.status(404).json({error:"aukcija nije aktivna"});
    if (!a.buyout_price) return res.status(400).json({error:"nema buyout cijenu"});
    const tx = db.transaction(()=>{
      ensureUser(buyer); touchUser(buyer);
      db.prepare("UPDATE auctions SET status='sold' WHERE id=?").run(a.id);
      invAdd(buyer,a.item_name,a.tier,a.qty);
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post("/api/auctions/cancel", (req,res)=>{
  try{
    const { auction_id, seller } = req.body;
    const a = db.prepare("SELECT * FROM auctions WHERE id=?").get(auction_id);
    if (!a || a.status!=="active") return res.status(404).json({error:"aukcija nije aktivna"});
    if (a.seller !== seller) return res.status(403).json({error:"nije vlasnik"});
    const tx = db.transaction(()=>{
      ensureUser(seller); touchUser(seller);
      db.prepare("UPDATE auctions SET status='canceled' WHERE id=?").run(a.id);
      invAdd(seller,a.item_name,a.tier,a.qty); // vraćamo predmet; taksa ostaje izgubljena
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// -----------------
// Admin API (x-admin-key)
// -----------------
function isAdminReq(req){
  const hdr = req.headers["x-admin-key"] || req.headers["X-Admin-Key"]; return String(hdr||"") === String(ADMIN_KEY);
}
function requireAdmin(req,res,next){ if(!isAdminReq(req)) return res.status(401).json({ok:false,error:"Unauthorized"}); next(); }

app.get("/api/admin/ping", requireAdmin, (_req,res)=>{ res.json({ok:true,message:"Admin OK"}); });

app.get("/api/admin/users", requireAdmin, (_req,res)=>{
  const rows = db.prepare(`
    SELECT id,email,is_admin,is_disabled,created_at,last_seen,balance_silver,shop_buy_count,next_recipe_at
    FROM users
    ORDER BY is_disabled ASC, lower(email) ASC
  `).all();
  const users = rows.map(u=>({
    id:u.id, email:u.email, is_admin:!!u.is_admin, is_disabled:!!u.is_disabled,
    created_at:u.created_at, last_seen:u.last_seen,
    balance_silver:u.balance_silver,
    gold: Math.floor((u.balance_silver||0)/100), silver: (u.balance_silver||0)%100,
    shop_buy_count: u.shop_buy_count||0, next_recipe_at: u.next_recipe_at||null
  }));
  res.json({ok:true, users});
});

app.post("/api/admin/adjust-balance", requireAdmin, (req,res)=>{
  const { email, gold=0, silver=0, delta_silver } = req.body||{};
  const em = normalizeEmail(email);
  if(!em) return res.status(400).json({ok:false,error:"Bad email"});
  ensureUser(em);
  let deltaS = (typeof delta_silver === 'number') ? Math.trunc(delta_silver) : (Math.trunc(gold)*100 + Math.trunc(silver));
  if(!Number.isFinite(deltaS) || deltaS===0) return res.status(400).json({ok:false,error:"No change"});
  const u = db.prepare("SELECT id,balance_silver FROM users WHERE email=?").get(em);
  const after = (u.balance_silver||0) + deltaS;
  if (after < 0) return res.status(400).json({ok:false,error:"Insufficient funds"});
  db.prepare("UPDATE users SET balance_silver=? WHERE id=?").run(after, u.id);
  const updated = db.prepare("SELECT balance_silver FROM users WHERE id=?").get(u.id).balance_silver;
  res.json({ok:true,balance_silver:updated,gold:Math.floor(updated/100),silver:updated%100});
});

app.post("/api/admin/disable-user", requireAdmin, (req,res)=>{
  const { email, disabled } = req.body||{};
  const em = normalizeEmail(email); if(!em) return res.status(400).json({ok:false,error:"Bad email"});
  ensureUser(em);
  const flag = disabled ? 1 : 0;
  const r = db.prepare("UPDATE users SET is_disabled=? WHERE lower(email)=lower(?)").run(flag, em);
  if (!r.changes) return res.status(404).json({ok:false,error:"User not found"});
  res.json({ok:true});
});

app.get("/api/admin/user/:id/inventory", requireAdmin, (req,res)=>{
  const id = parseInt(req.params.id,10);
  const u = db.prepare("SELECT email FROM users WHERE id=?").get(id);
  if (!u) return res.status(404).json({ok:false,error:"User not found"});
  const items = db.prepare("SELECT ref_name AS name, tier, qty FROM inventory WHERE user_id=? ORDER BY tier,name").all(u.email);
  const recipes = []; // ovaj build ne vodi evidenciju recepta po korisniku
  res.json({ ok:true, items, recipes });
});

// -----------------
// Statika + /admin
// -----------------
app.use(express.static(path.join(__dirname, "public")));
app.get('/admin', (_req,res)=> res.sendFile(path.join(__dirname,'public','admin.html')));

app.listen(PORT, HOST, ()=>{
  console.log(`ARTEFAKT server posluje na http://${HOST}:${PORT}`);
});


// ===============================
// FILE: public/app.css
// ===============================

:root{
  --bg:#0f172a; --card:#111827; --line:#1f2937; --text:#e2e8f0; --muted:#94a3b8; --accent:#2dd4bf; --accent2:#334155;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
.header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--card);border-bottom:1px solid var(--line)}
.brand{font-weight:800;letter-spacing:.3px}
.container{max-width:1100px;margin:16px auto;padding:0 12px}
.tabs{display:flex;gap:8px;flex-wrap:wrap}
.tab{padding:6px 10px;border:1px solid var(--line);border-radius:10px;background:#0b1220;color:var(--text);cursor:pointer}
.tab.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
.table{width:100%;border-collapse:collapse}
.table th,.table td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left}
.table th{color:var(--muted);font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap}
.input{background:#0b1220;border:1px solid #233047;border-radius:8px;color:var(--text);padding:6px 8px}
.btn{background:#0b1220;border:1px solid var(--accent2);border-radius:10px;color:var(--text);padding:6px 10px;cursor:pointer}
.btn:hover{border-color:var(--accent)}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1f2937;color:#93c5fd;font-size:12px;margin-left:6px}
.parts{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:2px 8px;background:#1f2937;border:1px solid #233047;border-radius:999px;font-size:12px}
.muted{color:var(--muted)}


// ===============================
// FILE: public/index.html
// ===============================

<!doctype html>
<html lang="bs">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ARTEFAKT • Prodavnica • Aukcija • Recepti</title>
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <div class="header">
    <div class="brand">ARTEFAKT</div>
    <div class="row">
      <input id="user" class="input" placeholder="Korisnik (npr. overhuman)" />
      <button class="btn" onclick="saveUser()">Spremi</button>
    </div>
  </div>
  <div class="container">
    <div class="tabs">
      <button class="tab active" data-tab="store" onclick="show('store')">Prodavnica</button>
      <button class="tab" data-tab="auctions" onclick="show('auctions')">Aukcija</button>
      <button class="tab" data-tab="recipes" onclick="show('recipes')">Recepti</button>
      <button class="tab" data-tab="inventory" onclick="show('inventory')">Inventar</button>
    </div>

    <section id="store" class="card"></section>
    <section id="auctions" class="card" style="display:none"></section>
    <section id="recipes" class="card" style="display:none"></section>
    <section id="inventory" class="card" style="display:none"></section>
  </div>

<script>
const $ = (q)=>document.querySelector(q);
function currentUser(){ return localStorage.getItem('user') || ''; }
function saveUser(){ const v=$('#user').value.trim(); localStorage.setItem('user', v); loadInventory(); alert('Korisnik: '+v); }
function show(id){ document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); document.querySelector(`.tab[data-tab="${id}"]`).classList.add('active');
  document.querySelectorAll('section.card').forEach(s=>s.style.display='none'); $('#'+id).style.display='block';
  if(id==='store') loadStore(); else if(id==='auctions') loadAuctions(); else if(id==='recipes') loadRecipes(); else if(id==='inventory') loadInventory(); }

// -------- Prodavnica --------
async function loadStore(){
  const res = await fetch('/api/store'); const data = await res.json();
  $('#store').innerHTML = `
    <h2>Prodavnica <span class="pill">${data.length} stavki</span></h2>
    <table class="table">
      <thead><tr><th>Naziv</th><th>Tier</th><th>Cijena</th><th>Stanje</th><th>Kupovina</th></tr></thead>
      <tbody>
        ${data.map(r=>`<tr>
          <td>${r.name}</td><td>T${r.tier}</td><td>${r.price}</td><td>${r.stock}</td>
          <td class="row"><input type="number" class="input" min="1" max="${r.stock}" value="1" id="buyqty_${r.id}" />
              <button class="btn" onclick="buy(${r.id})">Kupi</button></td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}
async function buy(id){
  const qty = parseInt($('#buyqty_'+id).value,10)||1; const buyer=currentUser(); if(!buyer) return alert('Unesi korisnika u vrhu!');
  const res = await fetch('/api/store/buy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({buyer,id,qty})});
  const out = await res.json(); if(!res.ok) return alert(out.error||'Greška');
  alert('Kupljeno x'+qty+' • '+out.item.name); loadStore(); loadInventory();
}

// -------- Aukcije --------
async function loadAuctions(){
  const res = await fetch('/api/auctions'); const list = await res.json();
  $('#auctions').innerHTML = `
    <h2>Aukcije <span class="pill">${list.length} aktivnih</span></h2>
    <div class="row" style="margin-bottom:10px">
      <input id="a_item" class="input" placeholder="Naziv (tačno)" />
      <input id="a_tier" class="input" type="number" min="2" max="5" placeholder="Tier (2-5)" />
      <input id="a_qty"  class="input" type="number" min="1" value="1" />
      <input id="a_price" class="input" type="number" min="1" placeholder="Start cijena" />
      <input id="a_buy" class="input" type="number" min="0" placeholder="Buyout (opc)" />
      <button class="btn" onclick="createAuction()">Postavi aukciju</button>
    </div>
    <table class="table">
      <thead><tr><th>Predmet</th><th>Tier</th><th>Količina</th><th>Start</th><th>Buyout</th><th>Najviša ponuda</th><th>Akcije</th></tr></thead>
      <tbody>
        ${list.map(a=>`<tr>
          <td>${a.item_name}</td><td>T${a.tier}</td><td>${a.qty}</td><td>${a.start_price}</td><td>${a.buyout_price??'—'}</td><td>${a.highest_bid}</td>
          <td class="row">
            <input id="bid_${a.id}" class="input" type="number" min="${Math.max(a.start_price,a.highest_bid+1)}" placeholder="Ponuda" />
            <button class="btn" onclick="bid(${a.id})">Ponudi</button>
            ${a.buyout_price?`<button class="btn" onclick="buyout(${a.id})">Buyout</button>`:''}
            <button class="btn" onclick="cancelAuction(${a.id})">Otkaži</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}
async function createAuction(){
  const seller=currentUser(); if(!seller) return alert('Unesi korisnika u vrhu!');
  const payload={ seller, item_name:$('#a_item').value.trim(), tier:parseInt($('#a_tier').value,10), qty:parseInt($('#a_qty').value,10), start_price:parseInt($('#a_price').value,10), buyout_price:$('#a_buy').value?parseInt($('#a_buy').value,10):null };
  const res=await fetch('/api/auctions/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const out=await res.json(); if(!res.ok) return alert(out.error||'Greška');
  alert('Aukcija postavljena. Taksa 1%: '+out.fee); loadAuctions(); loadInventory();
}
async function bid(id){
  const bidder=currentUser(); if(!bidder) return alert('Unesi korisnika u vrhu!');
  const amount=parseInt($('#bid_'+id).value,10); if(!amount) return alert('Upiši iznos');
  const res=await fetch('/api/auctions/bid',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auction_id:id,bidder,amount})});
  const out=await res.json(); if(!res.ok) return alert(out.error||'Greška');
  alert('Ponuda prihvaćena: '+out.highest); loadAuctions();
}
async function buyout(id){
  const buyer=currentUser(); if(!buyer) return alert('Unesi korisnika u vrhu!');
  const res=await fetch('/api/auctions/buyout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auction_id:id,buyer})});
  const out=await res.json(); if(!res.ok) return alert(out.error||'Greška');
  alert('Kupovina završena.'); loadAuctions(); loadInventory();
}
async function cancelAuction(id){
  const seller=currentUser(); if(!seller) return alert('Unesi korisnika u vrhu!');
  const res=await fetch('/api/auctions/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auction_id:id,seller})});
  const out=await res.json(); if(!res.ok) return alert(out.error||'Greška');
  alert('Aukcija otkazana (taksa ostaje izgubljena).'); loadAuctions(); loadInventory();
}

// -------- Recepti --------
async function loadRecipes(){
  const res = await fetch('/api/recipes'); const data = await res.json();
  const chips = (list)=>`<div class="parts">${list.map(x=>`<span class="chip">${x}</span>`).join('')}</div>`;
  const section=(title,rows)=>`<div class="card"><h3>${title} <span class="pill">${rows.length} kom</span></h3>
    <table class="table"><thead><tr><th>Naziv</th><th>#</th><th>Sastav</th></tr></thead>
    <tbody>${rows.map(r=>`<tr><td>${r.name||r}</td><td>${r.parts? r.parts.length : '—'}</td><td>${r.parts?chips(r.parts):''}</td></tr>`).join('')}</tbody>
    </table></div>`;
  $('#recipes').innerHTML = [
    section('Materijali', data.materials.map(m=>({name:m,parts:null}))),
    section('T2', data.t2), section('T3', data.t3), section('T4', data.t4), section('T5', data.t5),
    `<div class="card"><h3>T6 — Artefakt</h3><p>Potrebno: <b>10 različitih T5</b> (svaki ×1).</p></div>`
  ].join('');
}

// -------- Inventar --------
async function loadInventory(){
  const u=currentUser(); $('#user').value=u; if(!u){ $('#inventory').innerHTML='<p class="muted">Unesi korisnika.</p>'; return; }
  const res = await fetch('/api/inventory/'+encodeURIComponent(u)); const data = await res.json();
  $('#inventory').innerHTML = `
    <h2>Inventar: ${u}</h2>
    <table class="table"><thead><tr><th>Naziv</th><th>Tier</th><th>Količina</th></tr></thead>
    <tbody>${data.map(r=>`<tr><td>${r.name}</td><td>T${r.tier}</td><td>${r.qty}</td></tr>`).join('')}</tbody></table>`;
}

// init
loadStore();
</script>
</body>
</html>


// ===============================
// FILE: public/admin.html
// ===============================

<!doctype html> 
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ARTEFACT • Admin</title>
  <link rel="stylesheet" href="/app.css" />
  <style>
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    @media (max-width: 900px){.grid2{grid-template-columns:1fr}}
    .list{background:#0b1220;border:1px solid #233047;border-radius:10px;padding:12px;white-space:pre-wrap}
    .rowx{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1f2937;font-size:12px;color:#93c5fd}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .muted{opacity:.8}
    .success{color:#22c55e}.danger{color:#ef4444}
    .pointer{cursor:pointer}
    .right{float:right}
    .lock{margin-left:8px}
    .search{width:100%;padding:8px;border-radius:8px;border:1px solid #233047;background:#0b1220;color:#e2e8f0}
    .user-row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:8px}
    .user-row:hover{background:#0f172a}
    .tag{font-size:11px;padding:2px 6px;border-radius:6px;background:#1f2937}
    .tag.red{background:#3b1113;color:#fecaca}
    .tag.green{background:#0f2e1b;color:#bbf7d0}
    .tight{margin:0;padding:0}
  </style>
</head>
<body>
  <header class="header">
    <div class="brand">ARTEFACT • Admin</div>
    <div id="who" class="muted">Status: unknown</div>
  </header>

  <main class="container">
    <!-- Admin Key -->
    <section class="card">
      <div class="label">Admin Key</div>
      <div class="rowx">
        <input id="admin-key" type="password" placeholder="x-admin-key" />
        <button id="btn-key-set">Set</button>
        <button id="btn-key-clear" class="secondary">Clear</button>
        <label class="rowx lock">
          <input type="checkbox" id="key-lock" />
          <span>Lock key</span>
        </label>
        <label class="rowx lock">
          <input type="checkbox" id="key-remember" />
          <span>Remember in this browser</span>
        </label>
        <span id="key-msg" class="muted"></span>
      </div>
    </section>

    <section class="grid2">
      <!-- LEFT: Controls -->
      <div class="card">
        <div class="label">Controls</div>
        <div class="muted tight" id="sel-user-label">Selected user: —</div>
        <div class="rowx" style="margin-top:8px">
          <input id="gold-amount" type="number" min="-999999" step="1" placeholder="Gold amount (1g = 100s)" />
          <button id="btn-give">+ Give</button>
          <button id="btn-take" class="secondary">– Take</button>
        </div>
        <div class="rowx" style="margin-top:8px">
          <button id="btn-disable" class="danger">Disable account</button>
          <button id="btn-enable" class="secondary">Enable account</button>
        </div>
        <div id="ops-msg" class="muted" style="margin-top:6px"></div>
      </div>

      <!-- RIGHT: Users + Inventory -->
      <div class="card">
        <div class="rowx" style="justify-content:space-between;">
          <div class="label">Users (active first, A–Z)</div>
          <button id="btn-refresh-users" class="secondary">Refresh</button>
        </div>

        <input id="search" class="search" placeholder="Search email…" />
        <div id="users" class="list" style="margin-top:8px;max-height:320px;overflow:auto;">—</div>

        <div class="card" style="margin-top:12px;">
          <div class="rowx" style="justify-content:space-between;">
            <div class="label">Inventory of selected user</div>
            <button id="btn-refresh-inv" class="secondary">Reload</button>
          </div>
          <div id="inv" class="list">Select a user from the list →</div>
        </div>
      </div>
    </section>
  </main>

  <script>
    const $ = s => document.querySelector(s);
    let ADMIN_KEY = "";
    let LOCKED = false;
    let REMEMBER = false;
    let users = [];
    let selected = null;

    function msg(el, text, ok=true){ const e=$(el); e.textContent=text; e.className = ok ? "muted success" : "muted danger"; }
    function setWho(text){ $("#who").textContent = text; }

    // ---------- Persist key / lock
    function loadPrefs(){
      ADMIN_KEY = localStorage.getItem("admin.key") || "";
      LOCKED = localStorage.getItem("admin.lock") === "1";
      REMEMBER = localStorage.getItem("admin.remember") === "1";
      $("#admin-key").value = ADMIN_KEY;
      $("#key-lock").checked = LOCKED;
      $("#key-remember").checked = REMEMBER;
      applyLock();
    }
    function savePrefs(){
      if (REMEMBER) localStorage.setItem("admin.key", ADMIN_KEY);
      else localStorage.removeItem("admin.key");
      localStorage.setItem("admin.lock", LOCKED ? "1" : "0");
      localStorage.setItem("admin.remember", REMEMBER ? "1" : "0");
    }
    function applyLock(){
      $("#admin-key").disabled = LOCKED;
      $("#btn-key-set").disabled = LOCKED;
      $("#btn-key-clear").disabled = LOCKED;
    }

    // ---------- Fetch helper with header
    async function api(path, opts={}){
      const headers = { "Content-Type":"application/json", ...(opts.headers||{}) };
      if (ADMIN_KEY) headers["x-admin-key"] = ADMIN_KEY;
      const res = await fetch(path, { credentials:"include", ...opts, headers });
      let data = null;
      try{ data = await res.json(); }catch{}
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data;
    }

    async function checkAdmin(){
      try{
        await api("/api/admin/ping");
        msg("#key-msg", "Admin OK");
      }catch(e){
        msg("#key-msg", "Key invalid or missing ("+e.message+")", false);
      }
    }

    // ---------- Users
    function renderUsers(){
      const q = $("#search").value.trim().toLowerCase();
      const box = $("#users"); box.innerHTML = "";
      let list = users.slice();
      // sort: active first, then email A–Z
      list.sort((a,b)=>{
        if (a.is_disabled !== b.is_disabled) return a.is_disabled ? 1 : -1;
        return a.email.localeCompare(b.email);
      });
      if (q) list = list.filter(u => u.email.toLowerCase().includes(q));
      if (!list.length){ box.textContent = "No users."; return; }
      for (const u of list){
        const row = document.createElement("div"); row.className = "user-row pointer";
        row.innerHTML = `
          <div>
            <span class="mono">#${u.id}</span>
            <span class="mono">${u.email}</span>
            ${u.is_disabled ? `<span class="tag red">disabled</span>` : `<span class="tag green">active</span>`}
          </div>
          <div class="muted">${u.gold}g ${u.silver}s</div>
        `;
        row.addEventListener("click", ()=> selectUser(u));
        box.appendChild(row);
      }
    }
    async function loadUsers(){
      $("#users").textContent = "Loading…";
      try{
        const r = await api("/api/admin/users");
        users = r.users || [];
        renderUsers();
      }catch(e){
        $("#users").textContent = e.message;
      }
    }

    function selectUser(u){
      selected = u;
      $("#sel-user-label").textContent = `Selected user: ${u.email} (id ${u.id})`;
      $("#ops-msg").textContent = "";
      loadInventory();
    }

    async function loadInventory(){
      const box = $("#inv");
      if (!selected){ box.textContent = "Select a user from the list →"; return; }
      box.textContent = "Loading…";
      try{
        const r = await api(`/api/admin/user/${selected.id}/inventory`);
        const lines = [];
        lines.push("ITEMS:");
        if (!(r.items||[]).length) lines.push("(none)");
        (r.items||[]).forEach(it=> lines.push(` • [T${it.tier}] ${it.name} x${it.qty}`));
        lines.push("");
        lines.push("RECIPES:");
        if (!(r.recipes||[]).length) lines.push("(none)");
        (r.recipes||[]).forEach(rc=> lines.push(` • [T${rc.tier}] ${rc.name} x${rc.qty}`));
        box.textContent = lines.join("
");
      }catch(e){ box.textContent = e.message; }
    }

    // ---------- Controls
    async function changeGold(sign){
      if (!selected){ msg("#ops-msg", "Select a user first.", false); return; }
      const amount = parseInt($("#gold-amount").value || "0", 10) || 0;
      if (amount === 0){ msg("#ops-msg", "Enter non-zero gold amount.", false); return; }
      const gold = sign>0 ? amount : -amount;
      try{
        const r = await api("/api/admin/adjust-balance", {
          method:"POST", body: JSON.stringify({ email: selected.email, gold })
        });
        msg("#ops-msg", `New balance: ${Math.floor(r.balance_silver/100)}g ${r.balance_silver%100}s`);
        await loadUsers();
        // update selection reference
        const found = users.find(x=>x.id===selected.id);
        if (found) selected = found;
        await loadInventory();
      }catch(e){ msg("#ops-msg", e.message, false); }
    }
    async function setDisabled(flag){
      if (!selected){ msg("#ops-msg","Select a user first.", false); return; }
      try{
        await api("/api/admin/disable-user", { method:"POST", body: JSON.stringify({ email: selected.email, disabled: flag }) });
        msg("#ops-msg", flag ? "Account disabled." : "Account enabled.");
        await loadUsers();
        const found = users.find(x=>x.id===selected.id);
        if (found) selected = found;
        $("#sel-user-label").textContent = `Selected user: ${selected.email} (id ${selected.id})`;
      }catch(e){ msg("#ops-msg", e.message, false); }
    }

    // ---------- Events
    $("#btn-key-set").addEventListener("click", async ()=>{
      ADMIN_KEY = $("#admin-key").value.trim();
      REMEMBER = $("#key-remember").checked;
      LOCKED = $("#key-lock").checked;
      savePrefs(); applyLock();
      await checkAdmin();
      await loadUsers();
    });
    $("#btn-key-clear").addEventListener("click", ()=>{
      ADMIN_KEY = ""; savePrefs(); applyLock(); msg("#key-msg","Cleared.");
    });
    $("#key-lock").addEventListener("change", ()=>{
      LOCKED = $("#key-lock").checked;
      savePrefs(); applyLock();
    });
    $("#key-remember").addEventListener("change", ()=>{
      REMEMBER = $("#key-remember").checked;
      savePrefs();
    });

    $("#btn-refresh-users").addEventListener("click", loadUsers);
    $("#btn-refresh-inv").addEventListener("click", loadInventory);
    $("#search").addEventListener("input", renderUsers);

    $("#btn-give").addEventListener("click", ()=> changeGold(+1));
    $("#btn-take").addEventListener("click", ()=> changeGold(-1));
    $("#btn-disable").addEventListener("click", ()=> setDisabled(true));
    $("#btn-enable").addEventListener("click", ()=> setDisabled(false));

    // ---------- Init
    loadPrefs();
    (async ()=>{
      try{
        const me = await fetch("/api/me", {credentials:"include"}).then(r=>r.ok?r.json():null).catch(()=>null);
        if (me && me.user) setWho(`${me.user.email} • ${me.user.is_admin ? "ADMIN" : "USER"} • ${me.user.gold}g ${me.user.silver}s`);
        else setWho("Not logged in (key mode).");
      }catch{ setWho("Not logged in (key mode)."); }
      if (ADMIN_KEY){ await checkAdmin(); await loadUsers(); }
    })();
  </script>
</body>
</html>
