import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
try {
  db.exec(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec('DROP INDEX idx_messages_thread; DROP INDEX idx_messages_gmail_message_id; DROP INDEX idx_replies_thread_received; DROP INDEX idx_replies_gmail_message_unique;');
  for (const [table, column] of [
    ['messages','gmail_message_id'],['messages','thread_id'],['replies','gmail_message_id'],['replies','thread_id'],
    ['replies','suggested_reply'],['replies','return_date'],['replies','classification_error'],['replies','handled_at'],
  ]) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.exec('DROP TABLE suppressed_emails;');
  db.exec(fs.readFileSync(new URL('../migrate12.sql', import.meta.url), 'utf8'));
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  assert.ok(columns('messages').includes('gmail_message_id'));
  assert.ok(columns('messages').includes('thread_id'));
  for (const column of ['gmail_message_id','thread_id','suggested_reply','return_date','classification_error','handled_at']) assert.ok(columns('replies').includes(column));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suppressed_emails'").get());
  db.prepare("INSERT INTO suppressed_emails(email,reason) VALUES('test@example.com','unsubscribe')").run();
  assert.equal(db.prepare("SELECT reason FROM suppressed_emails WHERE email='test@example.com'").get().reason, 'unsubscribe');
  console.log('PASS migrate12 adds reply threading, draft metadata, handled state, and permanent email suppression');
} finally { db.close(); }
