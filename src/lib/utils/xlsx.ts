// A small XLSX (Office Open XML spreadsheet) writer: sheets of text, numbers
// and booleans with a styled header row, frozen panes, filters and column
// widths. Strings go into the shared-strings table once; sheet XML is built
// in chunks and packed with the app's ZIP writer, so registers with hundreds
// of thousands of rows stay out of one giant string. Opens in Excel,
// LibreOffice and openpyxl.

import { ZipWriter } from "./zip-writer";

export type Cell = string | number | boolean | null | undefined;

/** A row of a wide, mostly empty sheet: [column index, value] pairs in column order. */
export interface SparseRow {
  sparse: [number, Cell][];
}

export type Row = Cell[] | SparseRow;

/** Header colours: COBie's convention (required yellow, reference salmon, external purple, optional green) or plain. */
export type HeaderStyle = "plain" | "required" | "reference" | "external" | "optional";

export interface SheetColumn {
  header: string;
  /** Characters; estimated from the content when absent. */
  width?: number;
  style?: HeaderStyle;
}

export interface SheetDef {
  name: string;
  columns: SheetColumn[];
  rows: Row[];
  /** Freeze the header row (default true). */
  freeze?: boolean;
  /** Add filter buttons to the header (default true). */
  filter?: boolean;
  /** Sheet tab colour, "RRGGBB". */
  tab?: string;
}

/** Rows a sheet can hold under its header. */
export const MAX_ROWS = 1_048_575;
const MAX_CELL = 32_767;

const STYLE_INDEX: Record<HeaderStyle, number> = { plain: 1, required: 2, reference: 3, external: 4, optional: 5 };

function column(n: number): string {
  let s = "";
  for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// XML 1.0 forbids most control characters.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function xml(text: string): string {
  return text.replace(INVALID_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A valid, unique sheet name (31 characters, none of []:*?/\). */
function sheetName(name: string, taken: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Sheet";
  let out = base;
  for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${base.slice(0, 31 - String(n).length - 3)} (${n})`;
  taken.add(out.toLowerCase());
  return out;
}

class Chunks {
  private parts: BlobPart[] = [];
  private buf: string[] = [];
  private size = 0;
  push(text: string) {
    this.buf.push(text);
    this.size += text.length;
    if (this.size > 1 << 20) this.flush();
  }
  flush() {
    if (this.buf.length) this.parts.push(this.buf.join(""));
    this.buf = [];
    this.size = 0;
  }
  blob(type = "application/xml"): Blob {
    this.flush();
    return new Blob(this.parts, { type });
  }
}

export interface WorkbookMeta {
  title?: string;
  creator?: string;
  company?: string;
}

/** Writes sheets into an .xlsx Blob. Sheets over the row limit continue on further sheets ("Name (2)"). */
export async function writeXlsx(sheets: SheetDef[], meta: WorkbookMeta = {}): Promise<Blob> {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const sst = (text: string) => {
    let i = stringIndex.get(text);
    if (i === undefined) {
      i = strings.length;
      strings.push(text);
      stringIndex.set(text, i);
    }
    return i;
  };

  // Split sheets that exceed the row limit.
  const taken = new Set<string>();
  const parts: (SheetDef & { title: string })[] = [];
  for (const sheet of sheets) {
    if (sheet.rows.length <= MAX_ROWS) {
      parts.push({ ...sheet, title: sheetName(sheet.name, taken) });
      continue;
    }
    for (let i = 0, n = 1; i < sheet.rows.length; i += MAX_ROWS, n++) parts.push({ ...sheet, rows: sheet.rows.slice(i, i + MAX_ROWS), title: sheetName(n === 1 ? sheet.name : `${sheet.name} (${n})`, taken) });
  }

  const zip = new ZipWriter();
  const sheetBlobs: Blob[] = [];
  for (const sheet of parts) {
    const cols = sheet.columns.length;
    const rows = sheet.rows;
    // Widths from the header and a sample of rows.
    const sampled = new Array<number>(cols).fill(0);
    for (let r = 0; r < Math.min(rows.length, 400); r++) {
      const row = rows[r];
      const cells: [number, Cell][] = "sparse" in row ? row.sparse : row.map((v, j) => [j, v] as [number, Cell]);
      for (const [j, v] of cells) if (j < cols && v !== null && v !== undefined) sampled[j] = Math.max(sampled[j], String(v).length + 1);
    }
    const widths = sheet.columns.map((c, j) => (c.width ? c.width : Math.min(60, Math.max(8, c.header.length + 3, sampled[j]))));
    const last = `${column(Math.max(cols - 1, 0))}${rows.length + 1}`;
    const out = new Chunks();
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    out.push(`<sheetPr>${sheet.tab ? `<tabColor rgb="FF${sheet.tab}"/>` : ""}</sheetPr>`);
    out.push(`<dimension ref="A1:${last}"/>`);
    out.push('<sheetViews><sheetView workbookViewId="0">');
    if (sheet.freeze !== false) out.push('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>');
    out.push("</sheetView></sheetViews>");
    out.push('<sheetFormatPr defaultRowHeight="15"/>');
    if (cols) out.push(`<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${Math.round(w * 10) / 10}" customWidth="1"/>`).join("")}</cols>`);
    out.push("<sheetData>");
    out.push(`<row r="1">${sheet.columns.map((c, j) => `<c r="${column(j)}1" t="s" s="${STYLE_INDEX[c.style ?? "plain"]}"><v>${sst(c.header)}</v></c>`).join("")}</row>`);
    const letters = sheet.columns.map((_, j) => column(j));
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const n = r + 2;
      let line = `<row r="${n}">`;
      const sparse = "sparse" in row ? row.sparse : null;
      const count = sparse ? sparse.length : cols;
      for (let i = 0; i < count; i++) {
        const j = sparse ? sparse[i][0] : i;
        const v = sparse ? sparse[i][1] : (row as Cell[])[i];
        if (j >= cols || v === null || v === undefined || v === "") continue;
        if (typeof v === "number") {
          if (Number.isFinite(v)) line += `<c r="${letters[j]}${n}"><v>${v}</v></c>`;
        } else if (typeof v === "boolean") line += `<c r="${letters[j]}${n}" t="b"><v>${v ? 1 : 0}</v></c>`;
        else {
          const text = v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v;
          line += `<c r="${letters[j]}${n}" t="s"><v>${sst(text)}</v></c>`;
        }
      }
      out.push(`${line}</row>`);
    }
    out.push("</sheetData>");
    if (sheet.filter !== false && cols) out.push(`<autoFilter ref="A1:${last}"/>`);
    out.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>');
    sheetBlobs.push(out.blob());
  }

  // Shared strings (after every sheet has added its text).
  const shared = new Chunks();
  shared.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">`);
  for (const s of strings) shared.push(/^\s|\s$/.test(s) ? `<si><t xml:space="preserve">${xml(s)}</t></si>` : `<si><t>${xml(s)}</t></si>`);
  shared.push("</sst>");

  const sheetEntries = parts.map((p, i) => ({ title: p.title, file: `sheet${i + 1}.xml`, rid: `rId${i + 1}`, filter: p.filter !== false && p.columns.length > 0, last: `$${column(Math.max(p.columns.length - 1, 0))}$${p.rows.length + 1}` }));
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheetEntries.map((s) => `<Override PartName="/xl/worksheets/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
  const definedNames = sheetEntries
    .map((s, i) => (s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xml(`'${s.title.replace(/'/g, "''")}'!$A$1:${s.last}`)}</definedName>` : ""))
    .join("");
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews><sheets>' +
    sheetEntries.map((s, i) => `<sheet name="${xml(s.title)}" sheetId="${i + 1}" r:id="${s.rid}"/>`).join("") +
    `</sheets>${definedNames ? `<definedNames>${definedNames}</definedNames>` : ""}</workbook>`;
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheetEntries.map((s) => `<Relationship Id="${s.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`).join("") +
    `<Relationship Id="rId${sheetEntries.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${sheetEntries.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const fill = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    `<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill("D9E1F2")}${fill("FFFF99")}${fill("FFCC99")}${fill("CC99FF")}${fill("CCFFCC")}</fills>` +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF8EA9DB"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    [2, 3, 4, 5, 6].map((f) => `<xf numFmtId="0" fontId="1" fillId="${f}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>`).join("") +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xml(meta.title ?? "")}</dc:title><dc:creator>${xml(meta.creator ?? "IFC Studio")}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>IFC Studio</Application>${meta.company ? `<Company>${xml(meta.company)}</Company>` : ""}</Properties>`;

  const text = (s: string) => new Blob([s], { type: "application/xml" });
  await zip.addBlob("[Content_Types].xml", text(contentTypes));
  await zip.addBlob("_rels/.rels", text(rootRels));
  await zip.addBlob("docProps/core.xml", text(core));
  await zip.addBlob("docProps/app.xml", text(app));
  await zip.addBlob("xl/workbook.xml", text(workbook));
  await zip.addBlob("xl/_rels/workbook.xml.rels", text(workbookRels));
  await zip.addBlob("xl/styles.xml", text(styles));
  for (let i = 0; i < sheetBlobs.length; i++) await zip.addBlob(`xl/worksheets/${sheetEntries[i].file}`, sheetBlobs[i]);
  await zip.addBlob("xl/sharedStrings.xml", shared.blob());
  const blob = zip.finish();
  return new Blob([blob], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
