import type { ReadRow } from "@/lib/reading";

/** One request body of JSON text. A real statement request is a few kilobytes. */
export const MAX_JSON_BODY_BYTES = 300 * 1024;
/** Longest label that is passed on. A longer label is cut to this many characters. */
export const MAX_LABEL_CHARS = 200;
/** Most rows one request may carry. The largest saved statement has 86 number rows. */
export const MAX_REQUEST_ROWS = 200;
/** Longest number text a visitor may type into "Change". */
export const MAX_NUMBER_TEXT_CHARS = 64;

export const REQUEST_TOO_LARGE_MESSAGE =
  "This request is too large. Please start again with a smaller statement.";
export const TOO_MANY_ROWS_MESSAGE =
  "This request has too many rows. Please start again with a smaller statement.";
export const INVALID_BODY_MESSAGE = "Invalid request body.";

/** Reads a content-length header. Anything that is not plain digits counts as absent. */
export function parseContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length")?.trim();
  if (!raw || !/^\d{1,15}$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

export type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false };

/**
 * Reads a request body and stops as soon as it grows past `maxBytes`.
 * A declared content-length over the limit is refused before the body is touched.
 * A body with no content-length, or one that lies, is cut off while it streams in.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<BodyReadResult> {
  const declared = parseContentLength(request.headers);
  if (declared !== null && declared > maxBytes) {
    return { ok: false };
  }

  const stream = request.body;
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; code: "too_large" | "failed"; message: string };

/** Reads a JSON request body of at most 300 KB. */
export async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  const body = await readBodyWithLimit(request, MAX_JSON_BODY_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      status: 413,
      code: "too_large",
      message: REQUEST_TOO_LARGE_MESSAGE,
    };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body.bytes)) };
  } catch {
    return {
      ok: false,
      status: 400,
      code: "failed",
      message: INVALID_BODY_MESSAGE,
    };
  }
}

/** Cuts a visitor's text to at most `max` characters without splitting a character. */
export function clipText(value: string, max = MAX_LABEL_CHARS): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  // Drop a lone high surrogate left by the cut.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export type PreviousRowsResult =
  | { ok: true; rows: ReadRow[] | undefined }
  | { ok: false; message: string };

function parseReadCell(raw: unknown): ReadRow["cells"][0] | null {
  if (!raw || typeof raw !== "object") return null;
  const cell = raw as Record<string, unknown>;
  if (
    typeof cell.raw !== "string" ||
    cell.raw.length > MAX_LABEL_CHARS ||
    typeof cell.hidden !== "boolean" ||
    !(
      cell.number === null ||
      (typeof cell.number === "number" && Number.isFinite(cell.number))
    )
  ) {
    return null;
  }
  return { raw: cell.raw, number: cell.number, hidden: cell.hidden };
}

/**
 * Checks the `previousRows` a visitor sends back with a hide or change.
 * - More than 200 rows is refused.
 * - A value that is not a well-formed list of rows is ignored, as before.
 * - Each label is cut to 200 characters. Rebuilt rows hold only the known fields.
 * The rows come from the visitor, so they are never a trusted reading.
 */
export function parsePreviousRows(raw: unknown): PreviousRowsResult {
  if (!Array.isArray(raw)) return { ok: true, rows: undefined };
  if (raw.length > MAX_REQUEST_ROWS) {
    return { ok: false, message: TOO_MANY_ROWS_MESSAGE };
  }
  const rows: ReadRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: true, rows: undefined };
    const row = item as Record<string, unknown>;
    if (
      typeof row.label !== "string" ||
      !Array.isArray(row.cells) ||
      row.cells.length !== 2
    ) {
      return { ok: true, rows: undefined };
    }
    const left = parseReadCell(row.cells[0]);
    const right = parseReadCell(row.cells[1]);
    if (!left || !right) return { ok: true, rows: undefined };
    rows.push({ label: clipText(row.label), cells: [left, right] });
  }
  return { ok: true, rows };
}
