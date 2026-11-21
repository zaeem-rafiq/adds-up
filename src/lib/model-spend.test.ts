import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import appleFixture from "@/fixtures/apple-statement.json";
import {
  createFakeGeminiClient,
  type GeminiClient,
} from "@/lib/gemini";
import { MODEL_FAILED_MESSAGE } from "@/lib/public-errors";
import { RateLimiter, RateLimitError } from "@/lib/rate-limit";
import {
  explainMismatchCause,
  ReadingCache,
  ReadingFailedError,
  readStatementPictures,
  readStatementWithModification,
  type ReadRow,
} from "@/lib/reading";
import { formatStatementRowsAsReplyForTest } from "@/lib/reading-test-helpers";
import { recheckNumbers } from "@/lib/second-reader";
import type { Statement } from "@/lib/statements";
import {
  modifyUploadedPicture,
  readUploadedPicture,
  UploadStore,
} from "@/lib/uploads";

const APPLE = appleFixture as unknown as Statement;
const CLEAN_ROWS = formatStatementRowsAsReplyForTest(APPLE.rows);

const IDENTITY = { browserId: "spend-test-browser-1", ip: "203.0.113.200" };

/** A limiter whose daily cap of model calls is already used up. */
function exhaustedLimiter(): RateLimiter {
  const limiter = new RateLimiter({ limits: { globalModelCallsPerDay: 1 } });
  limiter.recordModelCalls(1);
  return limiter;
}

function countingClient() {
  const base = createFakeGeminiClient();
  const spies = {
    readPicture: vi.spyOn(base, "readPicture"),
    locateCellBox: vi.spyOn(base, "locateCellBox"),
    explainCause: vi.spyOn(base, "explainCause"),
    decideQuestions: vi.spyOn(base, "decideQuestions"),
  };
  return { client: base, spies };
}

async function uploadRecord() {
  const png = await readFile(
    path.join(process.cwd(), "src/fixtures/uploads/statement-apple.png"),
  );
  const store = new UploadStore();
  const record = store.create({
    fileName: "statement-apple.png",
    mimeType: "image/png",
    buffer: png,
  });
  return { store, record };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("The daily cap on model calls is checked before the call, on every path that can reach a model", () => {
  test("reading a statement", async () => {
    const { client, spies } = countingClient();
    await expect(
      readStatementPictures({
        statement: APPLE,
        client,
        rateLimiter: exhaustedLimiter(),
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(spies.readPicture).not.toHaveBeenCalled();
  });

  test("hiding or changing a number on a statement, including the whole-picture fallback", async () => {
    const { client, spies } = countingClient();
    await expect(
      readStatementWithModification({
        statement: APPLE,
        modification: { kind: "hide", numberRowIndex: 0, colIndex: 0 },
        client,
        rateLimiter: exhaustedLimiter(),
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(spies.readPicture).not.toHaveBeenCalled();

    // The fallback read is checked too: the cap runs out after the covered strip is read.
    // The other strip comes from the earlier reading, so only one call is planned.
    const limiter = new RateLimiter({ limits: { globalModelCallsPerDay: 1 } });
    const blindClient: GeminiClient = {
      isFake: true,
      readPicture: vi.fn(async (request) => {
        // Answers every strip without any HIDDEN cell, which asks for the fallback.
        return createFakeGeminiClient().readPicture({
          ...request,
          testContext: request.testContext
            ? { ...request.testContext, coverCell: undefined }
            : undefined,
        });
      }),
    };
    await expect(
      readStatementWithModification({
        statement: APPLE,
        modification: { kind: "hide", numberRowIndex: 0, colIndex: 0 },
        previousRows: CLEAN_ROWS,
        client: blindClient,
        rateLimiter: limiter,
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(blindClient.readPicture).toHaveBeenCalledTimes(1);
  });

  test("explaining a cause", async () => {
    const { client, spies } = countingClient();
    const outcome = await explainMismatchCause({
      groupLabel: "Total current assets",
      rows: [{ label: "Cash", value: "10", number: 10 }],
      statedTotal: 20,
      computedSum: 10,
      gap: 10,
      diff: -10,
      client,
      rateLimiter: exhaustedLimiter(),
      ...IDENTITY,
    });
    expect(outcome.sentence).toBeNull();
    expect(spies.explainCause).not.toHaveBeenCalled();
  });

  test("the second reader", async () => {
    const { client, spies } = countingClient();
    const png = Buffer.from("fake picture");
    const result = await recheckNumbers({
      items: [
        {
          rowIndex: 0,
          colIndex: 0,
          label: "Cash",
          value: "10",
          png,
          pictureKey: "picture-a",
        },
      ],
      client,
      rateLimiter: exhaustedLimiter(),
      ...IDENTITY,
    });
    expect(result.rateLimited).toBe(true);
    expect(spies.decideQuestions).not.toHaveBeenCalled();
  });

  test("a batch of the second reader is refused when the cap runs out between batches", async () => {
    const { client, spies } = countingClient();
    let reserved = 0;
    const limiter = {
      checkAndConsumeRequest: () => ({ allowed: true as const }),
      reserveModelCall: () => {
        reserved += 1;
        if (reserved > 1) {
          throw new RateLimitError("Daily limit reached.", "daily", 60);
        }
      },
    } as unknown as RateLimiter;
    const result = await recheckNumbers({
      items: ["a", "b"].map((key, index) => ({
        rowIndex: index,
        colIndex: 0 as const,
        label: `Row ${key}`,
        value: "10",
        png: Buffer.from(`picture ${key}`),
        pictureKey: `picture-${key}`,
      })),
      client,
      rateLimiter: limiter,
      ...IDENTITY,
    });
    expect(spies.decideQuestions).toHaveBeenCalledTimes(1);
    expect(result.failedBatches).toBe(1);
  });

  test("reading an uploaded picture", async () => {
    const { record } = await uploadRecord();
    const { client, spies } = countingClient();
    await expect(
      readUploadedPicture({
        record,
        client,
        rateLimiter: exhaustedLimiter(),
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(spies.readPicture).not.toHaveBeenCalled();
  });

  test("hiding a number on an uploaded picture, with and without a known cell box", async () => {
    const { record } = await uploadRecord();
    const { client, spies } = countingClient();
    const modification = { kind: "hide" as const, numberRowIndex: 4, colIndex: 0 as const };

    await expect(
      modifyUploadedPicture({
        record,
        modification,
        rowLabel: "Inventories",
        printedValue: "14,541",
        client,
        rateLimiter: exhaustedLimiter(),
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(spies.locateCellBox).not.toHaveBeenCalled();

    // With the box already known there is no locate call, but the read is still refused,
    // and nothing is drawn or kept in memory for the refused request.
    record.cellBoxes.set("4:0", { ymin: 100, xmin: 500, ymax: 130, xmax: 700 });
    await expect(
      modifyUploadedPicture({
        record,
        modification,
        rowLabel: "Inventories",
        printedValue: "14,541",
        client,
        rateLimiter: exhaustedLimiter(),
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(spies.readPicture).not.toHaveBeenCalled();
    expect(record.modifiedPictures.size).toBe(0);
  });
});

describe("A repeat attempt is checked against the daily cap too", () => {
  function failingClient(): GeminiClient & { calls: number } {
    const client = {
      isFake: true,
      calls: 0,
      async readPicture() {
        client.calls += 1;
        throw new Error("model is down");
      },
      async locateCellBox() {
        client.calls += 1;
        throw new Error("model is down");
      },
      async explainCause() {
        client.calls += 1;
        throw new Error("model is down");
      },
    };
    return client;
  }

  const oneCallLeft = () =>
    new RateLimiter({ limits: { globalModelCallsPerDay: 1 } });

  test("reading a statement: the repeat is refused and only one call is made", async () => {
    const client = failingClient();
    const limiter = oneCallLeft();
    await expect(
      readStatementPictures({
        statement: {
          ...APPLE,
          rows: APPLE.rows.slice(0, 6),
        },
        client,
        rateLimiter: limiter,
        timeoutMs: 200,
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(client.calls).toBe(1);
    expect(limiter.getCounts(IDENTITY).dailyModelCalls).toBe(1);
  });

  test("reading an uploaded picture: the repeat is refused", async () => {
    const { record } = await uploadRecord();
    const client = failingClient();
    await expect(
      readUploadedPicture({
        record,
        client,
        rateLimiter: oneCallLeft(),
        timeoutMs: 200,
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(client.calls).toBe(1);
  });

  test("locating a cell: the repeat is refused", async () => {
    const { record } = await uploadRecord();
    const client = failingClient();
    await expect(
      modifyUploadedPicture({
        record,
        modification: { kind: "hide", numberRowIndex: 4, colIndex: 0 },
        rowLabel: "Inventories",
        printedValue: "14,541",
        client,
        rateLimiter: oneCallLeft(),
        timeoutMs: 200,
        ...IDENTITY,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(client.calls).toBe(1);
  });

  test("explaining a cause: the repeat is refused", async () => {
    const client = failingClient();
    const outcome = await explainMismatchCause({
      groupLabel: "Total current assets",
      rows: [{ label: "Cash", value: "10", number: 10 }],
      statedTotal: 20,
      computedSum: 10,
      gap: 10,
      diff: -10,
      client,
      rateLimiter: oneCallLeft(),
      timeoutMs: 200,
      ...IDENTITY,
    });
    expect(outcome.sentence).toBeNull();
    expect(client.calls).toBe(1);
  });
});

describe("Visitor-supplied previousRows never reach a cache that other visitors read", () => {
  /** The real reading of Apple, except that the numbers of the row in the second strip are forged. */
  function forgedPreviousRows(): ReadRow[] {
    return CLEAN_ROWS.map((row, index) =>
      index < 12
        ? row
        : {
            ...row,
            cells: [
              { raw: "1", number: 1, hidden: false },
              { raw: "1", number: 1, hidden: false },
            ] as ReadRow["cells"],
          },
    );
  }

  test("a forged reading is returned to the sender but a later honest request is read from the picture", async () => {
    const cache = new ReadingCache();
    const modification = { kind: "hide" as const, numberRowIndex: 0, colIndex: 0 as const };
    const { client, spies } = countingClient();

    const forged = await readStatementWithModification({
      statement: APPLE,
      modification,
      previousRows: forgedPreviousRows(),
      client,
      cache,
      ...IDENTITY,
    });
    expect(forged.rows[12].cells[0].number).toBe(1);

    spies.readPicture.mockClear();
    const honest = await readStatementWithModification({
      statement: APPLE,
      modification,
      client,
      cache,
      ...IDENTITY,
    });

    // Not served from the combined cache entry, and the forged numbers are gone.
    expect(honest.fromCache).toBe(false);
    expect(spies.readPicture).toHaveBeenCalled();
    expect(honest.rows[12].cells[0].number).toBe(CLEAN_ROWS[12].cells[0].number);
    expect(honest.rows[12].cells[0].number).not.toBe(1);
  });

  test("an honest second request for the same change is still served from the cache", async () => {
    const cache = new ReadingCache();
    const modification = { kind: "hide" as const, numberRowIndex: 0, colIndex: 0 as const };
    const { client, spies } = countingClient();

    await readStatementWithModification({
      statement: APPLE,
      modification,
      client,
      cache,
      ...IDENTITY,
    });
    spies.readPicture.mockClear();
    const again = await readStatementWithModification({
      statement: APPLE,
      modification,
      client,
      cache,
      ...IDENTITY,
    });
    expect(again.fromCache).toBe(true);
    expect(spies.readPicture).not.toHaveBeenCalled();
  });
});

describe("Raw model error text stays on the server", () => {
  test("a statement reading that fails twice carries a plain sentence, and the detail is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client: GeminiClient = {
      isFake: true,
      async readPicture() {
        throw new Error("RAW_PROVIDER_DETAIL quota exceeded for project 1234");
      },
    };
    let caught: unknown;
    try {
      await readStatementPictures({
        statement: { ...APPLE, rows: APPLE.rows.slice(0, 6) },
        client,
        timeoutMs: 200,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReadingFailedError);
    expect((caught as Error).message).toBe(MODEL_FAILED_MESSAGE);
    expect(logged).toHaveBeenCalled();
    expect(String(logged.mock.calls[0][0])).toContain("RAW_PROVIDER_DETAIL");
  });

  test("an uploaded picture reading that fails twice carries a plain sentence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { record } = await uploadRecord();
    const client: GeminiClient = {
      isFake: true,
      async readPicture() {
        throw new Error("RAW_PROVIDER_DETAIL permission denied for the key");
      },
    };
    let caught: unknown;
    try {
      await readUploadedPicture({ record, client, timeoutMs: 200 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReadingFailedError);
    expect((caught as Error).message).toBe(MODEL_FAILED_MESSAGE);
  });
});
