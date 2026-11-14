import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import ExcelJS from 'exceljs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
dom.window.TextDecoder = TextDecoder;
dom.window.eval(fs.readFileSync(path.join(root, 'static/vendor/exceljs.min.js'), 'utf8'));
dom.window.eval(fs.readFileSync(path.join(root, 'static/xlsx-import.js'), 'utf8'));
assert.equal(typeof dom.window.OrigamiXlsx?.parse, 'function');

const workbook = new ExcelJS.Workbook();
workbook.addWorksheet('Blank');
const sheet = workbook.addWorksheet('Prospects');
sheet.addRow(['Company', 'Email', 'Email', 'Formula']);
sheet.addRow(['Origami Example', 'jane@example.com', 'alt@example.com', { formula: '1+1' }]);
const nodeBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
function asWindowBuffer(buffer) {
  const result = new dom.window.ArrayBuffer(buffer.length);
  new dom.window.Uint8Array(result).set(buffer);
  return result;
}
const arrayBuffer = asWindowBuffer(nodeBuffer);
const file = { name: 'prospects.xlsx', size: nodeBuffer.length, arrayBuffer: async () => arrayBuffer };
const sheets = await dom.window.OrigamiXlsx.parse(file);
assert.equal(sheets.length, 2);
assert.equal(sheets[1].rows[0].Company, 'Origami Example');
assert.equal(sheets[1].rows[0].Email, 'jane@example.com');
assert.equal(sheets[1].rows[0].Email_2, 'alt@example.com');
assert.equal(sheets[1].rows[0].Formula, '', 'formula cells without cached results must not be evaluated');
console.log('PASS bounded XLSX parsing, duplicate headers and formula non-execution');
const templateBytes = Buffer.from(fs.readFileSync(path.join(root, 'CRM-import-template.xlsx')));
const templateArray = asWindowBuffer(templateBytes);
const templateSheets = await dom.window.OrigamiXlsx.parse({ name: 'CRM-import-template.xlsx', size: templateBytes.length, arrayBuffer: async () => templateArray });
assert.equal(templateSheets[0].name, 'Prospects');
assert.ok(templateSheets[0].rows.length === 0);
assert.ok(templateSheets[0] && templateSheets.length === 1);
console.log('PASS shipped blank import template parses correctly');

await assert.rejects(() => dom.window.OrigamiXlsx.parse({ ...file, name: 'legacy.xls' }), /Legacy/);
await assert.rejects(() => dom.window.OrigamiXlsx.parse({ ...file, size: 6 * 1024 * 1024 }), /5 MB/);
console.log('PASS legacy XLS and oversized files are rejected');

const bomb = nodeBuffer.slice();
const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
let eocd = -1;
for (let i = bomb.length - 22; i >= Math.max(0, bomb.length - 65557); i--) {
  if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
}
assert.ok(eocd >= 0);
let offset = view.getUint32(eocd + 16, true);
const count = view.getUint16(eocd + 10, true);
for (let i = 0; i < count; i++) {
  const nameLength = view.getUint16(offset + 28, true);
  const extraLength = view.getUint16(offset + 30, true);
  const commentLength = view.getUint16(offset + 32, true);
  const name = new TextDecoder().decode(new Uint8Array(bomb.buffer, bomb.byteOffset + offset + 46, nameLength));
  if (name === 'xl/workbook.xml') { view.setUint32(offset + 24, 9 * 1024 * 1024, true); break; }
  offset += 46 + nameLength + extraLength + commentLength;
}
const badFile = { name: 'bomb.xlsx', size: bomb.length, arrayBuffer: async () => asWindowBuffer(bomb) };
await assert.rejects(() => dom.window.OrigamiXlsx.parse(badFile), /large compressed entry/);
console.log('PASS XLSX expansion limits reject a zip-bomb-style archive');
dom.window.close();
