export function recordLedger(db, {
  conversationId = "web-demo",
  customerId = null,
  stage,
  objectType,
  objectId = null,
  state,
  detail,
}) {
  db.prepare(`
    INSERT INTO hcr_ledger
      (conversation_id, customer_id, stage, object_type, object_id, state, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(conversationId, customerId, stage, objectType, objectId, state, detail, new Date().toISOString());
}

export function recordAudit(db, {
  actorType = "twin",
  actorId = "actionguard-twin",
  customerId = null,
  conversationId = null,
  eventType,
  status,
  summary,
  metadata = {},
}) {
  db.prepare(`
    INSERT INTO audit_events
      (actor_type, actor_id, customer_id, conversation_id, event_type, status, summary, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorType,
    actorId,
    customerId,
    conversationId,
    eventType,
    status,
    summary,
    JSON.stringify(metadata),
    new Date().toISOString(),
  );
}
