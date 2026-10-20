const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const DEPOSIT_ADDRESS = "0xeaf649489fc27078f4f86734f4ff770469416b3a";
const POWER_PER_USDT = 100;
const POWER_LIFETIME_DAYS = 15;
const WITHDRAW_MIN = 1.5;

if (!DATABASE_URL) console.warn("WARNING: DATABASE_URL is not set. Configure PostgreSQL before deploying.");
if (!ADMIN_KEY) console.warn("WARNING: ADMIN_KEY is not set. Admin endpoints will be unavailable.");
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
}) : null;

async function query(sql, params=[]) {
  if (!pool) throw new Error("Database not configured. Set DATABASE_URL in the hosting environment.");
  return pool.query(sql, params);
}
async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS power_lots (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      amount NUMERIC(20,8) NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deposits (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      amount NUMERIC(20,8) NOT NULL, network TEXT NOT NULL DEFAULT 'BEP20',
      txid TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ,
      UNIQUE(txid)
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      amount NUMERIC(20,8) NOT NULL, address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ,
      admin_note TEXT
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL, amount NUMERIC(20,8) NOT NULL,
      note TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
function adminOnly(req,res,next) {
  const key = req.get("x-admin-key") || req.body?.adminKey || req.query?.adminKey;
  if (!ADMIN_KEY || !key || !crypto.timingSafeEqual(Buffer.from(String(key)), Buffer.from(String(ADMIN_KEY)))) {
    return res.status(401).json({ error: "Admin authentication failed." });
  }
  next();
}
function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
async function userFromRequest(req,res,next) {
  const email = String(req.get("x-user-email") || req.body?.email || req.query?.email || "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
  try {
    const result = await query("SELECT id,email FROM users WHERE email=$1", [email]);
    if (!result.rowCount) return res.status(404).json({ error: "User not found. Save your email from the app first." });
    req.user = result.rows[0]; next();
  } catch(e) { next(e); }
}
app.get("/api/config", (_req,res) => res.json({
  depositAddress: DEPOSIT_ADDRESS, depositNetwork: "USDT on BNB Smart Chain (BEP20) only",
  minDeposit: 1, maxDeposit: 50, minWithdrawal: WITHDRAW_MIN,
  powerPerUsdt: POWER_PER_USDT, powerLifetimeDays: POWER_LIFETIME_DAYS,
  miningRatePerSecond: 0.000001929,
  note: "Displayed mining estimate is illustrative, not a guaranteed return. Withdrawals are manually reviewed and paid."
}));
app.post("/api/register", async (req,res,next) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({error:"Enter a valid email address."});
  try {
    const id = crypto.createHash("sha256").update(email).digest("hex");
    await query("INSERT INTO users(id,email) VALUES($1,$2) ON CONFLICT(email) DO NOTHING", [id,email]);
    const r = await query("SELECT id,email,created_at FROM users WHERE email=$1", [email]);
    res.json({user:r.rows[0]});
  } catch(e){next(e);}
});
app.get("/api/me", userFromRequest, async (req,res,next) => {
  try {
    const power = await query("SELECT COALESCE(SUM(amount),0) AS total FROM power_lots WHERE user_id=$1 AND expires_at>NOW()",[req.user.id]);
    const deposits = await query("SELECT id,amount,network,txid,status,created_at,reviewed_at FROM deposits WHERE user_id=$1 ORDER BY id DESC LIMIT 100",[req.user.id]);
    const withdrawals = await query("SELECT id,amount,address,status,created_at,reviewed_at,admin_note FROM withdrawals WHERE user_id=$1 ORDER BY id DESC LIMIT 100",[req.user.id]);
    const ledger = await query("SELECT id,kind,amount,note,created_at FROM ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 100",[req.user.id]);
    res.json({user:req.user, activePower:Number(power.rows[0].total), deposits:deposits.rows, withdrawals:withdrawals.rows, history:ledger.rows});
  } catch(e){next(e);}
});
app.post("/api/deposits", userFromRequest, async (req,res,next) => {
  const amount = Number(req.body.amount);
  const txid = String(req.body.txid || "").trim();
  if (!Number.isFinite(amount) || amount < 1 || amount > 50) return res.status(400).json({error:"Deposit amount must be $1–$50 USDT."});
  if (txid.length < 20 || txid.length > 200 || !/^[a-zA-Z0-9]+$/.test(txid)) return res.status(400).json({error:"Enter a valid transaction hash (TXID)."});
  try {
    const r = await query("INSERT INTO deposits(user_id,amount,network,txid) VALUES($1,$2,'BEP20',$3) RETURNING *",[req.user.id,amount,txid]);
    res.json({deposit:r.rows[0],message:"Deposit submitted to admin. Power can be added after manual verification."});
  } catch(e) {
    if (e.code === "23505") return res.status(409).json({error:"This transaction hash has already been submitted."});
    next(e);
  }
});
app.post("/api/withdrawals", userFromRequest, async (req,res,next) => {
  const amount = Number(req.body.amount);
  const address = String(req.body.address || "").trim();
  if (!Number.isFinite(amount) || amount < WITHDRAW_MIN || amount > 100000000) return res.status(400).json({error:"Minimum withdrawal is 1.5 USDT."});
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({error:"Enter a valid BNB Smart Chain (BEP20) wallet address."});
  try {
    const r = await query("INSERT INTO withdrawals(user_id,amount,address) VALUES($1,$2,$3) RETURNING *",[req.user.id,amount,address]);
    res.json({withdrawal:r.rows[0],message:"Withdrawal request submitted for manual review. This app does not automatically transfer funds."});
  } catch(e){next(e);}
});
app.get("/api/admin/summary", adminOnly, async (_req,res,next) => {
  try {
    const [users,deposits,withdrawals,power] = await Promise.all([
      query("SELECT COUNT(*)::int AS count FROM users"),
      query("SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending, COALESCE(SUM(amount) FILTER (WHERE status='approved'),0) AS approved_total FROM deposits"),
      query("SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending, COALESCE(SUM(amount) FILTER (WHERE status='approved'),0) AS approved_total FROM withdrawals"),
      query("SELECT COALESCE(SUM(amount),0) AS active_power FROM power_lots WHERE expires_at>NOW()")
    ]);
    res.json({users:users.rows[0],deposits:deposits.rows[0],withdrawals:withdrawals.rows[0],power:power.rows[0]});
  } catch(e){next(e);}
});
app.get("/api/admin/users", adminOnly, async (_req,res,next) => {
  try {
    const r = await query(`SELECT u.id,u.email,u.created_at,
      COALESCE((SELECT SUM(amount) FROM power_lots p WHERE p.user_id=u.id AND p.expires_at>NOW()),0) AS active_power
      FROM users u ORDER BY u.created_at DESC LIMIT 1000`);
    res.json({users:r.rows});
  } catch(e){next(e);}
});
app.get("/api/admin/deposits", adminOnly, async (_req,res,next) => {
  try { const r=await query("SELECT d.*,u.email FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 1000"); res.json({deposits:r.rows}); }
  catch(e){next(e);}
});
app.post("/api/admin/deposits/:id/review", adminOnly, async (req,res,next) => {
  const status=String(req.body.status||"");
  if (!["approved","rejected"].includes(status)) return res.status(400).json({error:"Status must be approved or rejected."});
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r=await client.query("SELECT * FROM deposits WHERE id=$1 FOR UPDATE",[req.params.id]);
    if (!r.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({error:"Deposit not found."}); }
    const d=r.rows[0];
    if (d.status !== "pending") { await client.query("ROLLBACK"); return res.status(409).json({error:"Deposit already reviewed."}); }
    await client.query("UPDATE deposits SET status=$1,reviewed_at=NOW() WHERE id=$2",[status,d.id]);
    if (status==="approved") {
      const power=Number(d.amount)*POWER_PER_USDT;
      await client.query("INSERT INTO power_lots(user_id,amount,source,expires_at) VALUES($1,$2,'deposit',NOW()+INTERVAL '15 days')",[d.user_id,power]);
      await client.query("INSERT INTO ledger(user_id,kind,amount,note) VALUES($1,'power_added',$2,$3)",[d.user_id,power,`Deposit #${d.id} approved`]);
    }
    await client.query("COMMIT"); res.json({message:`Deposit ${status}.`});
  } catch(e){await client.query("ROLLBACK"); next(e);} finally{client.release();}
});
app.post("/api/admin/power", adminOnly, async (req,res,next) => {
  const email=String(req.body.email||"").trim().toLowerCase(), amount=Number(req.body.amount);
  if (!validEmail(email) || !Number.isFinite(amount) || amount<=0 || amount>1000000000) return res.status(400).json({error:"Provide valid user email and positive power amount."});
  try {
    const u=await query("SELECT id FROM users WHERE email=$1",[email]);
    if (!u.rowCount) return res.status(404).json({error:"User email not found."});
    await query("INSERT INTO power_lots(user_id,amount,source,expires_at) VALUES($1,$2,'admin',NOW()+INTERVAL '15 days')",[u.rows[0].id,amount]);
    await query("INSERT INTO ledger(user_id,kind,amount,note) VALUES($1,'power_added',$2,'Power manually added by admin')",[u.rows[0].id,amount]);
    res.json({message:`Added ${amount} Power to ${email}. Expires in 15 days.`});
  } catch(e){next(e);}
});
app.get("/api/admin/withdrawals", adminOnly, async (_req,res,next) => {
  try {const r=await query("SELECT w.*,u.email FROM withdrawals w JOIN users u ON u.id=w.user_id ORDER BY w.id DESC LIMIT 1000");res.json({withdrawals:r.rows});}
  catch(e){next(e);}
});
app.post("/api/admin/withdrawals/:id/review", adminOnly, async (req,res,next) => {
  const status=String(req.body.status||""); const note=String(req.body.note||"").slice(0,500);
  if (!["approved","rejected"].includes(status)) return res.status(400).json({error:"Status must be approved or rejected."});
  try {
    const r=await query("UPDATE withdrawals SET status=$1,admin_note=$2,reviewed_at=NOW() WHERE id=$3 AND status='pending' RETURNING *",[status,note,req.params.id]);
    if (!r.rowCount) return res.status(404).json({error:"Pending withdrawal not found or already reviewed."});
    await query("INSERT INTO ledger(user_id,kind,amount,note) VALUES($1,$2,$3,$4)",[r.rows[0].user_id,`withdrawal_${status}`,r.rows[0].amount,`Withdrawal #${r.rows[0].id}: ${note || status}`]);
    res.json({message:`Withdrawal marked ${status}. Remember: approval here does not send blockchain funds.`});
  } catch(e){next(e);}
});
app.get("/api/health", (_req,res)=>res.json({status:"Active",app:"USDT Fan Mining App"}));
app.get("*", (req,res,next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname,"index.html"));
});
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:err.message||"Server error"});});
if (pool) initDb().then(()=>app.listen(PORT,()=>console.log(`USDT Fan Mining App listening on ${PORT}`))).catch(e=>{console.error("Database initialization failed",e);process.exit(1);});
else app.listen(PORT,()=>console.log(`USDT Fan Mining App listening on ${PORT}; API requires DATABASE_URL`));
