import type { ReadRow } from "@/lib/reading";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB
export const MIN_UPLOAD_NUMBER_ROWS = 3;
/** Widest or tallest picture, in pixels. A bigger one costs too much memory to redraw. */
export const MAX_UPLOAD_DIMENSION = 6000;

export const PDF_REFUSAL_MESSAGE =
  "Upload one page as a picture. A PDF is not read yet.";
export const OVERSIZE_REFUSAL_MESSAGE =
  "This file is larger than 8 MB. Upload a PNG or JPEG picture under 8 MB.";
export const UNSUPPORTED_TYPE_MESSAGE =
  "Upload a PNG or JPEG picture of a balance sheet. Other file types are not read.";
export const EMPTY_FILE_MESSAGE =
  "This file is empty. Upload a PNG or JPEG picture of a balance sheet.";
export const DIMENSION_REFUSAL_MESSAGE =
  "This picture is wider or taller than 6,000 pixels. Make it smaller and upload it again.";
export const UNREADABLE_PICTURE_MESSAGE =
  "This picture could not be read. Upload a PNG or JPEG picture of a balance sheet.";

export type UploadMimeType = "image/png" | "image/jpeg";

export type UploadRefusalCode =
  | "pdf"
  | "too_large"
  | "empty"
  | "unsupported_type"
  | "dimensions"
  | "unreadable";

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
      row.cells[1].hidden ||
      row.cells[0].disputed !== undefined ||
      row.cells[1].disputed !== undefined
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

export type ImageSize = { width: number; height: number };

const PNG_IHDR = Buffer.from("IHDR", "ascii");

/**
 * Reads a picture's width and height from its header bytes. It never decodes the picture,
 * so a picture that would take gigabytes to decode costs nothing to measure.
 * Returns null when the header does not give a size.
 */
export function readImageSize(
  buffer: Buffer,
  mimeType: UploadMimeType,
): ImageSize | null {
  if (mimeType === "image/png") {
    // 8 signature bytes, then the IHDR chunk: length, "IHDR", width, height.
    if (buffer.length < 24 || !buffer.subarray(12, 16).equals(PNG_IHDR)) {
      return null;
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // JPEG: walk the marker segments until the start-of-frame segment.
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // markers with no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end or scan before any frame
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > buffer.length) return null;
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** Refuses a picture with no readable size, or wider or taller than 6,000 pixels. */
export function checkUploadImageSize(
  buffer: Buffer,
  mimeType: UploadMimeType,
): { ok: true } | { ok: false; code: "dimensions" | "unreadable"; message: string } {
  const size = readImageSize(buffer, mimeType);
  if (!size || size.width < 1 || size.height < 1) {
    return { ok: false, code: "unreadable", message: UNREADABLE_PICTURE_MESSAGE };
  }
  if (size.width > MAX_UPLOAD_DIMENSION || size.height > MAX_UPLOAD_DIMENSION) {
    return { ok: false, code: "dimensions", message: DIMENSION_REFUSAL_MESSAGE };
  }
  return { ok: true };
}
