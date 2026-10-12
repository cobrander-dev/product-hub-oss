import ExcelJS from "exceljs";

export type ExportCell = string | number | null;
export type ExportColumn = {
  header: string;
  width: number;
  numberFormat?: string;
};

export function protectSpreadsheetText(value: string) {
  return /^[\t\r]|^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: ExportCell) {
  const text =
    typeof value === "string"
      ? protectSpreadsheetText(value)
      : (value?.toString() ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createCsv(columns: ExportColumn[], rows: ExportCell[][]) {
  const lines = [
    columns.map((column) => csvCell(column.header)).join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ];
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

export async function createXlsx(
  sheetName: string,
  columns: ExportColumn[],
  rows: ExportCell[][],
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Product Hub";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(sheetName, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  worksheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.header,
    width: column.width,
    style: column.numberFormat ? { numFmt: column.numberFormat } : undefined,
  }));
  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF334155" },
  };
  header.alignment = { vertical: "middle" };
  for (const values of rows) {
    const row = worksheet.addRow(values);
    row.eachCell((cell) => {
      if (typeof cell.value === "string")
        cell.value = protectSpreadsheetText(cell.value);
    });
  }
  worksheet.autoFilter = { from: "A1", to: { row: 1, column: columns.length } };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
