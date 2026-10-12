import { basename, extname } from "node:path";

import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import yauzl from "yauzl";

import {
  IMPORT_HEADERS,
  type ImportHeader,
} from "@/features/imports/validation";
import { ApplicationError } from "@/lib/application/errors";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
const MAX_COLUMNS = 30;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1000;
const MAX_COMPRESSION_RATIO = 250;

export type ParsedImportRow = {
  rowNumber: number;
  values: Record<ImportHeader, string>;
};

export type ParsedProductFile = {
  originalFilename: string;
  rows: ParsedImportRow[];
};

function validation(message: string): never {
  throw new ApplicationError("VALIDATION", message);
}

export function sanitizeImportFilename(value: string) {
  const cleaned = basename(value)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!cleaned) return "product-import";
  return cleaned.slice(0, 255);
}

function assertHeaders(header: string[]) {
  if (header.length > MAX_COLUMNS) validation("导入文件列数不能超过 30 列");
  const normalized = header.map((value) => value.trim());
  if (new Set(normalized).size !== normalized.length) {
    validation("导入文件包含重复表头");
  }
  const expected = new Set<string>(IMPORT_HEADERS);
  const unknown = normalized.filter((value) => !expected.has(value));
  const missing = IMPORT_HEADERS.filter((value) => !normalized.includes(value));
  if (
    unknown.length ||
    missing.length ||
    normalized.length !== IMPORT_HEADERS.length
  ) {
    validation(
      `导入表头不正确${missing.length ? `，缺少：${missing.join("、")}` : ""}${unknown.length ? `，未知：${unknown.join("、")}` : ""}`,
    );
  }
  return normalized as ImportHeader[];
}

function recordsToRows(
  records: string[][],
  rowNumbers?: number[],
): ParsedImportRow[] {
  if (records.length < 2) validation("导入文件至少需要一行产品数据");
  const headers = assertHeaders(records[0] ?? []);
  const rows: ParsedImportRow[] = [];
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index] ?? [];
    const rowNumber = rowNumbers?.[index] ?? index + 1;
    if (record.every((value) => value.trim() === "")) continue;
    if (record.length !== headers.length) {
      validation(`第 ${rowNumber} 行列数与表头不一致`);
    }
    rows.push({
      rowNumber,
      values: Object.fromEntries(
        headers.map((header, column) => [header, record[column] ?? ""]),
      ) as Record<ImportHeader, string>,
    });
  }
  if (rows.length === 0) validation("导入文件至少需要一行产品数据");
  if (rows.length > MAX_IMPORT_ROWS)
    validation("导入文件不能超过 5000 行产品数据");
  return rows;
}

function parseCsv(bytes: Buffer) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return validation("CSV 必须使用 UTF-8 编码");
  }
  if (text.includes("\u0000")) validation("CSV 包含无效字符");
  let records: string[][];
  try {
    records = parse(text, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      max_record_size: 20_000,
      relax_column_count: false,
    }) as string[][];
  } catch {
    return validation("CSV 格式无效或单行内容过长");
  }
  return recordsToRows(records);
}

function inspectXlsxArchive(bytes: Buffer) {
  return new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(new ApplicationError("VALIDATION", "XLSX 文件损坏或格式无效"));
          return;
        }
        let entries = 0;
        let expanded = 0;
        let settled = false;
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(new ApplicationError("VALIDATION", message));
        };
        zipFile.on("error", () => fail("XLSX 文件损坏或格式无效"));
        zipFile.on("entry", (entry) => {
          entries += 1;
          expanded += entry.uncompressedSize;
          const lower = entry.fileName.toLowerCase();
          if (
            lower.includes("vbaproject") ||
            lower.startsWith("xl/externallinks/") ||
            lower.startsWith("xl/embeddings/") ||
            lower.startsWith("xl/oleobjects/") ||
            lower.startsWith("xl/activex/")
          ) {
            fail("XLSX 不允许宏、外部链接或嵌入对象");
            return;
          }
          if (
            entries > MAX_ZIP_ENTRIES ||
            expanded > MAX_UNCOMPRESSED_BYTES ||
            (entry.compressedSize > 0 &&
              entry.uncompressedSize / entry.compressedSize >
                MAX_COMPRESSION_RATIO)
          ) {
            fail("XLSX 解压结构超过安全限制");
            return;
          }
          zipFile.readEntry();
        });
        zipFile.on("end", () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        zipFile.readEntry();
      },
    );
  });
}

function cellText(cell: ExcelJS.Cell, rowNumber: number) {
  const value = cell.value;
  if (
    cell.type === ExcelJS.ValueType.Formula ||
    (value !== null &&
      typeof value === "object" &&
      ("formula" in value || "sharedFormula" in value))
  ) {
    validation(`第 ${rowNumber} 行包含公式，XLSX 导入不允许公式`);
  }
  if (value !== null && typeof value === "object" && "hyperlink" in value) {
    validation(`第 ${rowNumber} 行包含超链接，XLSX 导入不允许超链接`);
  }
  return cell.text;
}

async function parseXlsx(bytes: Buffer) {
  await inspectXlsxArchive(bytes);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  } catch {
    return validation("XLSX 文件损坏或格式无效");
  }
  if (workbook.worksheets.length !== 1) {
    validation("XLSX 必须且只能包含一个工作表");
  }
  const sheet = workbook.worksheets[0]!;
  if (sheet.state !== "visible") validation("XLSX 数据工作表必须可见");
  if (sheet.actualColumnCount > MAX_COLUMNS)
    validation("导入文件列数不能超过 30 列");
  if (sheet.actualRowCount > MAX_IMPORT_ROWS + 1) {
    validation("导入文件不能超过 5000 行产品数据");
  }
  if (!sheet.getRow(1).hasValues) validation("XLSX 第一行必须是表头");
  const records: string[][] = [];
  const rowNumbers: number[] = [];
  const expectedWidth = sheet.getRow(1).cellCount;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const record: string[] = [];
    for (
      let column = 1;
      column <= Math.max(row.cellCount, expectedWidth);
      column += 1
    ) {
      record.push(cellText(row.getCell(column), row.number));
    }
    records.push(record);
    rowNumbers.push(row.number);
  });
  return recordsToRows(records, rowNumbers);
}

export async function parseProductImportFile(input: {
  bytes: Buffer;
  filename: string;
}) {
  if (input.bytes.length === 0) validation("导入文件不能为空");
  if (input.bytes.length > MAX_IMPORT_BYTES)
    validation("导入文件不能超过 10 MB");
  const originalFilename = sanitizeImportFilename(input.filename);
  const extension = extname(originalFilename).toLowerCase();
  if (extension !== ".csv" && extension !== ".xlsx") {
    validation("只允许上传 .csv 或 .xlsx 文件");
  }
  const isZip =
    input.bytes[0] === 0x50 &&
    input.bytes[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(input.bytes[2] ?? -1) &&
    [0x04, 0x06, 0x08].includes(input.bytes[3] ?? -1);
  if (extension === ".xlsx" && !isZip)
    validation("XLSX 文件魔数与扩展名不一致");
  if (extension === ".csv" && isZip) validation("CSV 文件魔数与扩展名不一致");
  const rows =
    extension === ".csv" ? parseCsv(input.bytes) : await parseXlsx(input.bytes);
  return { originalFilename, rows } satisfies ParsedProductFile;
}
