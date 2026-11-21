import { randomUUID } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { ensureStatementFonts } from "@/lib/draw-statement";
import {
  GEMINI_HYDROGEN_MODEL,
  getSecondReaderModelName,
  READING_PROMPT,
  type GeminiClient,
  type LocateCellBoxRequest,
} from "@/lib/gemini";
import { countDisputedCells, mergeReadings } from "@/lib/merge-readings";
import { logServerError, MODEL_FAILED_MESSAGE } from "@/lib/public-errors";
import { RateLimitError, type RateLimiter } from "@/lib/rate-limit";
import {
  computePictureCacheKey,
  countReadNumbers,
  getReadTimeoutMs,
  parseReadingReply,
  ReadingFailedError,
  ReadingTimeoutError,
  type ReadingCache,
  type ReadingProgressEvent,
  type ReadRow,
  type StatementReadingResult,
  type UploadCrossCheck,
} from "@/lib/reading";
import {
  countNumberRowsInReading,
  EMPTY_FILE_MESSAGE,
  hasEnoughStatementRows,
  isPdfMeta,
  MAX_UPLOAD_BYTES,
  OVERSIZE_REFUSAL_MESSAGE,
  PDF_REFUSAL_MESSAGE,
  sanitizeUploadFileName,
  UNSUPPORTED_TYPE_MESSAGE,
  type UploadMimeType,
  type UploadValidationResult,
} from "@/lib/upload-validation";

export const UPLOAD_TTL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_UPLOAD_ENTRIES = 100;
/** Total memory the store may hold: every picture plus every redrawn picture. */
export const MAX_UPLOAD_STORE_BYTES = 150 * 1024 * 1024; // 150 MB

export class UploadStoreFullError extends Error {
  constructor() {
    super("The upload store cannot hold this picture.");
    this.name = "UploadStoreFullError";
  }
}

const FONT_FAMILY = "AddsUpDejaVu";

export type NormalizedCellBox = {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
};

export type UploadReadingOutcome =
  | {
      status: "ok";
      result: StatementReadingResult;
    }
  | {
      status: "no_statement";
      rows: ReadRow[];
      rowCount: number;
      fromCache: boolean;
      usedRepeat: boolean;
      modelCalls: number;
    };

export type UploadRecord = {
  id: string;
  fileName: string;
  mimeType: UploadMimeType;
  buffer: Buffer;
  createdAt: number;
  expiresAt: number;
  reading?: UploadReadingOutcome;
  cellBoxes: Map<string, NormalizedCellBox>;
  modifiedPictures: Map<string, Buffer>;
  /**
   * Keeps a redrawn picture under the store's byte cap, dropping older pictures when
   * needed. Returns false when the picture cannot be kept.
   */
  addModifiedPicture: (key: string, png: Buffer) => boolean;
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function hasPngSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function hasJpegSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  );
}

function hasPdfSignature(buffer: Buffer): boolean {
  return (
    buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-"
  );
}

export function detectImageMimeFromBytes(
  buffer: Buffer,
): UploadMimeType | null {
  if (hasPngSignature(buffer)) return "image/png";
  if (hasJpegSignature(buffer)) return "image/jpeg";
  return null;
}

/**
 * Server-side upload check. Verifies PDF refusal, 8 MB size cap, and actual
 * PNG/JPEG magic bytes before any storage or model call.
 */
export function validateUploadBuffer(
  buffer: Buffer,
  meta: { name: string; type?: string; size?: number },
): UploadValidationResult {
  const fileName = sanitizeUploadFileName(meta.name);
  const declaredSize = meta.size ?? buffer.length;

  if (isPdfMeta(fileName, meta.type) || hasPdfSignature(buffer)) {
    return {
      ok: false,
      code: "pdf",
      message: PDF_REFUSAL_MESSAGE,
    };
  }

  if (buffer.length === 0 || declaredSize <= 0) {
    return {
      ok: false,
      code: "empty",
      message: EMPTY_FILE_MESSAGE,
    };
  }

  if (buffer.length > MAX_UPLOAD_BYTES || declaredSize > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: OVERSIZE_REFUSAL_MESSAGE,
    };
  }

  const detectedMime = detectImageMimeFromBytes(buffer);
  if (!detectedMime) {
    return {
      ok: false,
      code: "unsupported_type",
      message: UNSUPPORTED_TYPE_MESSAGE,
    };
  }

  return {
    ok: true,
    mimeType: detectedMime,
    fileName,
  };
}

function recordBytes(record: UploadRecord): number {
  let total = record.buffer.length;
  for (const picture of record.modifiedPictures.values()) {
    total += picture.length;
  }
  return total;
}

/**
 * Keeps uploaded pictures and their readings in server memory only,
 * under a random UUID, for one hour. Never writes to disk.
 * It holds at most `maxEntries` uploads and `maxBytes` in total, counting every redrawn
 * picture. When either limit is reached the oldest upload goes first.
 */
export class UploadStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, UploadRecord>();

  constructor(options?: {
    ttlMs?: number;
    maxEntries?: number;
    maxBytes?: number;
    now?: () => number;
  }) {
    this.ttlMs = options?.ttlMs ?? UPLOAD_TTL_MS;
    this.maxEntries = options?.maxEntries ?? MAX_UPLOAD_ENTRIES;
    this.maxBytes = options?.maxBytes ?? MAX_UPLOAD_STORE_BYTES;
    this.now = options?.now ?? (() => Date.now());
  }

  private pruneExpired(): void {
    const current = this.now();
    for (const [id, record] of this.entries) {
      if (current >= record.expiresAt) {
        this.entries.delete(id);
      }
    }
  }

  /** Bytes held now: every stored picture and every redrawn picture. */
  get totalBytes(): number {
    let total = 0;
    for (const record of this.entries.values()) {
      total += recordBytes(record);
    }
    return total;
  }

  create(params: {
    fileName: string;
    mimeType: UploadMimeType;
    buffer: Buffer;
  }): UploadRecord {
    if (params.buffer.length > this.maxBytes) {
      throw new UploadStoreFullError();
    }
    this.pruneExpired();

    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries ||
        this.totalBytes + params.buffer.length > this.maxBytes)
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }

    const createdAt = this.now();
    const record: UploadRecord = {
      id: randomUUID(),
      fileName: sanitizeUploadFileName(params.fileName),
      mimeType: params.mimeType,
      buffer: Buffer.from(params.buffer),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      cellBoxes: new Map(),
      modifiedPictures: new Map(),
      addModifiedPicture: (key, png) =>
        this.addModifiedPicture(record, key, png),
    };
    this.entries.set(record.id, record);
    return record;
  }

  private addModifiedPicture(
    record: UploadRecord,
    key: string,
    png: Buffer,
  ): boolean {
    this.pruneExpired();
    // A record that was evicted or expired is gone: nothing may be added to it.
    if (this.entries.get(record.id) !== record) return false;
    if (record.modifiedPictures.has(key)) return true;
    if (record.buffer.length + png.length > this.maxBytes) return false;

    const fits = () => this.totalBytes + png.length <= this.maxBytes;
    // First drop this upload's own older redraws, so one upload cannot push out other
    // visitors' pictures with a stream of redraws. Then drop the oldest other uploads.
    for (const oldKey of [...record.modifiedPictures.keys()]) {
      if (fits()) break;
      record.modifiedPictures.delete(oldKey);
    }
    for (const [id] of [...this.entries]) {
      if (fits()) break;
      if (id !== record.id) this.entries.delete(id);
    }
    if (!fits()) return false;

    record.modifiedPictures.set(key, png);
    return true;
  }

  get(id: string): UploadRecord | undefined {
    const record = this.entries.get(id);
    if (!record) return undefined;
    if (this.now() >= record.expiresAt) {
      this.entries.delete(id);
      return undefined;
    }
    return record;
  }

  setReading(id: string, reading: UploadReadingOutcome): boolean {
    const record = this.get(id);
    if (!record) return false;
    record.reading = reading;
    return true;
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }
}

const globalForUploads = globalThis as typeof globalThis & {
  __addsUpUploadStore?: UploadStore;
};

export function getGlobalUploadStore(): UploadStore {
  if (!globalForUploads.__addsUpUploadStore) {
    globalForUploads.__addsUpUploadStore = new UploadStore();
  }
  return globalForUploads.__addsUpUploadStore;
}

export function resetGlobalUploadStore(): void {
  globalForUploads.__addsUpUploadStore = undefined;
}

function buildUploadReadingResult(
  rows: ReadRow[],
  meta: {
    fromCache: boolean;
    usedRepeat: boolean;
    modelCalls: number;
    crossCheck?: UploadCrossCheck;
  },
): StatementReadingResult {
  return {
    rows,
    comparison: {
      totalStatementNumbers: 0,
      readCount: countReadNumbers(rows),
      matchCount: 0,
      unreadCount: 0,
      rows: [],
    },
    fromCache: meta.fromCache,
    usedRepeat: meta.usedRepeat,
    modelCalls: meta.modelCalls,
    ...(meta.crossCheck ? { crossCheck: meta.crossCheck } : {}),
  };
}

/**
 * Runs one whole-picture Hydrogen reading call with the 12-second limit and one repeat.
 * Unlike SEC statements (which always have numbers), an uploaded picture may genuinely
 * contain no statement: if the model answers cleanly with 0 rows on both tries, this
 * resolves with `rows: []` instead of throwing, so the UI can show desktop-badupload.png.
 * If the model throws errors or times out on both tries, this rejects so the UI shows
 * the error/timeout screen with Try again.
 */
function readUploadPictureWithSpeedRule(options: {
  call: (attempt: 1 | 2, signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onSlow?: () => void;
  onModelCall?: () => void;
}): Promise<{
  rows: ReadRow[];
  usedRepeat: boolean;
  modelCalls: number;
}> {
  const { call, timeoutMs, signal: outerSignal, onSlow, onModelCall } = options;

  return new Promise((resolve, reject) => {
    if (outerSignal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let settled = false;
    let repeatStarted = false;
    let modelCalls = 0;
    let activeAttempts = 0;
    let sawCleanEmptyReply = false;

    let firstTimer: ReturnType<typeof setTimeout> | null = null;
    let secondTimer: ReturnType<typeof setTimeout> | null = null;
    const controllers: AbortController[] = [];

    const cleanup = () => {
      if (firstTimer !== null) {
        clearTimeout(firstTimer);
        firstTimer = null;
      }
      if (secondTimer !== null) {
        clearTimeout(secondTimer);
        secondTimer = null;
      }
      outerSignal?.removeEventListener("abort", onOuterAbort);
      for (const controller of controllers) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }
    };

    const finishSuccess = (rows: ReadRow[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ rows, usedRepeat: repeatStarted, modelCalls });
    };

    const finishFailure = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onOuterAbort = () => {
      finishFailure(new DOMException("Aborted", "AbortError"));
    };

    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    const startRepeat = (fromTimeout: boolean) => {
      if (settled || repeatStarted) return;
      repeatStarted = true;
      if (fromTimeout) {
        onSlow?.();
      }
      secondTimer = setTimeout(() => {
        finishFailure(
          new ReadingTimeoutError(
            "A model did not answer within 12 seconds. Nothing was guessed.",
            1,
            1,
          ),
        );
      }, timeoutMs);
      startAttempt(2);
    };

    const startAttempt = (attempt: 1 | 2) => {
      // The hook counts this call against the daily cap and throws when the cap is
      // reached. A refused attempt makes no model call.
      try {
        onModelCall?.();
      } catch (error) {
        if (activeAttempts === 0) {
          finishFailure(
            error instanceof Error
              ? error
              : new ReadingFailedError(MODEL_FAILED_MESSAGE, 1, 1),
          );
        }
        return;
      }
      const controller = new AbortController();
      controllers.push(controller);
      activeAttempts += 1;
      modelCalls += 1;

      void call(attempt, controller.signal)
        .then((rawReply) => {
          if (settled) return;
          const rows = parseReadingReply(rawReply);
          if (rows.length > 0) {
            finishSuccess(rows);
            return;
          }

          sawCleanEmptyReply = true;
          activeAttempts -= 1;
          if (!repeatStarted) {
            if (firstTimer !== null) {
              clearTimeout(firstTimer);
              firstTimer = null;
            }
            startRepeat(false);
          } else if (activeAttempts === 0) {
            finishSuccess([]);
          }
        })
        .catch((error: unknown) => {
          if (settled) return;
          activeAttempts -= 1;
          if (!repeatStarted) {
            if (firstTimer !== null) {
              clearTimeout(firstTimer);
              firstTimer = null;
            }
            startRepeat(false);
          } else if (activeAttempts === 0) {
            if (sawCleanEmptyReply) {
              finishSuccess([]);
              return;
            }
            logServerError("reading an uploaded picture", error);
            finishFailure(new ReadingFailedError(MODEL_FAILED_MESSAGE, 1, 1));
          }
        });
    };

    firstTimer = setTimeout(() => {
      startRepeat(true);
    }, timeoutMs);

    startAttempt(1);
  });
}

export type ReadUploadedPictureOptions = {
  record: UploadRecord;
  client: GeminiClient;
  cache?: ReadingCache;
  rateLimiter?: RateLimiter;
  browserId?: string;
  ip?: string;
  timeoutMs?: number;
  slow?: boolean;
  bypassCache?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: ReadingProgressEvent) => void;
};

/**
 * Reads an uploaded PNG/JPEG picture whole, the first time, with two models at the same time:
 * Gemini 4 Hydrogen and the model named in SECOND_READER_MODEL. Each call gets the same
 * picture, the same question, the 12-second limit and one repeat, and counts as a model call
 * against the daily cap. A number is kept only when both read the same value. Where they
 * differ, the cell comes back as NOT READ with both raw texts in `disputed`. When the second
 * reader fails twice or returns no rows, the first reading stands alone and the result says so.
 */
export async function readUploadedPicture(
  options: ReadUploadedPictureOptions,
): Promise<UploadReadingOutcome> {
  const {
    record,
    client,
    cache,
    rateLimiter,
    browserId = "anonymous",
    ip = "unknown",
    timeoutMs = getReadTimeoutMs(),
    slow = false,
    bypassCache = false,
    signal,
    onProgress,
  } = options;

  const secondModel = getSecondReaderModelName();
  // Rows kept for a two-reader reading differ from a single reading of the same bytes, so
  // they live under their own key.
  // The fake client answers by file name, so in test mode the name is part of the key.
  const cacheKey = `${computePictureCacheKey([record.buffer])}:${secondModel}${
    client.isFake ? `:${record.fileName}` : ""
  }`;

  if (!bypassCache && record.reading) {
    if (record.reading.status === "ok") {
      const cachedResult: StatementReadingResult = {
        ...record.reading.result,
        fromCache: true,
        usedRepeat: false,
        modelCalls: 0,
      };
      onProgress?.({ type: "done", result: cachedResult });
      return { status: "ok", result: cachedResult };
    }
    onProgress?.({
      type: "bad_upload",
      fileName: record.fileName,
      rowCount: record.reading.rowCount,
    });
    return {
      ...record.reading,
      fromCache: true,
      usedRepeat: false,
      modelCalls: 0,
    };
  }

  if (!bypassCache && cache) {
    const cachedRows = cache.get(cacheKey);
    if (cachedRows !== undefined) {
      const rowCount = countNumberRowsInReading(cachedRows);
      if (!hasEnoughStatementRows(cachedRows)) {
        const outcome: UploadReadingOutcome = {
          status: "no_statement",
          rows: cachedRows,
          rowCount,
          fromCache: true,
          usedRepeat: false,
          modelCalls: 0,
        };
        record.reading = outcome;
        onProgress?.({
          type: "bad_upload",
          fileName: record.fileName,
          rowCount,
        });
        return outcome;
      }

      const result = buildUploadReadingResult(cachedRows, {
        fromCache: true,
        usedRepeat: false,
        modelCalls: 0,
        crossCheck: {
          answered: true,
          disputedCount: countDisputedCells(cachedRows),
        },
      });
      const outcome: UploadReadingOutcome = { status: "ok", result };
      record.reading = outcome;
      onProgress?.({ type: "done", result });
      return outcome;
    }
  }

  // The request-level check needs room for the one call the first reader must make. The
  // second reader is best effort: each of its attempts is counted against the daily cap
  // when it starts, and a refused attempt only costs the second reading.
  if (rateLimiter) {
    const decision = rateLimiter.checkAndConsumeRequest({
      browserId,
      ip,
      plannedModelCalls: 1,
    });
    if (!decision.allowed) {
      throw new RateLimitError(
        decision.message,
        decision.reason,
        decision.retryAfterSeconds,
      );
    }
  }

  onProgress?.({ type: "started", totalNumbers: 0, totalStrips: 1 });

  let slowEmitted = false;
  const onSlow = () => {
    if (!slowEmitted) {
      slowEmitted = true;
      onProgress?.({
        type: "slow",
        strip: 1,
        totalStrips: 1,
        timeoutMs,
      });
    }
  };
  const readWith = (model: string, isSecondReader: boolean) =>
    (attempt: 1 | 2, attemptSignal: AbortSignal) =>
      client.readPicture({
        png: record.buffer,
        mimeType: record.mimeType,
        prompt: READING_PROMPT,
        model,
        signal: attemptSignal,
        testContext: {
          strip: 1,
          totalStrips: 1,
          slow,
          attempt,
          timeoutMs,
          uploadFileName: record.fileName,
          uploadSecondReader: isSecondReader,
        },
      });

  // The first reader starts first, so that when only one call fits under the daily cap, it
  // is the first reader that gets it.
  const firstReading = readUploadPictureWithSpeedRule({
    timeoutMs,
    signal,
    onModelCall: () => {
      rateLimiter?.reserveModelCall();
    },
    onSlow,
    call: readWith(GEMINI_HYDROGEN_MODEL, false),
  });

  const stopSecondReader = new AbortController();
  let secondReaderCalls = 0;
  const secondReading = readUploadPictureWithSpeedRule({
    timeoutMs,
    signal: signal
      ? AbortSignal.any([signal, stopSecondReader.signal])
      : stopSecondReader.signal,
    onModelCall: () => {
      rateLimiter?.reserveModelCall();
      secondReaderCalls += 1;
    },
    onSlow,
    call: readWith(secondModel, true),
  }).then(
    (reading) => ({ ok: true as const, ...reading }),
    (error: unknown) => {
      if (!stopSecondReader.signal.aborted && !signal?.aborted) {
        logServerError("the second reading of an uploaded picture", error);
      }
      return { ok: false as const };
    },
  );

  let rawOutcome: Awaited<typeof firstReading>;
  try {
    rawOutcome = await firstReading;
  } catch (error) {
    stopSecondReader.abort();
    throw error;
  }

  // A picture that holds no statement needs no second opinion.
  if (!hasEnoughStatementRows(rawOutcome.rows)) {
    stopSecondReader.abort();
    if (cache) {
      cache.set(cacheKey, rawOutcome.rows);
    }
    const outcome: UploadReadingOutcome = {
      status: "no_statement",
      rows: rawOutcome.rows,
      rowCount: countNumberRowsInReading(rawOutcome.rows),
      fromCache: false,
      usedRepeat: rawOutcome.usedRepeat,
      modelCalls: rawOutcome.modelCalls + secondReaderCalls,
    };
    record.reading = outcome;
    onProgress?.({
      type: "bad_upload",
      fileName: record.fileName,
      rowCount: outcome.rowCount,
    });
    return outcome;
  }

  const second = await secondReading;
  const secondAnswered = second.ok && second.rows.length > 0;
  const merged = secondAnswered
    ? mergeReadings(rawOutcome.rows, second.rows)
    : { rows: rawOutcome.rows, disputedCount: 0 };

  // Only a reading with both readers is kept for other uploads of the same picture.
  if (cache && secondAnswered) {
    cache.set(cacheKey, merged.rows);
  }

  const result = buildUploadReadingResult(merged.rows, {
    fromCache: false,
    usedRepeat: rawOutcome.usedRepeat || (second.ok && second.usedRepeat),
    modelCalls: rawOutcome.modelCalls + secondReaderCalls,
    crossCheck: {
      answered: secondAnswered,
      disputedCount: merged.disputedCount,
    },
  });
  const outcome: UploadReadingOutcome = { status: "ok", result };
  record.reading = outcome;
  onProgress?.({ type: "done", result });
  return outcome;
}

/**
 * Parses a Hydrogen bounding box reply of four numbers (ymin, xmin, ymax, xmax)
 * on a 0..1000 normalized scale.
 */
export function parseCellBoxReply(raw: string): NormalizedCellBox | null {
  const matches = raw.match(/-?\d+(?:\.\d+)?/g);
  if (!matches || matches.length < 4) return null;

  const nums = matches.slice(0, 4).map((token) => Number(token));
  if (nums.some((n) => !Number.isFinite(n))) return null;

  const [ymin, xmin, ymax, xmax] = nums;
  if (
    ymin < 0 ||
    xmin < 0 ||
    ymax > 1000 ||
    xmax > 1000 ||
    ymax <= ymin ||
    xmax <= xmin
  ) {
    return null;
  }

  // Reject implausibly huge boxes (>40% of page height or >60% of page width).
  if (ymax - ymin > 400 || xmax - xmin > 600) {
    return null;
  }

  return { ymin, xmin, ymax, xmax };
}

function locateBoxWithSpeedRule(options: {
  call: (attempt: 1 | 2, signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onModelCall?: () => void;
}): Promise<{ box: NormalizedCellBox | null; modelCalls: number }> {
  const { call, timeoutMs, signal: outerSignal, onModelCall } = options;

  return new Promise((resolve, reject) => {
    if (outerSignal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let settled = false;
    let repeatStarted = false;
    let modelCalls = 0;
    let activeAttempts = 0;
    let firstTimer: ReturnType<typeof setTimeout> | null = null;
    let secondTimer: ReturnType<typeof setTimeout> | null = null;
    const controllers: AbortController[] = [];

    const cleanup = () => {
      if (firstTimer !== null) clearTimeout(firstTimer);
      if (secondTimer !== null) clearTimeout(secondTimer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
      for (const c of controllers) {
        if (!c.signal.aborted) c.abort();
      }
    };

    const finish = (box: NormalizedCellBox | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ box, modelCalls });
    };

    const onOuterAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    const startRepeat = () => {
      if (settled || repeatStarted) return;
      repeatStarted = true;
      secondTimer = setTimeout(() => finish(null), timeoutMs);
      startAttempt(2);
    };

    const startAttempt = (attempt: 1 | 2) => {
      try {
        onModelCall?.();
      } catch (error) {
        // The daily cap is reached: make no call.
        if (activeAttempts === 0 && !settled) {
          settled = true;
          cleanup();
          reject(error);
        }
        return;
      }
      const controller = new AbortController();
      controllers.push(controller);
      activeAttempts += 1;
      modelCalls += 1;

      void call(attempt, controller.signal)
        .then((raw) => {
          if (settled) return;
          const box = parseCellBoxReply(raw);
          if (box) {
            finish(box);
            return;
          }
          activeAttempts -= 1;
          if (!repeatStarted) {
            if (firstTimer !== null) clearTimeout(firstTimer);
            startRepeat();
          } else if (activeAttempts === 0) {
            finish(null);
          }
        })
        .catch(() => {
          if (settled) return;
          activeAttempts -= 1;
          if (!repeatStarted) {
            if (firstTimer !== null) clearTimeout(firstTimer);
            startRepeat();
          } else if (activeAttempts === 0) {
            finish(null);
          }
        });
    };

    firstTimer = setTimeout(() => startRepeat(), timeoutMs);
    startAttempt(1);
  });
}

/**
 * Draws either a solid black cover (hide) or a clean white patch with the new
 * number (change) directly onto the uploaded image at the located cell box.
 */
export async function drawModifiedUploadPicture(
  sourceBuffer: Buffer,
  box: NormalizedCellBox,
  modification: { kind: "hide" } | { kind: "change"; newValue: string },
): Promise<Buffer> {
  ensureStatementFonts();
  const image = await loadImage(sourceBuffer);
  const width = image.width;
  const height = image.height;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.lang = "en";
  ctx.drawImage(image, 0, 0, width, height);

  const rawX = Math.floor((box.xmin / 1000) * width);
  const rawY = Math.floor((box.ymin / 1000) * height);
  const rawRight = Math.ceil((box.xmax / 1000) * width);
  const rawBottom = Math.ceil((box.ymax / 1000) * height);

  const padX = Math.max(2, Math.round((rawRight - rawX) * 0.04));
  const padY = Math.max(2, Math.round((rawBottom - rawY) * 0.08));

  const x = Math.max(0, rawX - padX);
  const y = Math.max(0, rawY - padY);
  const boxW = Math.min(width - x, Math.max(16, rawRight - rawX + padX * 2));
  const boxH = Math.min(height - y, Math.max(14, rawBottom - rawY + padY * 2));

  if (modification.kind === "hide") {
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, y, boxW, boxH);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, boxW, boxH);

    // Pick a crisp font size that fits inside the cell box height and width.
    let fontSize = Math.max(12, Math.min(32, Math.round(boxH * 0.62)));
    ctx.font = `400 ${fontSize}px "${FONT_FAMILY}"`;
    const maxTextWidth = Math.max(12, boxW - 8);
    while (
      fontSize > 10 &&
      ctx.measureText(modification.newValue).width > maxTextWidth
    ) {
      fontSize -= 1;
      ctx.font = `400 ${fontSize}px "${FONT_FAMILY}"`;
    }

    ctx.fillStyle = "#111111";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(modification.newValue, x + boxW - 4, y + boxH / 2);
  }

  return canvas.toBuffer("image/png");
}

export type UploadModification =
  | { kind: "hide"; numberRowIndex: number; colIndex: 0 | 1 }
  | {
      kind: "change";
      numberRowIndex: number;
      colIndex: 0 | 1;
      newValue: string;
    };

export type ModifyUploadedPictureOptions = {
  record: UploadRecord;
  modification: UploadModification;
  rowLabel: string;
  printedValue: string;
  client: GeminiClient;
  cache?: ReadingCache;
  rateLimiter?: RateLimiter;
  browserId?: string;
  ip?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: ReadingProgressEvent) => void;
};

export async function modifyUploadedPicture(
  options: ModifyUploadedPictureOptions,
): Promise<{
  result: StatementReadingResult;
  modPictureKey: string;
  box: NormalizedCellBox;
}> {
  const {
    record,
    modification,
    rowLabel,
    printedValue,
    client,
    cache,
    rateLimiter,
    browserId = "anonymous",
    ip = "unknown",
    timeoutMs = getReadTimeoutMs(),
    signal,
    onProgress,
  } = options;

  const boxCacheKey = `${modification.numberRowIndex}:${modification.colIndex}`;
  let box = record.cellBoxes.get(boxCacheKey) ?? null;
  let totalModelCalls = 0;

  if (!box) {
    if (!client.locateCellBox) {
      throw new ReadingFailedError(
        "Could not locate that number on the uploaded picture.",
      );
    }

    if (rateLimiter) {
      const decision = rateLimiter.checkAndConsumeRequest({
        browserId,
        ip,
        plannedModelCalls: 1,
      });
      if (!decision.allowed) {
        throw new RateLimitError(
          decision.message,
          decision.reason,
          decision.retryAfterSeconds,
        );
      }
    }

    const locateRequest: LocateCellBoxRequest = {
      image: record.buffer,
      mimeType: record.mimeType,
      rowLabel,
      colIndex: modification.colIndex,
      printedValue,
      testContext: {
        uploadFileName: record.fileName,
        numberRowIndex: modification.numberRowIndex,
        colIndex: modification.colIndex,
      },
    };
    const locateFn = client.locateCellBox.bind(client);

    const located = await locateBoxWithSpeedRule({
      timeoutMs,
      signal,
      onModelCall: () => {
        rateLimiter?.reserveModelCall();
      },
      call: (_attempt, attemptSignal) =>
        locateFn({
          ...locateRequest,
          signal: attemptSignal,
        }),
    });

    totalModelCalls += located.modelCalls;
    if (!located.box) {
      throw new ReadingFailedError(
        "Could not locate that number on the uploaded picture.",
      );
    }

    box = located.box;
    record.cellBoxes.set(boxCacheKey, box);
  }

  const modPictureKey =
    modification.kind === "hide"
      ? `hide-${modification.numberRowIndex}-${modification.colIndex}`
      : `change-${modification.numberRowIndex}-${modification.colIndex}-${encodeURIComponent(modification.newValue)}`;

  let modifiedPng = record.modifiedPictures.get(modPictureKey);
  const keptBefore = modifiedPng !== undefined;
  if (!modifiedPng) {
    // Redrawing a large picture costs memory and time, so the limits are checked before
    // it is drawn. The redrawn picture is stored only after the limits have passed.
    if (rateLimiter) {
      const peek = rateLimiter.check({
        browserId,
        ip,
        plannedModelCalls: 1,
      });
      if (!peek.allowed) {
        throw new RateLimitError(
          peek.message,
          peek.reason,
          peek.retryAfterSeconds,
        );
      }
    }
    modifiedPng = await drawModifiedUploadPicture(
      record.buffer,
      box,
      modification.kind === "hide"
        ? { kind: "hide" }
        : { kind: "change", newValue: modification.newValue },
    );
  }
  const redrawnPicture = modifiedPng;
  const storeRedrawnPicture = () => {
    if (!record.addModifiedPicture(modPictureKey, redrawnPicture)) {
      throw new ReadingFailedError(
        "Could not keep the updated picture. Please upload the statement again.",
      );
    }
  };

  const readCacheKey = computePictureCacheKey([redrawnPicture]);
  const cachedRows = cache?.get(readCacheKey);
  if (cachedRows && cachedRows.length > 0) {
    storeRedrawnPicture();
    const result = buildUploadReadingResult(cachedRows, {
      fromCache: true,
      usedRepeat: false,
      modelCalls: totalModelCalls,
    });
    onProgress?.({ type: "done", result, modPictureKey });
    return { result, modPictureKey, box };
  }

  if (rateLimiter) {
    const decision = rateLimiter.checkAndConsumeRequest({
      browserId,
      ip,
      plannedModelCalls: 1,
    });
    if (!decision.allowed) {
      throw new RateLimitError(
        decision.message,
        decision.reason,
        decision.retryAfterSeconds,
      );
    }
  }
  storeRedrawnPicture();
  // A redraw that was never read back is not kept.
  const dropRedraw = () => {
    if (!keptBefore) record.modifiedPictures.delete(modPictureKey);
  };

  onProgress?.({ type: "started", totalNumbers: 0, totalStrips: 1 });

  let slowEmitted = false;
  const readOutcome = await readUploadPictureWithSpeedRule({
    timeoutMs,
    signal,
    onModelCall: () => {
      rateLimiter?.reserveModelCall();
    },
    onSlow: () => {
      if (!slowEmitted) {
        slowEmitted = true;
        onProgress?.({
          type: "slow",
          strip: 1,
          totalStrips: 1,
          timeoutMs,
        });
      }
    },
    call: (attempt, attemptSignal) =>
      client.readPicture({
        png: redrawnPicture,
        mimeType: "image/png",
        prompt: READING_PROMPT,
        signal: attemptSignal,
        testContext: {
          strip: 1,
          totalStrips: 1,
          attempt,
          timeoutMs,
          uploadFileName: record.fileName,
          uploadCoverNumberRow:
            modification.kind === "hide"
              ? {
                  numberRowIndex: modification.numberRowIndex,
                  colIndex: modification.colIndex,
                }
              : undefined,
          uploadOverrideNumberRow:
            modification.kind === "change"
              ? {
                  numberRowIndex: modification.numberRowIndex,
                  colIndex: modification.colIndex,
                  value: modification.newValue,
                }
              : undefined,
        },
      }),
  }).catch((error: unknown) => {
    dropRedraw();
    throw error;
  });

  totalModelCalls += readOutcome.modelCalls;

  if (readOutcome.rows.length === 0) {
    dropRedraw();
    throw new ReadingFailedError(
      "Could not read the updated balance sheet picture.",
    );
  }

  if (cache) {
    cache.set(readCacheKey, readOutcome.rows);
  }

  const result = buildUploadReadingResult(readOutcome.rows, {
    fromCache: false,
    usedRepeat: readOutcome.usedRepeat,
    modelCalls: totalModelCalls,
  });

  onProgress?.({ type: "done", result, modPictureKey });
  return { result, modPictureKey, box };
}
