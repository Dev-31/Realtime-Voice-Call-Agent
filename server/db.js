import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function hashValue(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function openDatabase(filename = join(projectRoot, "data", "actionguard-v5.db")) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      monthly_price REAL NOT NULL,
      description TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      account_number TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      current_plan_id TEXT NOT NULL REFERENCES plans(id),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bills (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      period TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL,
      due_date TEXT NOT NULL,
      disputed_amount REAL NOT NULL DEFAULT 0,
      disputed_line_item TEXT
    );

    CREATE TABLE IF NOT EXISTS service_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reference TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      conversation_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      amount REAL,
      assigned_to TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plan_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      conversation_id TEXT,
      from_plan_id TEXT NOT NULL REFERENCES plans(id),
      to_plan_id TEXT NOT NULL REFERENCES plans(id),
      confirmed_by_customer INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      verified_at TEXT
    );

    CREATE TABLE IF NOT EXISTS action_intents (
      id TEXT PRIMARY KEY,
      preparation_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      conversation_id TEXT NOT NULL,
      request_type TEXT NOT NULL CHECK (request_type IN ('plan_change', 'refund_review')),
      target_plan_id TEXT REFERENCES plans(id),
      target_plan_name TEXT,
      target_monthly_price REAL,
      reason TEXT,
      amount REAL,
      prepared_turn_id TEXT NOT NULL,
      prepared_transcript TEXT NOT NULL DEFAULT '',
      confirmation_prompt_epoch_id TEXT,
      confirmed_turn_id TEXT,
      confirmed_transcript TEXT,
      heard_evidence_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('awaiting_confirmation', 'completed', 'superseded', 'expired')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS action_intents_pending
      ON action_intents(customer_id, conversation_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      customer_id TEXT REFERENCES customers(id),
      conversation_id TEXT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hcr_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      customer_id TEXT REFERENCES customers(id),
      stage TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT,
      state TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function seed(db) {
  const plans = [
    ["PLAN-STARTER", "Starter", 299, "Essential billing support for individuals"],
    ["PLAN-ESSENTIAL", "Essential", 499, "More usage and priority digital support"],
    ["PLAN-PREMIUM", "Premium", 799, "Higher limits with priority voice support"],
    ["PLAN-BUSINESS", "Business", 1299, "Team features and advanced support"],
  ];
  const insertPlan = db.prepare("INSERT OR IGNORE INTO plans (id, name, monthly_price, description) VALUES (?, ?, ?, ?)");
  for (const row of plans) insertPlan.run(...row);

  const customers = [
    ["CUS-001", "CUST-1001", "Dev", "dev@example.test", "+91 90000 01001", "1001", "PLAN-ESSENTIAL"],
    ["CUS-002", "CUST-1002", "Akash", "akash@example.test", "+91 90000 01002", "1002", "PLAN-PREMIUM"],
    ["CUS-003", "CUST-1003", "Priya", "priya@example.test", "+91 90000 01003", "1003", "PLAN-STARTER"],
    ["CUS-004", "CUST-1004", "Sarah", "sarah@example.test", "+91 90000 01004", "1004", "PLAN-BUSINESS"],
    ["CUS-005", "CUST-1005", "Rohan", "rohan@example.test", "+91 90000 01005", "1005", "PLAN-ESSENTIAL"],
  ];
  const insertCustomer = db.prepare(`
    INSERT OR IGNORE INTO customers
      (id, account_number, name, email, phone, pin_hash, current_plan_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBill = db.prepare(`
    INSERT OR IGNORE INTO bills
      (id, customer_id, period, amount, status, due_date, disputed_amount, disputed_line_item)
    VALUES (?, ?, 'August 2026', ?, 'open', '2026-08-31', ?, ?)
  `);
  for (const [id, account, name, email, phone, pin, plan] of customers) {
    insertCustomer.run(id, account, name, email, phone, hashValue(pin), plan, new Date().toISOString());
    const price = db.prepare("SELECT monthly_price FROM plans WHERE id = ?").get(plan).monthly_price;
    const disputed = id === "CUS-002" ? 18 : 0;
    insertBill.run(
      `BILL-${id.slice(-3)}`,
      id,
      price + disputed,
      disputed,
      disputed ? "Late payment fee" : null,
    );
  }

  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('twin_status', 'online')").run();
}

export function customerSnapshot(db, customerId) {
  const customer = db.prepare(`
    SELECT c.id, c.account_number, c.name, c.email, c.phone, c.status,
           p.id AS plan_id, p.name AS plan_name, p.monthly_price, p.description AS plan_description
    FROM customers c JOIN plans p ON p.id = c.current_plan_id
    WHERE c.id = ?
  `).get(customerId);
  if (!customer) return null;
  const bill = db.prepare("SELECT * FROM bills WHERE customer_id = ? ORDER BY due_date DESC LIMIT 1").get(customerId);
  const requests = db.prepare("SELECT * FROM service_requests WHERE customer_id = ? ORDER BY created_at DESC LIMIT 10").all(customerId);
  const changes = db.prepare(`
    SELECT pc.*, fp.name AS from_plan_name, tp.name AS to_plan_name
    FROM plan_changes pc
    JOIN plans fp ON fp.id = pc.from_plan_id
    JOIN plans tp ON tp.id = pc.to_plan_id
    WHERE pc.customer_id = ? ORDER BY pc.created_at DESC LIMIT 10
  `).all(customerId);
  return { customer, bill, requests, changes };
}
