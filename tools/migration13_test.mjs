import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
try {
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec('DROP TABLE suppressed_email_hashes;');
  db.exec("DELETE FROM settings WHERE key IN ('daily_send_cap','master_send_paused','sending_domain','dkim_selector','deliverability_wizard_complete','legitimate_interest_note','free_gmail_warning_acknowledged');");
  const migration = fs.readFileSync(new URL('../migrate13.sql', import.meta.url), 'utf8');
  db.exec(migration);
  db.exec(migration);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suppressed_email_hashes'").get());
  const settings = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((row) => [row.key,row.value]));
  assert.equal(settings.daily_send_cap, '25');
  assert.equal(settings.master_send_paused, '0');
  assert.equal(settings.dkim_selector, 'google');
  assert.equal(settings.deliverability_wizard_complete, '0');
  assert.match(settings.legitimate_interest_note, /B2B prospect data/);
  const columns = db.prepare('PRAGMA table_info(suppressed_email_hashes)').all().map((row) => row.name);
  assert.deepEqual(columns, ['email_hash','reason','source','created_at']);
  console.log('PASS migration13 idempotently adds hashed permanent suppression and compliance defaults');
} finally { db.close(); }
