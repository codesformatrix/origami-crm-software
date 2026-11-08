import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db=new DatabaseSync(':memory:');
try{
  db.exec(fs.readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  db.exec('DROP TABLE domain_suppressions; DROP TABLE bounce_events;');
  db.exec('ALTER TABLE enrollments DROP COLUMN stop_reason;');
  db.exec('ALTER TABLE emails DROP COLUMN enrollment_id; ALTER TABLE emails DROP COLUMN sequence_id;');
  db.exec('ALTER TABLE copywriting_jobs DROP COLUMN enrollment_id; ALTER TABLE copywriting_jobs DROP COLUMN sequence_id;');
  db.exec("DELETE FROM settings WHERE key IN ('gmail_step2_business_days','gmail_step3_business_days','gmail_step4_business_days')");
  db.exec(fs.readFileSync(new URL('../migrate11.sql',import.meta.url),'utf8'));
  for(const table of ['bounce_events','domain_suppressions']) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  assert.ok(db.prepare('PRAGMA table_info(enrollments)').all().some(row=>row.name==='stop_reason'));
  assert.ok(db.prepare('PRAGMA table_info(emails)').all().some(row=>row.name==='sequence_id'));
  assert.ok(db.prepare('PRAGMA table_info(copywriting_jobs)').all().some(row=>row.name==='enrollment_id'));
  assert.deepEqual(['gmail_step2_business_days','gmail_step3_business_days','gmail_step4_business_days'].map(key=>db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value),['3','4','5']);
  console.log('PASS migrate11 applies to the pre-scheduler CRM schema');
} finally { db.close(); }
