// ===============================
// FILE: server.js
// Express + better-sqlite3 • Recepti (T2–T6), Prodavnica, Aukcija (sa taksom 1%)
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

// Helpers (seed & inventory)
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
app.get("/api/inventory/:user", (req,res)=>{ res.json(invGet(req.params.user)); });

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
      db.prepare("UPDATE auctions SET status='canceled' WHERE id=?").run(a.id);
      invAdd(seller,a.item_name,a.tier,a.qty); // vraćamo predmet; taksa ostaje izgubljena
    });
    tx();
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// -----------------
// Statika
// -----------------
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, HOST, ()=>{
  console.log(`ARTEFAKT server posluje na http://${HOST}:${PORT}`);
});
