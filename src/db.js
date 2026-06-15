const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'assets.db');
const SAVE_INTERVAL = 5000;

let db;
let initPromise;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  asset_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  department TEXT,
  responsible_person TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  purchase_date TEXT,
  purchase_price REAL,
  current_value REAL,
  mileage REAL DEFAULT 0,
  next_maintenance_date TEXT,
  next_maintenance_mileage REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  voucher_type TEXT NOT NULL,
  file_name TEXT,
  file_path TEXT,
  description TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  applicant TEXT NOT NULL,
  department TEXT NOT NULL,
  purpose TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  approved_at TEXT,
  returned_at TEXT,
  return_remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  maintenance_type TEXT NOT NULL,
  mileage_at_maintenance REAL,
  cost REAL,
  content TEXT,
  next_date TEXT,
  next_mileage REAL,
  performed_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);

CREATE TABLE IF NOT EXISTS disposal_requests (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  disposal_type TEXT NOT NULL,
  reason TEXT,
  applicant TEXT NOT NULL,
  department TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);

CREATE TABLE IF NOT EXISTS asset_logs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operator TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);
`;

async function initDatabase() {
  if (db) return db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  setInterval(saveDb, SAVE_INTERVAL);

  return db;
}

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('数据库保存失败:', e.message);
  }
}

function run(sql, params) {
  db.run(sql, params);
}

function get(sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length > 0) stmt.bind(params);
  let result = null;
  if (stmt.step()) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

function all(sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function addLog(assetId, action, operator, detail) {
  const { v4: uuidv4 } = require('uuid');
  run(
    `INSERT INTO asset_logs (id, asset_id, action, operator, detail) VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), assetId, action, operator, detail || null]
  );
}

module.exports = { initDatabase, run, get, all, addLog, saveDb };
