import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  createFakeGeminiClient,
  GEMINI_HYDROGEN_MODEL,
  type GeminiClient,
} from "@/lib/gemini";
import { RateLimiter, RateLimitError } from "@/lib/rate-limit";
import { ReadingCache, ReadingFailedError } from "@/lib/reading";
import { readUploadedPicture, UploadStore } from "@/lib/uploads";

const IDENTITY = { browserId: "two-readers-browser-1", ip: "203.0.113.77" };

afterEach(() => {
  vi.unstubAllEnvs();
});

async function uploadRecord(fileName = "statement-apple.png") {
  const png = await readFile(
    path.join(process.cwd(), "src/fixtures/uploads/statement-apple.png"),
  );
  const store = new UploadStore();
  return store.create({ fileName, mimeType: "image/png", buffer: png });
}

test("an upload is read by two models, and the two calls count against the daily cap", async () => {
  vi.stubEnv("SECOND_READER_MODEL", "");
  const record = await uploadRecord();
  const client = createFakeGeminiClient();
  const readSpy = vi.spyOn(client, "readPicture");
  const limiter = new RateLimiter();

  const outcome = await readUploadedPicture({
    record,
    client,
    rateLimiter: limiter,
    ...IDENTITY,
  });

  expect(readSpy).toHaveBeenCalledTimes(2);
  const models = readSpy.mock.calls.map((call) => call[0].model);
  expect(models).toEqual([GEMINI_HYDROGEN_MODEL, "gemini-4-carbon"]);
  const [firstCall, secondCall] = readSpy.mock.calls.map((call) => call[0]);
  expect(secondCall.prompt).toBe(firstCall.prompt);
  expect(secondCall.png).toBe(firstCall.png);
  expect(limiter.getCounts(IDENTITY).dailyModelCalls).toBe(2);
  expect(outcome.status).toBe("ok");
  if (outcome.status === "ok") {
    expect(outcome.result.modelCalls).toBe(2);
    expect(outcome.result.crossCheck).toEqual({ answered: true, disputedCount: 0 });
    expect(outcome.result.rows).toHaveLength(13);
  }
});

test("the second reader's model comes from the server setting SECOND_READER_MODEL", async () => {
  vi.stubEnv("SECOND_READER_MODEL", "gemini-4-neon");
  const record = await uploadRecord();
  const client = createFakeGeminiClient();
  const readSpy = vi.spyOn(client, "readPicture");
  await readUploadedPicture({ record, client });
  expect(readSpy.mock.calls.map((call) => call[0].model)).toEqual([
    GEMINI_HYDROGEN_MODEL,
    "gemini-4-neon",
  ]);
});

test("a number the two readers differ on comes back NOT READ with both raw texts", async () => {
  const record = await uploadRecord("dispute-apple.png");
  const outcome = await readUploadedPicture({
    record,
    client: createFakeGeminiClient(),
  });
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") return;
  expect(outcome.result.crossCheck).toEqual({ answered: true, disputedCount: 1 });
  const disputed = outcome.result.rows.flatMap((row) =>
    row.cells.filter((cell) => cell.disputed),
  );
  expect(disputed).toHaveLength(1);
  expect(disputed[0].number).toBeNull();
  expect(disputed[0].disputed?.first).toMatch(/\d/);
  expect(disputed[0].disputed?.second).not.toBe(disputed[0].disputed?.first);
});

test("when the second reader fails twice the first reading stands alone and the upload does not fail", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const record = await uploadRecord();
  const base = createFakeGeminiClient();
  let secondCalls = 0;
  const client: GeminiClient = {
    isFake: true,
    async readPicture(request) {
      if (request.model === GEMINI_HYDROGEN_MODEL) return base.readPicture(request);
      secondCalls += 1;
      throw new Error("second model is down");
    },
  };
  const limiter = new RateLimiter();
  const cache = new ReadingCache();

  const outcome = await readUploadedPicture({
    record,
    client,
    cache,
    rateLimiter: limiter,
    timeoutMs: 200,
    ...IDENTITY,
  });

  expect(secondCalls).toBe(2);
  expect(outcome.status).toBe("ok");
  if (outcome.status === "ok") {
    expect(outcome.result.crossCheck).toEqual({ answered: false, disputedCount: 0 });
    expect(outcome.result.rows.flatMap((r) => r.cells).some((c) => c.disputed)).toBe(false);
    expect(outcome.result.modelCalls).toBe(3);
  }
  expect(limiter.getCounts(IDENTITY).dailyModelCalls).toBe(3);
  // A reading that rests on one reader is not kept for other uploads of the same picture.
  expect(cache.size).toBe(0);
});

test("when the second reader returns no rows the first reading stands alone", async () => {
  const record = await uploadRecord();
  const base = createFakeGeminiClient();
  const client: GeminiClient = {
    isFake: true,
    async readPicture(request) {
      return request.model === GEMINI_HYDROGEN_MODEL
        ? base.readPicture(request)
        : "";
    },
  };
  const outcome = await readUploadedPicture({ record, client, timeoutMs: 200 });
  expect(outcome.status).toBe("ok");
  if (outcome.status === "ok") {
    expect(outcome.result.crossCheck?.answered).toBe(false);
    expect(outcome.result.rows).toHaveLength(13);
  }
});

test("when the first reader fails the upload fails, and the daily cap leaves the second reader out only", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const base = createFakeGeminiClient();
  const failFirst: GeminiClient = {
    isFake: true,
    async readPicture(request) {
      if (request.model === GEMINI_HYDROGEN_MODEL) throw new Error("down");
      return base.readPicture(request);
    },
  };
  await expect(
    readUploadedPicture({
      record: await uploadRecord(),
      client: failFirst,
      timeoutMs: 200,
    }),
  ).rejects.toBeInstanceOf(ReadingFailedError);

  // Room for exactly one call: the first reader gets it, the second reader is refused.
  const oneCall = new RateLimiter({ limits: { globalModelCallsPerDay: 1 } });
  const outcome = await readUploadedPicture({
    record: await uploadRecord(),
    client: createFakeGeminiClient(),
    rateLimiter: oneCall,
    ...IDENTITY,
  });
  expect(outcome.status).toBe("ok");
  if (outcome.status === "ok") {
    expect(outcome.result.crossCheck?.answered).toBe(false);
  }
  expect(oneCall.getCounts(IDENTITY).dailyModelCalls).toBe(1);

  const exhausted = new RateLimiter({ limits: { globalModelCallsPerDay: 1 } });
  exhausted.recordModelCalls(1);
  await expect(
    readUploadedPicture({
      record: await uploadRecord(),
      client: createFakeGeminiClient(),
      rateLimiter: exhausted,
      ...IDENTITY,
    }),
  ).rejects.toBeInstanceOf(RateLimitError);
});
