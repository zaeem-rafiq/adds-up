import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import { describe, expect, test, vi } from "vitest";
import {
  createFakeGeminiClient,
  READING_PROMPT,
  type GeminiClient,
} from "@/lib/gemini";
import { RateLimiter, RateLimitError } from "@/lib/rate-limit";
import {
  ReadingCache,
  ReadingFailedError,
  ReadingTimeoutError,
  type ReadingProgressEvent,
} from "@/lib/reading";
import {
  drawModifiedUploadPicture,
  modifyUploadedPicture,
  parseCellBoxReply,
  readUploadedPicture,
  UPLOAD_TTL_MS,
  UploadStore,
  validateUploadBuffer,
} from "@/lib/uploads";
import {
  countNumberRowsInReading,
  hasEnoughStatementRows,
  MAX_UPLOAD_BYTES,
  PDF_REFUSAL_MESSAGE,
  validateUploadFileMeta,
} from "@/lib/upload-validation";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF_HEADER = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "ascii");

async function loadFixturePng(name: string): Promise<Buffer> {
  return readFile(path.join(process.cwd(), "src/fixtures/uploads", name));
}

describe("upload validation checks", () => {
  test("accepts PNG and JPEG pictures under 8 MB", () => {
    const pngMeta = validateUploadFileMeta({
      name: "statement-apple.png",
      type: "image/png",
      size: 50_000,
    });
    expect(pngMeta).toEqual({
      ok: true,
      mimeType: "image/png",
      fileName: "statement-apple.png",
    });

    const jpgMeta = validateUploadFileMeta({
      name: "balance-sheet.jpg",
      type: "image/jpeg",
      size: 120_000,
    });
    expect(jpgMeta).toEqual({
      ok: true,
      mimeType: "image/jpeg",
      fileName: "balance-sheet.jpg",
    });

    const pngBuf = validateUploadBuffer(PNG_HEADER, {
      name: "statement.png",
      type: "image/png",
    });
    expect(pngBuf).toEqual({
      ok: true,
      mimeType: "image/png",
      fileName: "statement.png",
    });

    const jpgBuf = validateUploadBuffer(JPEG_HEADER, {
      name: "statement.jpeg",
      type: "image/jpeg",
    });
    expect(jpgBuf).toEqual({
      ok: true,
      mimeType: "image/jpeg",
      fileName: "statement.jpeg",
    });
  });

  test("refuses PDF files with the exact plain message", () => {
    const byExt = validateUploadFileMeta({
      name: "statement-page-3.pdf",
      type: "",
      size: 20_000,
    });
    expect(byExt).toEqual({
      ok: false,
      code: "pdf",
      message: PDF_REFUSAL_MESSAGE,
    });

    const byMime = validateUploadFileMeta({
      name: "report",
      type: "application/pdf",
      size: 20_000,
    });
    expect(byMime).toEqual({
      ok: false,
      code: "pdf",
      message: PDF_REFUSAL_MESSAGE,
    });

    // Even a PDF disguised with a .png name is refused by magic bytes.
    const byMagic = validateUploadBuffer(PDF_HEADER, {
      name: "disguised.png",
      type: "image/png",
    });
    expect(byMagic).toEqual({
      ok: false,
      code: "pdf",
      message: PDF_REFUSAL_MESSAGE,
    });
  });

  test("refuses files larger than 8 MB", () => {
    const tooLargeMeta = validateUploadFileMeta({
      name: "huge.png",
      type: "image/png",
      size: MAX_UPLOAD_BYTES + 1,
    });
    expect(tooLargeMeta.ok).toBe(false);
    if (!tooLargeMeta.ok) {
      expect(tooLargeMeta.code).toBe("too_large");
      expect(tooLargeMeta.message).toMatch(/8 MB/i);
    }

    const tooLargeBuf = validateUploadBuffer(PNG_HEADER, {
      name: "huge.png",
      type: "image/png",
      size: MAX_UPLOAD_BYTES + 100,
    });
    expect(tooLargeBuf.ok).toBe(false);
    if (!tooLargeBuf.ok) {
      expect(tooLargeBuf.code).toBe("too_large");
    }
  });

  test("refuses empty files and unsupported file types", () => {
    const empty = validateUploadFileMeta({
      name: "empty.png",
      type: "image/png",
      size: 0,
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe("empty");

    const gif = validateUploadFileMeta({
      name: "anim.gif",
      type: "image/gif",
      size: 4_000,
    });
    expect(gif.ok).toBe(false);
    if (!gif.ok) expect(gif.code).toBe("unsupported_type");

    const txt = validateUploadFileMeta({
      name: "notes.txt",
      type: "text/plain",
      size: 100,
    });
    expect(txt.ok).toBe(false);
    if (!txt.ok) expect(txt.code).toBe("unsupported_type");

    const spoofedPng = validateUploadBuffer(
      Buffer.from("not actually a png", "utf-8"),
      { name: "fake.png", type: "image/png" },
    );
    expect(spoofedPng.ok).toBe(false);
    if (!spoofedPng.ok) expect(spoofedPng.code).toBe("unsupported_type");
  });

  test("requires at least three number rows to count as a statement", () => {
    const twoRows = [
      {
        label: "Cash",
        cells: [
          { raw: "100", number: 100, hidden: false },
          { raw: "90", number: 90, hidden: false },
        ] as [
          { raw: string; number: number | null; hidden: boolean },
          { raw: string; number: number | null; hidden: boolean },
        ],
      },
      {
        label: "Total",
        cells: [
          { raw: "100", number: 100, hidden: false },
          { raw: "90", number: 90, hidden: false },
        ] as [
          { raw: string; number: number | null; hidden: boolean },
          { raw: string; number: number | null; hidden: boolean },
        ],
      },
    ];
    expect(countNumberRowsInReading(twoRows)).toBe(2);
    expect(hasEnoughStatementRows(twoRows)).toBe(false);

    const threeRows = [
      ...twoRows,
      {
        label: "Other",
        cells: [
          { raw: "50", number: 50, hidden: false },
          { raw: "", number: null, hidden: false },
        ] as [
          { raw: string; number: number | null; hidden: boolean },
          { raw: string; number: number | null; hidden: boolean },
        ],
      },
    ];
    expect(countNumberRowsInReading(threeRows)).toBe(3);
    expect(hasEnoughStatementRows(threeRows)).toBe(true);
  });
});

describe("UploadStore in-memory lifecycle", () => {
  test("stores uploaded picture and reading under a random id and expires after one hour", () => {
    let now = 1_700_000_000_000;
    const store = new UploadStore({ now: () => now });

    const first = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });
    const second = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });

    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThanOrEqual(16);
    expect(store.get(first.id)?.fileName).toBe("statement-apple.png");
    expect(store.get(first.id)?.buffer.equals(PNG_HEADER)).toBe(true);

    // Still available at 59 minutes.
    now += UPLOAD_TTL_MS - 60_000;
    expect(store.get(first.id)).toBeDefined();

    // Expired at 1 hour and removed from memory.
    now += 60_000;
    expect(store.get(first.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test("evicts oldest upload when maxEntries is exceeded", () => {
    const store = new UploadStore({ maxEntries: 2 });
    const a = store.create({
      fileName: "a.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });
    const b = store.create({
      fileName: "b.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });
    const c = store.create({
      fileName: "c.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });

    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(b.id)).toBeDefined();
    expect(store.get(c.id)).toBeDefined();
    expect(store.size).toBe(2);
  });
});

describe("readUploadedPicture", () => {
  test("reads statement-* fixture in test mode as Apple rows and caches repeat reads", async () => {
    const png = await loadFixturePng("statement-apple.png");
    const store = new UploadStore();
    const record = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: png,
    });

    const client = createFakeGeminiClient();
    const readSpy = vi.spyOn(client, "readPicture");
    const cache = new ReadingCache();
    const rateLimiter = new RateLimiter();
    const events: ReadingProgressEvent[] = [];

    const first = await readUploadedPicture({
      record,
      client,
      cache,
      rateLimiter,
      browserId: "browser-1",
      ip: "127.0.0.1",
      onProgress: (ev) => events.push(ev),
    });

    expect(first.status).toBe("ok");
    if (first.status === "ok") {
      expect(first.result.rows).toHaveLength(13);
      expect(first.result.comparison.rows).toEqual([]);
      expect(first.result.comparison.matchCount).toBe(0);
      expect(first.result.modelCalls).toBe(1);
    }
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy.mock.calls[0][0].prompt).toBe(READING_PROMPT);
    expect(readSpy.mock.calls[0][0].mimeType).toBe("image/png");
    expect(events.some((e) => e.type === "done")).toBe(true);

    // Second reading of a fresh record with identical bytes uses cache with 0 model calls.
    const record2 = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: png,
    });
    const second = await readUploadedPicture({
      record: record2,
      client,
      cache,
      rateLimiter,
      browserId: "browser-1",
      ip: "127.0.0.1",
    });

    expect(second.status).toBe("ok");
    if (second.status === "ok") {
      expect(second.result.fromCache).toBe(true);
      expect(second.result.modelCalls).toBe(0);
    }
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  test("returns no_statement for holiday-* fixture and when fewer than 3 number rows are returned", async () => {
    const holidayPng = await loadFixturePng("holiday-photo.png");
    const store = new UploadStore();
    const record = store.create({
      fileName: "holiday-photo.png",
      mimeType: "image/png",
      buffer: holidayPng,
    });
    const events: ReadingProgressEvent[] = [];

    const outcome = await readUploadedPicture({
      record,
      client: createFakeGeminiClient(),
      onProgress: (ev) => events.push(ev),
    });

    expect(outcome.status).toBe("no_statement");
    if (outcome.status === "no_statement") {
      expect(outcome.rowCount).toBe(0);
    }
    expect(events.some((e) => e.type === "bad_upload")).toBe(true);

    // Also returns no_statement when model returns only 2 number rows.
    const twoRowClient: GeminiClient = {
      isFake: true,
      async readPicture() {
        return "Cash | 100 | 90\nTotal | 100 | 90";
      },
    };
    const twoRowRecord = store.create({
      fileName: "two-rows.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });
    const twoRowOutcome = await readUploadedPicture({
      record: twoRowRecord,
      client: twoRowClient,
    });
    expect(twoRowOutcome.status).toBe("no_statement");
    if (twoRowOutcome.status === "no_statement") {
      expect(twoRowOutcome.rowCount).toBe(2);
    }
  });

  test("enforces rate limits and rejects without a model call when exceeded", async () => {
    const store = new UploadStore();
    const record = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });
    const client = createFakeGeminiClient();
    const spy = vi.spyOn(client, "readPicture");
    const limiter = new RateLimiter({ limits: { browserPerHour: 1 } });
    limiter.recordRequest({ browserId: "b1", ip: "1.2.3.4" });

    await expect(
      readUploadedPicture({
        record,
        client,
        rateLimiter: limiter,
        browserId: "b1",
        ip: "1.2.3.4",
      }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(spy).not.toHaveBeenCalled();
  });

  test("repeats once after timeout and throws ReadingTimeoutError if both time out", async () => {
    const store = new UploadStore();
    const record = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });
    const events: ReadingProgressEvent[] = [];
    let calls = 0;

    const hangingClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        calls += 1;
        return new Promise((_resolve, reject) => {
          req.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      },
    };

    await expect(
      readUploadedPicture({
        record,
        client: hangingClient,
        timeoutMs: 30,
        onProgress: (e) => events.push(e),
      }),
    ).rejects.toBeInstanceOf(ReadingTimeoutError);

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "slow")).toBe(true);
  });

  test("repeats once on error and throws ReadingFailedError when both attempts fail", async () => {
    const store = new UploadStore();
    const record = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: PNG_HEADER,
    });
    let calls = 0;
    const failingClient: GeminiClient = {
      isFake: true,
      async readPicture() {
        calls += 1;
        throw new Error("Upstream model error");
      },
    };

    await expect(
      readUploadedPicture({
        record,
        client: failingClient,
        timeoutMs: 200,
      }),
    ).rejects.toBeInstanceOf(ReadingFailedError);

    expect(calls).toBe(2);
  });
});

describe("upload hide and change with cell box location", () => {
  test("parseCellBoxReply accepts valid four-number boxes and rejects invalid replies", () => {
    expect(parseCellBoxReply("420, 560, 460, 720")).toEqual({
      ymin: 420,
      xmin: 560,
      ymax: 460,
      xmax: 720,
    });
    expect(parseCellBoxReply("[100, 200, 150, 350]")).toEqual({
      ymin: 100,
      xmin: 200,
      ymax: 150,
      xmax: 350,
    });
    expect(parseCellBoxReply("no box here")).toBeNull();
    expect(parseCellBoxReply("500, 200, 400, 300")).toBeNull(); // ymin >= ymax
    expect(parseCellBoxReply("0, 0, 900, 900")).toBeNull(); // implausibly huge
  });

  test("drawModifiedUploadPicture draws a black box for hide and text for change", async () => {
    const png = await loadFixturePng("statement-apple.png");
    const box = { ymin: 400, xmin: 550, ymax: 440, xmax: 700 };

    const hiddenPng = await drawModifiedUploadPicture(png, box, {
      kind: "hide",
    });
    const img = await loadImage(hiddenPng);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const centerX = Math.round(((box.xmin + box.xmax) / 2000) * img.width);
    const centerY = Math.round(((box.ymin + box.ymax) / 2000) * img.height);
    const pixel = ctx.getImageData(centerX, centerY, 1, 1).data;
    // Solid black cover at the box center.
    expect(pixel[0]).toBe(0);
    expect(pixel[1]).toBe(0);
    expect(pixel[2]).toBe(0);

    const changedPng = await drawModifiedUploadPicture(png, box, {
      kind: "change",
      newValue: "15,541",
    });
    expect(changedPng.length).toBeGreaterThan(1000);
  });

  test("modifyUploadedPicture locates the cell box once, draws the cover, and re-reads", async () => {
    const png = await loadFixturePng("statement-apple.png");
    const store = new UploadStore();
    const record = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: png,
    });

    const client = createFakeGeminiClient();
    const locateSpy = vi.spyOn(client, "locateCellBox");
    const readSpy = vi.spyOn(client, "readPicture");

    const hideOutcome = await modifyUploadedPicture({
      record,
      modification: { kind: "hide", numberRowIndex: 4, colIndex: 0 },
      rowLabel: "Inventories",
      printedValue: "14,541",
      client,
      cache: new ReadingCache(),
      rateLimiter: new RateLimiter(),
    });

    expect(locateSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(hideOutcome.result.rows[4].cells[0].hidden).toBe(true);
    expect(record.modifiedPictures.has(hideOutcome.modPictureKey)).toBe(true);

    // Changing the same cell reuses the cached cell box (no second locate call).
    const changeOutcome = await modifyUploadedPicture({
      record,
      modification: {
        kind: "change",
        numberRowIndex: 4,
        colIndex: 0,
        newValue: "15,541",
      },
      rowLabel: "Inventories",
      printedValue: "14,541",
      client,
      cache: new ReadingCache(),
      rateLimiter: new RateLimiter(),
    });

    expect(locateSpy).toHaveBeenCalledTimes(1);
    expect(changeOutcome.result.rows[4].cells[0].number).toBe(15541);
  });
});
