/* Safe, bounded XLSX parsing adapter. Requires the pinned ExcelJS browser bundle. */
(function (root) {
  'use strict';

  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
  const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
  const MAX_ROWS = 5000;
  const MAX_COLUMNS = 100;
  const MAX_CELL_CHARS = 10000;

  function checkArchive(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const start = Math.max(0, bytes.length - 65557);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= start; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This is not a valid XLSX archive.');
    if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true)) throw new Error('Multi-disk XLSX files are not supported.');
    const entries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (!entries || entries > 500 || centralOffset + centralSize > eocd) throw new Error('XLSX archive structure is invalid or too large.');
    let offset = centralOffset, expandedTotal = 0, hasWorkbook = false;
    const decoder = new TextDecoder();
    for (let i = 0; i < entries; i++) {
      if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error('XLSX archive directory is invalid.');
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressed = view.getUint32(offset + 20, true);
      const expanded = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > bytes.length || (flags & 1) || ![0, 8].includes(method)) throw new Error('Encrypted or unsupported XLSX content is not accepted.');
      const entryName = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (entryName.startsWith('/') || entryName.split('/').includes('..')) throw new Error('Unsafe XLSX archive path.');
      if (entryName === 'xl/workbook.xml') hasWorkbook = true;
      if (expanded > MAX_ENTRY_BYTES || (compressed === 0 ? expanded > 0 : expanded / compressed > 100)) throw new Error('XLSX archive contains an unusually large compressed entry.');
      expandedTotal += expanded;
      if (expandedTotal > MAX_EXPANDED_BYTES) throw new Error('XLSX expands beyond the 25 MB import safety limit.');
      offset = end;
    }
    if (offset !== centralOffset + centralSize || !hasWorkbook) throw new Error('The XLSX workbook directory is incomplete or invalid.');
  }

  function cellText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value.richText)) return value.richText.map((part) => String(part.text || '')).join('');
    if (typeof value.text === 'string') return value.text;
    if (value.result !== undefined) return cellText(value.result);
    // Formulas are never evaluated in this importer.
    if (value.formula) return '';
    return '';
  }

  async function parse(file) {
    if (!file || !/\.xlsx$/i.test(String(file.name || ''))) throw new Error('Choose an .xlsx workbook. Legacy .xls files are not supported.');
    if (file.size > MAX_FILE_BYTES) throw new Error('Files must be 5 MB or smaller.');
    if (!root.ExcelJS) throw new Error('Excel reader is not loaded — refresh the page and try again.');
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_FILE_BYTES) throw new Error('Files must be 5 MB or smaller.');
    checkArchive(buffer);
    const workbook = new root.ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheets = workbook.worksheets.map((worksheet) => {
      if (worksheet.rowCount > MAX_ROWS + 1 || worksheet.columnCount > MAX_COLUMNS) throw new Error('Each worksheet is limited to 5,000 rows and 100 columns.');
      const headers = [];
      const used = new Map();
      for (let col = 1; col <= worksheet.columnCount; col++) {
        let name = cellText(worksheet.getRow(1).getCell(col).value).trim().slice(0, 120) || `Column ${col}`;
        const count = (used.get(name) || 0) + 1;
        used.set(name, count);
        if (count > 1) name += `_${count}`;
        headers.push(name);
      }
      const rows = [];
      let chars = 0;
      for (let rowNum = 2; rowNum <= worksheet.rowCount; rowNum++) {
        const row = {};
        let nonEmpty = false;
        for (let col = 1; col <= headers.length; col++) {
          const cell = cellText(worksheet.getRow(rowNum).getCell(col).value).slice(0, MAX_CELL_CHARS);
          chars += cell.length;
          if (chars > MAX_FILE_BYTES) throw new Error('Worksheet text exceeds the 5 MB import limit.');
          row[headers[col - 1]] = cell;
          if (cell.trim()) nonEmpty = true;
        }
        if (nonEmpty) rows.push(row);
      }
      return { name: String(worksheet.name || '').slice(0, 120), rows };
    });
    return sheets;
  }

  root.OrigamiXlsx = Object.freeze({ parse });
})(window);
