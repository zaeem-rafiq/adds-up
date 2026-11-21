import type { ReadRow } from "@/lib/reading";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB
export const MIN_UPLOAD_NUMBER_ROWS = 3;

export const PDF_REFUSAL_MESSAGE =
  "Upload one page as a picture. A PDF is not read yet.";
export const OVERSIZE_REFUSAL_MESSAGE =
  "This file is larger than 8 MB. Upload a PNG or JPEG picture under 8 MB.";
export const UNSUPPORTED_TYPE_MESSAGE =
  "Upload a PNG or JPEG picture of a balance sheet. Other file types are not read.";
export const EMPTY_FILE_MESSAGE =
  "This file is empty. Upload a PNG or JPEG picture of a balance sheet.";

export type UploadMimeType = "image/png" | "image/jpeg";

export type UploadRefusalCode =
  | "pdf"
  | "too_large"
  | "empty"
  | "unsupported_type";

export type UploadValidationResult =
  | {
      ok: true;
      mimeType: UploadMimeType;
      fileName: string;
    }
  | {
      ok: false;
      code: UploadRefusalCode;
      message: string;
    };

export function sanitizeUploadFileName(rawName: string): string {
  const normalized = rawName.replace(/\\/g, "/");
  const base = normalized.split("/").pop()?.trim() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return "statement.png";
  return cleaned.slice(0, 160);
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return "";
  return fileName.slice(dot).toLowerCase();
}

export function isPdfMeta(name: string, type?: string): boolean {
  const lowerType = (type ?? "").trim().toLowerCase();
  if (lowerType === "application/pdf" || lowerType === "application/x-pdf") {
    return true;
  }
  return extensionOf(name) === ".pdf";
}

export function inferImageMimeFromMeta(
  name: string,
  type?: string,
): UploadMimeType | null {
  const lowerType = (type ?? "").trim().toLowerCase();
  if (lowerType === "image/png") return "image/png";
  if (lowerType === "image/jpeg" || lowerType === "image/jpg") {
    return "image/jpeg";
  }

  // Only infer from file extension when MIME type is empty or generic.
  if (!lowerType || lowerType === "application/octet-stream") {
    const ext = extensionOf(name);
    if (ext === ".png") return "image/png";
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  }

  return null;
}

export function validateUploadFileMeta(meta: {
  name: string;
  type?: string;
  size: number;
}): UploadValidationResult {
  const fileName = sanitizeUploadFileName(meta.name);

  if (isPdfMeta(fileName, meta.type)) {
    return {
      ok: false,
      code: "pdf",
      message: PDF_REFUSAL_MESSAGE,
    };
  }

  if (!Number.isFinite(meta.size) || meta.size <= 0) {
    return {
      ok: false,
      code: "empty",
      message: EMPTY_FILE_MESSAGE,
    };
  }

  if (meta.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: OVERSIZE_REFUSAL_MESSAGE,
    };
  }

  const mimeType = inferImageMimeFromMeta(fileName, meta.type);
  if (!mimeType) {
    return {
      ok: false,
      code: "unsupported_type",
      message: UNSUPPORTED_TYPE_MESSAGE,
    };
  }

  return {
    ok: true,
    mimeType,
    fileName,
  };
}

/**
 * Counts how many parsed rows contain at least one numeric value (or a hidden cell).
 */
export function countNumberRowsInReading(rows: readonly ReadRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (
      row.cells[0].number !== null ||
      row.cells[1].number !== null ||
      row.cells[0].hidden ||
      row.cells[1].hidden
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * An uploaded picture counts as a readable statement only when Hydrogen
 * returns at least 3 number rows.
 */
export function hasEnoughStatementRows(rows: readonly ReadRow[]): boolean {
  return countNumberRowsInReading(rows) >= MIN_UPLOAD_NUMBER_ROWS;
}
