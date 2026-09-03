import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import type archiver from 'archiver';
import * as archiverModule from 'archiver';

interface SpreadsheetColumnDefinition {
  header: string;
  key: string;
  width: number;
}

export interface SpreadsheetColumn<Row extends object> extends SpreadsheetColumnDefinition {
  key: Extract<keyof Row, string>;
}

export interface SpreadsheetSheet {
  name: string;
  columns: readonly SpreadsheetColumnDefinition[];
  rows: readonly object[];
}

const { ZipArchive } = archiverModule as unknown as {
  ZipArchive: new (options?: archiver.ArchiverOptions) => archiver.Archiver;
};

function xmlEscape(value: string): string {
  let clean = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32) {
      clean += character;
    }
  }
  return clean
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function columnName(index: number): string {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function textCell(reference: string, value: string, style = 0): string {
  const text = Array.from(value).slice(0, 32_767).join('');
  const styleAttribute = style > 0 ? ` s="${style}"` : '';
  return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

function valueCell(reference: string, value: unknown): string {
  if (value === null || value === undefined) return `<c r="${reference}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}" t="n"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (value instanceof Date) return textCell(reference, value.toISOString());
  if (typeof value === 'string' || typeof value === 'bigint') {
    return textCell(reference, String(value));
  }
  return textCell(reference, JSON.stringify(value) ?? '');
}

function* worksheetXml(
  columns: readonly SpreadsheetColumnDefinition[],
  rows: readonly object[],
): Generator<string> {
  const lastColumn = columnName(Math.max(columns.length - 1, 0));
  const lastRow = rows.length + 1;
  yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  yield '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  yield '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  yield '<cols>';
  for (const [index, column] of columns.entries()) {
    const position = index + 1;
    yield `<col min="${position}" max="${position}" width="${column.width}" customWidth="1"/>`;
  }
  yield '</cols><sheetData><row r="1">';
  for (const [index, column] of columns.entries()) {
    yield textCell(`${columnName(index)}1`, column.header, 1);
  }
  yield '</row>';
  for (const [rowIndex, row] of rows.entries()) {
    const excelRow = rowIndex + 2;
    yield `<row r="${excelRow}">`;
    for (const [columnIndex, column] of columns.entries()) {
      yield valueCell(
        `${columnName(columnIndex)}${excelRow}`,
        (row as Record<string, unknown>)[column.key],
      );
    }
    yield '</row>';
  }
  yield `</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/></worksheet>`;
}

function contentTypes(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets}</Types>`;
}

function workbook(sheetNames: string[]): string {
  const sheets = sheetNames
    .map(
      (name, index) =>
        `<sheet name="${xmlEscape(name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets}</sheets></workbook>`;
}

function workbookRelationships(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

const rootRelationships =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';

const styles =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

export async function writeXlsxWorkbook(
  filePath: string,
  sheets: readonly SpreadsheetSheet[],
): Promise<void> {
  if (sheets.length === 0) throw new Error('XLSX workbook needs at least one sheet');

  const output = createWriteStream(filePath);
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const completed = new Promise<void>((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });
  archive.pipe(output);
  archive.append(contentTypes(sheets.length), { name: '[Content_Types].xml' });
  archive.append(rootRelationships, { name: '_rels/.rels' });
  archive.append(workbook(sheets.map((sheet) => sheet.name)), { name: 'xl/workbook.xml' });
  archive.append(workbookRelationships(sheets.length), {
    name: 'xl/_rels/workbook.xml.rels',
  });
  archive.append(styles, { name: 'xl/styles.xml' });
  for (const [index, sheet] of sheets.entries()) {
    archive.append(Readable.from(worksheetXml(sheet.columns, sheet.rows)), {
      name: `xl/worksheets/sheet${index + 1}.xml`,
    });
  }
  await archive.finalize();
  await completed;
}
