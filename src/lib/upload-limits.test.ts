import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createFakeGeminiClient, type GeminiClient } from "@/lib/gemini";
import { RateLimiter } from "@/lib/rate-limit";
import { ReadingCache, ReadingFailedError } from "@/lib/reading";
import { jpegWithSize, PNG_SIGNATURE, pngWithSize } from "@/lib/upload-test-pictures";
import {
  MAX_UPLOAD_STORE_BYTES,
  modifyUploadedPicture,
  UploadStore,
  UploadStoreFullError,
} from "@/lib/uploads";
import {
  checkUploadImageSize,
  DIMENSION_REFUSAL_MESSAGE,
  MAX_UPLOAD_DIMENSION,
  readImageSize,
  UNREADABLE_PICTURE_MESSAGE,
} from "@/lib/upload-validation";

const PNG_HEADER = Buffer.concat([PNG_SIGNATURE, Buffer.from([0, 0, 0, 13])]);

async function fixture(name: string): Promise<Buffer> {
  return readFile(path.join(process.cwd(), "src/fixtures/uploads", name));
}

describe("Picture size is read from the header bytes", () => {
  test("reads a real PNG file", async () => {
    expect(readImageSize(await fixture("statement-apple.png"), "image/png")).toEqual({
      width: 1200,
      height: 1012,
    });
    expect(readImageSize(await fixture("holiday-photo.png"), "image/png")).toEqual({
      width: 420,
      height: 260,
    });
  });

  test("reads JPEG pictures, including progressive ones and ones with an EXIF block before the frame", () => {
    expect(readImageSize(jpegWithSize(800, 600), "image/jpeg")).toEqual({
      width: 800,
      height: 600,
    });
    expect(readImageSize(jpegWithSize(800, 600, 0xc2), "image/jpeg")).toEqual({
      width: 800,
      height: 600,
    });
    // An EXIF block holds its own small picture. Its size must not be mistaken for ours.
    const thumbnail = jpegWithSize(160, 120);
    const exifHeader = Buffer.from([0xff, 0xe1, 0, 0]);
    exifHeader.writeUInt16BE(thumbnail.length + 2, 2);
    const exif = Buffer.concat([exifHeader, thumbnail]);
    expect(readImageSize(jpegWithSize(5000, 4000, 0xc0, [exif]), "image/jpeg")).toEqual({
      width: 5000,
      height: 4000,
    });
  });

  test("gives no size for a header that is cut short or broken", () => {
    expect(readImageSize(PNG_HEADER, "image/png")).toBeNull();
    expect(readImageSize(PNG_SIGNATURE, "image/png")).toBeNull();
    expect(
      readImageSize(
        Buffer.concat([PNG_SIGNATURE, Buffer.from("00000000WRONG0000000000000000", "ascii")]),
        "image/png",
      ),
    ).toBeNull();
    expect(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), "image/jpeg")).toBeNull();
    expect(readImageSize(jpegWithSize(10, 10).subarray(0, 24), "image/jpeg")).toBeNull();
  });

  test("accepts 6,000 pixels and refuses more, wide or tall, with a plain message", () => {
    expect(MAX_UPLOAD_DIMENSION).toBe(6000);
    expect(checkUploadImageSize(pngWithSize(6000, 6000), "image/png")).toEqual({ ok: true });
    expect(checkUploadImageSize(jpegWithSize(6000, 1), "image/jpeg")).toEqual({ ok: true });

    for (const picture of [pngWithSize(6001, 10), pngWithSize(10, 6001)]) {
      expect(checkUploadImageSize(picture, "image/png")).toEqual({
        ok: false,
        code: "dimensions",
        message: DIMENSION_REFUSAL_MESSAGE,
      });
    }
    expect(checkUploadImageSize(jpegWithSize(7000, 100), "image/jpeg")).toMatchObject({
      ok: false,
      code: "dimensions",
    });
    expect(DIMENSION_REFUSAL_MESSAGE).toContain("6,000 pixels");
  });

  test("refuses a picture whose size cannot be read, or is zero", () => {
    expect(checkUploadImageSize(PNG_HEADER, "image/png")).toEqual({
      ok: false,
      code: "unreadable",
      message: UNREADABLE_PICTURE_MESSAGE,
    });
    expect(checkUploadImageSize(pngWithSize(0, 10), "image/png")).toMatchObject({
      ok: false,
      code: "unreadable",
    });
  });
});

function buffer(size: number, fill = 1): Buffer {
  return Buffer.alloc(size, fill);
}

describe("The upload store holds at most 150 MB in total, oldest first", () => {
  test("the default cap is 150 MB", () => {
    expect(MAX_UPLOAD_STORE_BYTES).toBe(150 * 1024 * 1024);
  });

  test("evicts the oldest uploads first when the total bytes would pass the cap", () => {
    const store = new UploadStore({ maxBytes: 100, maxEntries: 50 });
    const a = store.create({ fileName: "a.png", mimeType: "image/png", buffer: buffer(40) });
    const b = store.create({ fileName: "b.png", mimeType: "image/png", buffer: buffer(40) });
    expect(store.totalBytes).toBe(80);

    const c = store.create({ fileName: "c.png", mimeType: "image/png", buffer: buffer(40) });
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(b.id)).toBeDefined();
    expect(store.get(c.id)).toBeDefined();
    expect(store.totalBytes).toBe(80);

    // One large picture pushes out as many old ones as it needs to.
    const d = store.create({ fileName: "d.png", mimeType: "image/png", buffer: buffer(90) });
    expect(store.get(b.id)).toBeUndefined();
    expect(store.get(c.id)).toBeUndefined();
    expect(store.get(d.id)).toBeDefined();
    expect(store.totalBytes).toBe(90);
  });

  test("refuses a picture that is bigger than the whole store", () => {
    const store = new UploadStore({ maxBytes: 100 });
    expect(() =>
      store.create({ fileName: "big.png", mimeType: "image/png", buffer: buffer(101) }),
    ).toThrow(UploadStoreFullError);
    expect(store.size).toBe(0);
  });

  test("counts every redrawn picture against the cap", () => {
    const store = new UploadStore({ maxBytes: 100 });
    const record = store.create({ fileName: "a.png", mimeType: "image/png", buffer: buffer(30) });
    expect(record.addModifiedPicture("hide-1-0", buffer(20))).toBe(true);
    expect(store.totalBytes).toBe(50);
    expect(record.modifiedPictures.get("hide-1-0")?.length).toBe(20);
  });

  test("a stream of redraws drops that upload's own older redraws before it touches other uploads", () => {
    const store = new UploadStore({ maxBytes: 100 });
    const other = store.create({ fileName: "other.png", mimeType: "image/png", buffer: buffer(30) });
    const mine = store.create({ fileName: "mine.png", mimeType: "image/png", buffer: buffer(30) });

    expect(mine.addModifiedPicture("one", buffer(20))).toBe(true);
    expect(mine.addModifiedPicture("two", buffer(20))).toBe(true);
    // 30 + 30 + 20 + 20 = 100. The next redraw needs room.
    expect(mine.addModifiedPicture("three", buffer(20))).toBe(true);
    expect(mine.modifiedPictures.has("one")).toBe(false);
    expect(mine.modifiedPictures.has("two")).toBe(true);
    expect(mine.modifiedPictures.has("three")).toBe(true);
    expect(store.get(other.id)).toBeDefined();
    expect(store.totalBytes).toBeLessThanOrEqual(100);
  });

  test("when its own redraws are not enough, the oldest other upload goes, never the upload being changed", () => {
    const store = new UploadStore({ maxBytes: 100 });
    const oldest = store.create({ fileName: "oldest.png", mimeType: "image/png", buffer: buffer(40) });
    const mine = store.create({ fileName: "mine.png", mimeType: "image/png", buffer: buffer(40) });

    expect(mine.addModifiedPicture("one", buffer(30))).toBe(true);
    expect(store.get(oldest.id)).toBeUndefined();
    expect(store.get(mine.id)).toBe(mine);
    expect(mine.modifiedPictures.has("one")).toBe(true);
    expect(store.totalBytes).toBe(70);
  });

  test("refuses a redraw that cannot fit even alone, and a redraw for an upload that is gone", () => {
    const store = new UploadStore({ maxBytes: 100 });
    const record = store.create({ fileName: "a.png", mimeType: "image/png", buffer: buffer(60) });
    expect(record.addModifiedPicture("too-big", buffer(41))).toBe(false);
    expect(record.modifiedPictures.size).toBe(0);

    store.delete(record.id);
    expect(record.addModifiedPicture("late", buffer(1))).toBe(false);
    expect(record.modifiedPictures.size).toBe(0);
  });

  test("an expired upload takes no room and cannot be added to", () => {
    let now = 1_700_000_000_000;
    const store = new UploadStore({ maxBytes: 100, ttlMs: 1_000, now: () => now });
    const record = store.create({ fileName: "a.png", mimeType: "image/png", buffer: buffer(60) });
    now += 1_001;
    expect(record.addModifiedPicture("late", buffer(1))).toBe(false);
    expect(store.totalBytes).toBe(0);
  });
});

describe("An upload can be read only with the id it was given", () => {
  test("ids are random version 4 UUIDs, never repeat, and are not found by a near miss", () => {
    const store = new UploadStore();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(
        store.create({ fileName: "a.png", mimeType: "image/png", buffer: PNG_HEADER }).id,
      );
    }
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }

    const [first] = [...ids];
    expect(store.get(first)).toBeDefined();
    expect(store.get(first.toUpperCase())).toBeUndefined();
    expect(store.get(first.slice(0, -1))).toBeUndefined();
    expect(store.get(`${first}0`)).toBeUndefined();
    expect(store.get(first.slice(0, 8))).toBeUndefined();
    expect(store.get("")).toBeUndefined();
    expect(store.get("*")).toBeUndefined();
    expect(store.get("__proto__")).toBeUndefined();
  });

  test("an id from one store opens nothing in another", () => {
    const one = new UploadStore();
    const two = new UploadStore();
    const record = one.create({ fileName: "a.png", mimeType: "image/png", buffer: PNG_HEADER });
    expect(two.get(record.id)).toBeUndefined();
  });
});

describe("A redrawn picture is stored only after the limit checks pass", () => {
  async function statementUpload() {
    const png = await fixture("statement-apple.png");
    const store = new UploadStore();
    const record = store.create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: png,
    });
    return { store, record };
  }

  const identity = { browserId: "upload-limit-browser-1", ip: "203.0.113.210" };

  test("a refused request keeps nothing, and an allowed one keeps the picture in the byte count", async () => {
    const { store, record } = await statementUpload();
    const bytesBefore = store.totalBytes;
    const modification = { kind: "hide" as const, numberRowIndex: 4, colIndex: 0 as const };
    const args = {
      record,
      modification,
      rowLabel: "Inventories",
      printedValue: "14,541",
      client: createFakeGeminiClient(),
      cache: new ReadingCache(),
      ...identity,
    };

    const refusing = new RateLimiter({ limits: { globalModelCallsPerDay: 1 } });
    refusing.recordModelCalls(1);
    await expect(
      modifyUploadedPicture({ ...args, rateLimiter: refusing }),
    ).rejects.toThrow();
    expect(record.modifiedPictures.size).toBe(0);
    expect(store.totalBytes).toBe(bytesBefore);

    const outcome = await modifyUploadedPicture({
      ...args,
      rateLimiter: new RateLimiter(),
    });
    const kept = record.modifiedPictures.get(outcome.modPictureKey);
    expect(kept).toBeDefined();
    expect(store.totalBytes).toBe(bytesBefore + (kept?.length ?? 0));
  });

  test("a redraw whose reading fails is not kept", async () => {
    const { store, record } = await statementUpload();
    const bytesBefore = store.totalBytes;
    const emptyClient: GeminiClient = {
      ...createFakeGeminiClient(),
      isFake: true,
      async readPicture() {
        return "";
      },
    };
    await expect(
      modifyUploadedPicture({
        record,
        modification: { kind: "hide", numberRowIndex: 4, colIndex: 0 },
        rowLabel: "Inventories",
        printedValue: "14,541",
        client: { ...emptyClient, locateCellBox: createFakeGeminiClient().locateCellBox },
        rateLimiter: new RateLimiter(),
        timeoutMs: 200,
        ...identity,
      }),
    ).rejects.toBeInstanceOf(ReadingFailedError);
    expect(record.modifiedPictures.size).toBe(0);
    expect(store.totalBytes).toBe(bytesBefore);
  });
});
