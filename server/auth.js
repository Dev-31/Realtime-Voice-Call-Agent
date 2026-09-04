import { randomBytes } from "node:crypto";
import { hashValue } from "./db.js";

const SESSION_HOURS = 8;

export function loginCustomer(db, accountNumber, pin) {
  const customer = db.prepare("SELECT id, account_number, name, pin_hash FROM customers WHERE account_number = ?").get(accountNumber);
  if (!customer || customer.pin_hash !== hashValue(pin)) return null;
  return createSession(db, "customer", customer.id, { accountNumber: customer.account_number, name: customer.name });
}

export function loginEmployee(db, email, password) {
  const expectedEmail = process.env.DEMO_EMPLOYEE_EMAIL || "employee@prodapt.demo";
  const expectedPassword = process.env.DEMO_EMPLOYEE_PASSWORD || "TwinForge#2026";
  if (email !== expectedEmail || password !== expectedPassword) return null;
  return createSession(db, "employee", "EMP-001", { email, name: "Maya" });
}

function createSession(db, role, principalId, profile) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token_hash, role, principal_id, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashValue(token), role, principalId, expiresAt);
  return { token, role, principalId, profile, expiresAt };
}

export function resolveSession(db, authorization) {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!token) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashValue(token));
  if (!session || Date.parse(session.expires_at) <= Date.now()) return null;
  return session;
}

export function requireRole(db, role = null) {
  return (req, res, next) => {
    const session = resolveSession(db, req.headers.authorization);
    if (!session) return res.status(401).json({ error: "Please sign in." });
    if (role && session.role !== role) return res.status(403).json({ error: "This area is not available for your role." });
    req.session = session;
    next();
  };
}

export function logout(db, authorization) {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashValue(token));
}
