import { describe, expect, test, vi } from "vitest";
import { drawStatementWithLayout } from "@/lib/draw-statement";
import {
  createFakeGeminiClient,
  createRealGeminiClient,
  DEFAULT_CAUSE_MODEL,
  FAKE_CAUSE_SENTENCE,
  formatStatementRowsAsReply,
  GeminiConfigError,
  type GeminiClient,
} from "@/lib/gemini";
import { RateLimiter, RateLimitError } from "@/lib/rate-limit";
import {
  CauseCache,
  compareReadingWithStatement,
  explainMismatchCause,
  joinHalfReadings,
  joinStripReadings,
  parseReadingReply,
  ReadingCache,
  ReadingTimeoutError,
  readPictureWithSpeedRule,
  readStatementPictures,
  readStatementWithModification,
  splitStatementForReading,
  splitStatementIntoStrips,
  type ReadingProgressEvent,
  type ReadRow,
} from "@/lib/reading";
import type { Statement, StatementRow } from "@/lib/statements";

const APPLE_SAMPLE: Statement = {
  cik: "320193",
  companyName: "Apple Inc.",
  form: "10-K",
  filingDate: "2026-11-03",
  title: "CONSOLIDATED BALANCE SHEETS",
  columns: ["Sep. 26, 2026", "Sep. 27, 2025"],
  unitLine: "USD ($) $ in Millions",
  rows: [
    { kind: "heading", label: "Current assets:", indent: 0 },
    {
      kind: "number",
      label: "Cash and cash equivalents",
      indent: 1,
      isTotal: false,
      values: ["$ 36,305", "$ 35,934"],
      numbers: [36305, 35934],
    },
    {
      kind: "number",
      label: "Marketable securities",
      indent: 1,
      isTotal: false,
      values: ["20,417", "18,763"],
      numbers: [20417, 18763],
    },
    {
      kind: "number",
      label: "Accounts receivable, net",
      indent: 1,
      isTotal: false,
      values: ["43,817", "39,777"],
      numbers: [43817, 39777],
    },
    {
      kind: "number",
      label: "Inventories",
      indent: 1,
      isTotal: false,
      values: ["14,541", "5,718"],
      numbers: [14541, 5718],
    },
    {
      kind: "number",
      label: "Total current assets",
      indent: 0,
      isTotal: true,
      values: ["115,080", "100,192"],
      numbers: [115080, 100192],
    },
    { kind: "heading", label: "Non-current assets:", indent: 0 },
    {
      kind: "number",
      label: "Marketable securities",
      indent: 1,
      isTotal: false,
      values: ["80,213", "77,723"],
      numbers: [80213, 77723],
    },
    {
      kind: "number",
      label: "Total assets",
      indent: 0,
      isTotal: true,
      values: ["195,293", "177,915"],
      numbers: [195293, 177915],
    },
  ],
};

function makeNumberedStatement(numberRowCount: number, seed = 0): Statement {
  const rows: StatementRow[] = [];
  for (let i = 1; i <= numberRowCount; i += 1) {
    if (i === 1 || i === 13 || i === 25) {
      rows.push({
        kind: "heading",
        label: `Section ${Math.ceil(i / 12)}:`,
        indent: 0,
      });
    }
    const left = i * 100 + seed;
    const right = i * 100 + seed - 10;
    rows.push({
      kind: "number",
      label: `Row ${i}`,
      indent: 1,
      isTotal: false,
      values: [left.toLocaleString("en-US"), right.toLocaleString("en-US")],
      numbers: [left, right],
    });
  }

  return {
    cik: "320193",
    companyName: "Test Co.",
    form: "10-K",
    filingDate: "2026-11-03",
    title: "CONSOLIDATED BALANCE SHEETS",
    columns: ["Sep. 26, 2026", "Sep. 27, 2025"],
    unitLine: "USD ($) $ in Millions",
    rows,
  };
}

function makeSmallStatement(seed: number): Statement {
  const a = 100 + seed;
  const b = 200 + seed;
  return {
    cik: "320193",
    companyName: "Test Co.",
    form: "10-K",
    filingDate: "2026-11-03",
    title: "BALANCE SHEET",
    columns: ["2026", "2025"],
    unitLine: "USD",
    rows: [
      {
        kind: "number",
        label: "Cash",
        indent: 0,
        isTotal: false,
        values: [String(a), String(a - 10)],
        numbers: [a, a - 10],
      },
      {
        kind: "number",
        label: "Other",
        indent: 0,
        isTotal: false,
        values: [String(b), String(b - 10)],
        numbers: [b, b - 10],
      },
    ],
  };
}

describe("Section E: Reading replies (unit 3)", () => {
  test("E1: parses Cash and cash equivalents with dollar signs and commas", () => {
    const rows = parseReadingReply(
      "Cash and cash equivalents | $ 36,305 | $ 35,934",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Cash and cash equivalents");
    expect(rows[0].cells[0].number).toBe(36305);
    expect(rows[0].cells[1].number).toBe(35934);
    expect(rows[0].cells[0].hidden).toBe(false);
    expect(rows[0].cells[1].hidden).toBe(false);
  });

  test("E2: parses Accumulated deficit with brackets and em-dash as no value", () => {
    const rows = parseReadingReply("Accumulated deficit | (1,234) | —");

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Accumulated deficit");
    expect(rows[0].cells[0].number).toBe(-1234);
    expect(rows[0].cells[1].number).toBeNull();
    expect(rows[0].cells[1].hidden).toBe(false);
  });

  test("E3: marks HIDDEN cell as covered", () => {
    const rows = parseReadingReply("Inventories | HIDDEN | 5,718");

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Inventories");
    expect(rows[0].cells[0].hidden).toBe(true);
    expect(rows[0].cells[0].number).toBeNull();
    expect(rows[0].cells[1].hidden).toBe(false);
    expect(rows[0].cells[1].number).toBe(5718);
  });

  test("E4: ignores lines without two bars", () => {
    const rows = parseReadingReply(
      [
        "Here are the rows:",
        "Only one | bar",
        "Cash and cash equivalents | 100 | 200",
      ].join("\n"),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Cash and cash equivalents");
  });

  test("E5: keeps bars inside label and reads last two fields as values", () => {
    const rows = parseReadingReply("Notes | loans | 500 | 400");

    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Notes | loans");
    expect(rows[0].cells[0].number).toBe(500);
    expect(rows[0].cells[1].number).toBe(400);
  });

  test("E6: joins half A (3 rows) and half B (4 rows) into 7 rows in printed order", async () => {
    const halfA: ReadRow[] = parseReadingReply(
      ["Row 1 | 1 | 2", "Row 2 | 3 | 4", "Row 3 | 5 | 6"].join("\n"),
    );
    const halfB: ReadRow[] = parseReadingReply(
      [
        "Row 4 | 7 | 8",
        "Row 5 | 9 | 10",
        "Row 6 | 11 | 12",
        "Row 7 | 13 | 14",
      ].join("\n"),
    );

    const joined = joinHalfReadings(halfA, halfB);
    expect(joined).toHaveLength(7);
    expect(joined.map((r) => r.label)).toEqual([
      "Row 1",
      "Row 2",
      "Row 3",
      "Row 4",
      "Row 5",
      "Row 6",
      "Row 7",
    ]);

    // Also verify readStatementPictures preserves strip 1 before strip 2 even if strip 2 resolves first.
    const sixteenRowStatement = makeNumberedStatement(16);
    const seenStrips: number[] = [];
    const delayedClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        const strip = req.testContext?.strip ?? 1;
        seenStrips.push(strip);
        if (strip === 1) {
          await new Promise((r) => setTimeout(r, 25));
        }
        return formatStatementRowsAsReply(req.testContext?.rows ?? []);
      },
    };

    const result = await readStatementPictures({
      statement: sixteenRowStatement,
      client: delayedClient,
    });
    expect(seenStrips).toEqual([1, 2]);
    expect(result.modelCalls).toBe(2);
    expect(result.rows).toHaveLength(16);
    expect(result.rows.map((r) => r.label)).toEqual(
      sixteenRowStatement.rows
        .filter((r) => r.kind === "number")
        .map((r) => r.label),
    );
  });

  test("E7: missing row counts as unread and does not shift other rows", () => {
    // Omit the first "Marketable securities" row (20,417 / 18,763), keep the second one (80,213 / 77,723).
    const readRows = parseReadingReply(
      [
        "Cash and cash equivalents | $ 36,305 | $ 35,934",
        "Accounts receivable, net | 43,817 | 39,777",
        "Inventories | 14,541 | 5,718",
        "Total current assets | 115,080 | 100,192",
        "Marketable securities | 80,213 | 77,723",
        "Total assets | 195,293 | 177,915",
      ].join("\n"),
    );

    const comparison = compareReadingWithStatement(APPLE_SAMPLE, readRows);

    expect(comparison.totalStatementNumbers).toBe(14);
    expect(comparison.readCount).toBe(12);
    expect(comparison.matchCount).toBe(12);
    expect(comparison.unreadCount).toBe(2);

    // Row index 1 among number rows is current "Marketable securities" -> unread.
    expect(comparison.rows[1].label).toBe("Marketable securities");
    expect(comparison.rows[1].unread).toBe(true);
    expect(comparison.rows[1].cells[0].unread).toBe(true);
    expect(comparison.rows[1].cells[1].unread).toBe(true);

    // Following rows did not shift: Accounts receivable still matches its own numbers,
    // and non-current Marketable securities stays aligned at index 5.
    expect(comparison.rows[2].label).toBe("Accounts receivable, net");
    expect(comparison.rows[2].unread).toBe(false);
    expect(comparison.rows[2].cells[0].matches).toBe(true);
    expect(comparison.rows[2].cells[1].matches).toBe(true);

    expect(comparison.rows[5].label).toBe("Marketable securities");
    expect(comparison.rows[5].unread).toBe(false);
    expect(comparison.rows[5].cells[0].read).toBe(80213);
    expect(comparison.rows[5].cells[0].matches).toBe(true);
  });

  test("E8: call past time limit starts one repeat, signals slow screen, and uses first answer that arrives", async () => {
    vi.useFakeTimers();
    try {
      // Case 1: repeat (attempt 2) answers first after 12s limit.
      const onSlow1 = vi.fn();
      const attempts1: number[] = [];

      const promise1 = readPictureWithSpeedRule({
        timeoutMs: 12_000,
        onSlow: onSlow1,
        call: (attempt, signal) => {
          attempts1.push(attempt);
          return new Promise((resolve, reject) => {
            const delay = attempt === 1 ? 20_000 : 1_000;
            const timer = setTimeout(
              () =>
                resolve(
                  attempt === 1
                    ? "From first | 1 | 2"
                    : "From repeat | 10 | 20",
                ),
              delay,
            );
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      });

      await vi.advanceTimersByTimeAsync(11_999);
      expect(onSlow1).not.toHaveBeenCalled();
      expect(attempts1).toEqual([1]);

      await vi.advanceTimersByTimeAsync(1);
      expect(onSlow1).toHaveBeenCalledTimes(1);
      expect(attempts1).toEqual([1, 2]);

      await vi.advanceTimersByTimeAsync(1_000);
      const outcome1 = await promise1;
      expect(outcome1.usedRepeat).toBe(true);
      expect(outcome1.timedOutFirst).toBe(true);
      expect(outcome1.rows[0].label).toBe("From repeat");

      // Case 2: attempt 1 finishes after 12s but BEFORE attempt 2 -> attempt 1 wins.
      const onSlow2 = vi.fn();
      const promise2 = readPictureWithSpeedRule({
        timeoutMs: 12_000,
        onSlow: onSlow2,
        call: (attempt, signal) =>
          new Promise((resolve, reject) => {
            const delay = attempt === 1 ? 12_500 : 5_000;
            const timer = setTimeout(
              () =>
                resolve(
                  attempt === 1
                    ? "Late first | 100 | 200"
                    : "Slower repeat | 300 | 400",
                ),
              delay,
            );
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      });

      await vi.advanceTimersByTimeAsync(12_000);
      expect(onSlow2).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);
      const outcome2 = await promise2;
      expect(outcome2.usedRepeat).toBe(true);
      expect(outcome2.rows[0].label).toBe("Late first");
    } finally {
      vi.useRealTimers();
    }
  });

  test("E9: repeat also running past 12 seconds fails with ReadingTimeoutError", async () => {
    vi.useFakeTimers();
    try {
      const onSlow = vi.fn();
      const attempts: number[] = [];

      const promise = readPictureWithSpeedRule({
        timeoutMs: 12_000,
        strip: 2,
        totalStrips: 2,
        onSlow,
        call: (attempt, signal) => {
          attempts.push(attempt);
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      });
      const assertion = expect(promise).rejects.toBeInstanceOf(
        ReadingTimeoutError,
      );

      await vi.advanceTimersByTimeAsync(12_000);
      expect(onSlow).toHaveBeenCalledTimes(1);
      expect(attempts).toEqual([1, 2]);

      await vi.advanceTimersByTimeAsync(12_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("E10: empty reply or reply with no row lines counts as failed call and gets one repeat", async () => {
    const emptyCalls: number[] = [];
    const emptyOutcome = await readPictureWithSpeedRule({
      timeoutMs: 5_000,
      call: async (attempt) => {
        emptyCalls.push(attempt);
        if (attempt === 1) return "";
        return "Cash | 100 | 200";
      },
    });
    expect(emptyCalls).toEqual([1, 2]);
    expect(emptyOutcome.usedRepeat).toBe(true);
    expect(emptyOutcome.rows[0].label).toBe("Cash");

    const proseOnlyCalls: number[] = [];
    const proseOutcome = await readPictureWithSpeedRule({
      timeoutMs: 5_000,
      call: async (attempt) => {
        proseOnlyCalls.push(attempt);
        if (attempt === 1) return "Here are the rows:\nNo pipe separators here.";
        return "Inventories | 50 | 60";
      },
    });
    expect(proseOnlyCalls).toEqual([1, 2]);
    expect(proseOutcome.usedRepeat).toBe(true);
    expect(proseOutcome.rows[0].label).toBe("Inventories");
  });

  test("E11: reading the same picture twice makes no second model call and returns the same rows", async () => {
    const cache = new ReadingCache();
    let callCount = 0;
    const baseClient = createFakeGeminiClient();
    const countingClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        callCount += 1;
        return baseClient.readPicture(req);
      },
    };

    const first = await readStatementPictures({
      statement: APPLE_SAMPLE,
      client: countingClient,
      cache,
    });
    expect(first.fromCache).toBe(false);
    expect(first.modelCalls).toBe(1);
    expect(callCount).toBe(1);

    const second = await readStatementPictures({
      statement: APPLE_SAMPLE,
      client: countingClient,
      cache,
    });
    expect(second.fromCache).toBe(true);
    expect(second.modelCalls).toBe(0);
    expect(callCount).toBe(1);
    expect(second.rows).toEqual(first.rows);
    expect(second.comparison.matchCount).toBe(first.comparison.matchCount);
  });

  test("E12: 121st counted request from one browser within one hour is rejected without a model call, and cached reads are not counted", async () => {
    const now = 1_700_000_000_000;
    const rateLimiter = new RateLimiter({ now: () => now });
    const cache = new ReadingCache();
    const browserId = "browser-test-12345678";
    const ip = "198.51.100.25";

    let modelCalls = 0;
    const baseClient = createFakeGeminiClient();
    const countingClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        modelCalls += 1;
        return baseClient.readPicture(req);
      },
    };

    // First 119 counted requests via the rate limiter, plus 1 real reading through
    // readStatementPictures -> 120 counted requests in one hour.
    for (let i = 0; i < 119; i += 1) {
      const decision = rateLimiter.checkAndConsumeRequest({
        browserId,
        ip,
        plannedModelCalls: 2,
      });
      expect(decision.allowed).toBe(true);
      rateLimiter.recordModelCalls(2);
    }

    const stmt120 = makeSmallStatement(120);
    const result120 = await readStatementPictures({
      statement: stmt120,
      client: countingClient,
      cache,
      rateLimiter,
      browserId,
      ip,
    });
    expect(result120.fromCache).toBe(false);
    expect(modelCalls).toBe(1);

    // Reading the same picture again answers from memory and is NOT counted or blocked.
    const cachedRepeat = await readStatementPictures({
      statement: stmt120,
      client: countingClient,
      cache,
      rateLimiter,
      browserId,
      ip,
    });
    expect(cachedRepeat.fromCache).toBe(true);
    expect(modelCalls).toBe(1);

    // 121st request that needs a model call is rejected with no model call made.
    const stmt121 = makeSmallStatement(121);
    await expect(
      readStatementPictures({
        statement: stmt121,
        client: countingClient,
        cache,
        rateLimiter,
        browserId,
        ip,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(modelCalls).toBe(1);
  });

  test("E13: 40 browsers behind one network address sending 10 reading requests each within one hour are all served", () => {
    const now = 1_700_000_000_000;
    const rateLimiter = new RateLimiter({ now: () => now });
    const venueIp = "203.0.113.10";

    let served = 0;
    for (let browserIndex = 1; browserIndex <= 40; browserIndex += 1) {
      const browserId = `venue-browser-${String(browserIndex).padStart(4, "0")}`;
      for (let reqIndex = 1; reqIndex <= 10; reqIndex += 1) {
        const decision = rateLimiter.checkAndConsumeRequest({
          browserId,
          ip: venueIp,
          plannedModelCalls: 2,
        });
        expect(decision.allowed).toBe(true);
        rateLimiter.recordModelCalls(2);
        served += 1;
      }
    }

    expect(served).toBe(400);
    expect(
      rateLimiter.getCounts({
        browserId: "venue-browser-0001",
        ip: venueIp,
      }),
    ).toEqual({
      browserHourCount: 10,
      ipHourCount: 400,
      dailyModelCalls: 800,
    });
  });

  test("daily limit blocks new model calls after 3,000 calls in a day", () => {
    const now = 1_700_000_000_000;
    const rateLimiter = new RateLimiter({ now: () => now });
    rateLimiter.recordModelCalls(3_000);

    const decision = rateLimiter.check({
      browserId: "fresh-browser-123456",
      ip: "198.51.100.77",
      plannedModelCalls: 2,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("daily");
      expect(decision.message).toMatch(/3,000/);
    }
  });

  test("splits a statement of 30 number rows into 3 pictures of 12, 12 and 6 rows, and 12 rows into 1 picture", () => {
    const countNum = (rows: StatementRow[]) =>
      rows.filter((r) => r.kind === "number").length;

    const thirtyRowStatement = makeNumberedStatement(30);
    const thirtyStrips = splitStatementForReading(thirtyRowStatement);
    expect(thirtyStrips).toHaveLength(3);
    expect(thirtyStrips.map(countNum)).toEqual([12, 12, 6]);
    expect(thirtyStrips.flat()).toEqual(thirtyRowStatement.rows);

    // Every picture carries the title line and the two column headings above its rows.
    for (const stripRows of thirtyStrips) {
      const { png, layout } = drawStatementWithLayout(thirtyRowStatement, {
        rows: stripRows,
      });
      expect(png.byteLength).toBeGreaterThan(2000);
      expect(layout.rowBoxes[0]?.y).toBeGreaterThan(100);
    }

    const twelveRowStatement = makeNumberedStatement(12);
    const twelveStrips = splitStatementIntoStrips(twelveRowStatement);
    expect(twelveStrips).toHaveLength(1);
    expect(countNum(twelveStrips[0])).toBe(12);
    expect(twelveStrips[0]).toEqual(twelveRowStatement.rows);
  });

  test("reads a 30-row statement as 3 parallel pictures and keeps printed order when pictures return out of order", async () => {
    const statement = makeNumberedStatement(30);
    const events: ReadingProgressEvent[] = [];
    const startedStrips: number[] = [];
    const resolvers = new Map<number, () => void>();

    const outOfOrderClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        const strip = req.testContext?.strip ?? 1;
        startedStrips.push(strip);
        await new Promise<void>((resolve) => {
          resolvers.set(strip, resolve);
        });
        return formatStatementRowsAsReply(req.testContext?.rows ?? []);
      },
    };

    const readingPromise = readStatementPictures({
      statement,
      client: outOfOrderClient,
      onProgress: (event) => events.push(event),
    });

    // All 3 pictures are sent at the same time.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(startedStrips).toEqual([1, 2, 3]);

    // Resolve out of order: 3, then 1, then 2.
    resolvers.get(3)?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolvers.get(1)?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolvers.get(2)?.();

    const result = await readingPromise;
    expect(result.modelCalls).toBe(3);
    expect(result.rows).toHaveLength(30);
    expect(result.rows.map((r) => r.label)).toEqual(
      Array.from({ length: 30 }, (_, i) => `Row ${i + 1}`),
    );
    expect(joinStripReadings([result.rows.slice(0, 12), result.rows.slice(12, 24), result.rows.slice(24)])).toEqual(
      result.rows,
    );

    const startedEvent = events.find((e) => e.type === "started");
    expect(startedEvent).toEqual({
      type: "started",
      totalNumbers: 60,
      totalStrips: 3,
    });
    const stripDoneEvents = events.filter((e) => e.type === "strip_done");
    expect(stripDoneEvents).toHaveLength(3);
    expect(stripDoneEvents.map((e) => e.completedStrips)).toEqual([1, 2, 3]);
    expect(stripDoneEvents.every((e) => e.totalStrips === 3)).toBe(true);
  });

  test("a statement that needs 5 pictures costs 5 model calls against the limits", async () => {
    const now = 1_700_000_000_000;
    const rateLimiter = new RateLimiter({ now: () => now });
    const browserId = "browser-five-strips-1234";
    const ip = "198.51.100.88";
    const sixtyRowStatement = makeNumberedStatement(60);

    const result = await readStatementPictures({
      statement: sixtyRowStatement,
      client: createFakeGeminiClient(),
      rateLimiter,
      browserId,
      ip,
    });

    expect(result.modelCalls).toBe(5);
    expect(
      rateLimiter.getCounts({ browserId, ip }).dailyModelCalls,
    ).toBe(5);

    // If only 4 daily calls remain, a 5-picture statement is rejected before any model call.
    const tightLimiter = new RateLimiter({
      now: () => now,
      limits: { globalModelCallsPerDay: 9 },
    });
    tightLimiter.recordModelCalls(5);
    let callCount = 0;
    const baseClient = createFakeGeminiClient();
    const countingClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        callCount += 1;
        return baseClient.readPicture(req);
      },
    };

    await expect(
      readStatementPictures({
        statement: sixtyRowStatement,
        client: countingClient,
        rateLimiter: tightLimiter,
        browserId,
        ip,
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(callCount).toBe(0);
  });

  test("real Gemini client throws GeminiConfigError when GEMINI_API_KEY is missing", async () => {
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const client = createRealGeminiClient();
      await expect(
        client.readPicture({
          png: Buffer.from("fake-png"),
          prompt: "test",
        }),
      ).rejects.toBeInstanceOf(GeminiConfigError);
    } finally {
      if (previous !== undefined) {
        process.env.GEMINI_API_KEY = previous;
      }
    }
  });
});

describe("Unit 5: hide/change single-strip re-reading, whole-picture fallback, and cause model", () => {
  test("hide redraws and reads ONLY the modified strip (1 model call) and reuses earlier readings for other strips", async () => {
    const stmt = makeNumberedStatement(16); // 2 strips: 12 rows + 4 rows
    const cache = new ReadingCache();
    const rateLimiter = new RateLimiter();
    const baseClient = createFakeGeminiClient();
    const calls: Array<{ strip: number; totalStrips: number }> = [];

    const countingClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        calls.push({
          strip: req.testContext?.strip ?? 1,
          totalStrips: req.testContext?.totalStrips ?? 1,
        });
        return baseClient.readPicture(req);
      },
    };

    const initial = await readStatementPictures({
      statement: stmt,
      client: countingClient,
      cache,
      rateLimiter,
      browserId: "browser-hide-12345678",
      ip: "198.51.100.5",
    });
    expect(initial.modelCalls).toBe(2);
    expect(calls).toHaveLength(2);

    // Hide row 4 (index 4, inside strip 1) -> only strip 1 is read (1 model call).
    const hidden = await readStatementWithModification({
      statement: stmt,
      modification: { kind: "hide", numberRowIndex: 4, colIndex: 0 },
      previousRows: initial.rows,
      client: countingClient,
      cache,
      rateLimiter,
      browserId: "browser-hide-12345678",
      ip: "198.51.100.5",
    });

    expect(hidden.modelCalls).toBe(1);
    expect(hidden.usedWholePictureFallback).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[2].strip).toBe(1);
    expect(hidden.rows).toHaveLength(16);
    expect(hidden.comparison.rows[4].cells[0].hidden).toBe(true);
    expect(hidden.comparison.rows[4].cells[0].read).toBeNull();
    expect(hidden.comparison.rows[15].cells[0].read).toBe(1600);

    // Repeating the same hide answers from cache with 0 model calls.
    const cachedRepeat = await readStatementWithModification({
      statement: stmt,
      modification: { kind: "hide", numberRowIndex: 4, colIndex: 0 },
      previousRows: initial.rows,
      client: countingClient,
      cache,
      rateLimiter,
      browserId: "browser-hide-12345678",
      ip: "198.51.100.5",
    });
    expect(cachedRepeat.fromCache).toBe(true);
    expect(cachedRepeat.modelCalls).toBe(0);
    expect(calls).toHaveLength(3);
  });

  test("hide falls back to reading the whole statement as one picture once when the covered strip returns no HIDDEN cell", async () => {
    const stmt = makeNumberedStatement(16); // 2 strips
    const cache = new ReadingCache();
    const baseClient = createFakeGeminiClient();

    const initial = await readStatementPictures({
      statement: stmt,
      client: baseClient,
      cache,
    });

    const seenRowCounts: number[] = [];
    const fallbackClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        const rows = req.testContext?.rows ?? [];
        const numberRowsCount = rows.filter((r) => r.kind === "number").length;
        seenRowCounts.push(numberRowsCount);
        // Strip read (12 rows) misses the black box and omits HIDDEN;
        // whole-statement read (16 rows) properly returns HIDDEN.
        if (numberRowsCount < 16) {
          return formatStatementRowsAsReply(rows);
        }
        return formatStatementRowsAsReply(rows, {
          coverCell: req.testContext?.coverCell,
        });
      },
    };

    const result = await readStatementWithModification({
      statement: stmt,
      modification: { kind: "hide", numberRowIndex: 4, colIndex: 0 },
      previousRows: initial.rows,
      client: fallbackClient,
      cache,
    });

    expect(result.usedWholePictureFallback).toBe(true);
    expect(result.modelCalls).toBe(2); // 1 strip attempt + 1 whole-statement fallback
    expect(seenRowCounts).toEqual([12, 16]);
    expect(result.comparison.rows[4].cells[0].hidden).toBe(true);
    expect(result.comparison.rows[4].cells[0].read).toBeNull();
  });

  test("change redraws and reads ONLY the modified strip (1 model call) and returns the changed value", async () => {
    const stmt = makeNumberedStatement(16); // 2 strips
    const cache = new ReadingCache();
    const baseClient = createFakeGeminiClient();
    let calls = 0;

    const countingClient: GeminiClient = {
      isFake: true,
      async readPicture(req) {
        calls += 1;
        return baseClient.readPicture(req);
      },
    };

    const initial = await readStatementPictures({
      statement: stmt,
      client: countingClient,
      cache,
    });
    expect(calls).toBe(2);

    const changed = await readStatementWithModification({
      statement: stmt,
      modification: {
        kind: "change",
        numberRowIndex: 14, // inside strip 2
        colIndex: 0,
        newValue: "9,999",
      },
      previousRows: initial.rows,
      client: countingClient,
      cache,
    });

    expect(changed.modelCalls).toBe(1);
    expect(calls).toBe(3);
    expect(changed.comparison.rows[14].cells[0].read).toBe(9999);
    expect(changed.comparison.rows[0].cells[0].read).toBe(100);
  });

  test("explainMismatchCause uses CAUSE_MODEL (default gemini-4-carbon), caches, respects rate limits, retries once, and returns null when both attempts fail", async () => {
    const previousModel = process.env.CAUSE_MODEL;
    delete process.env.CAUSE_MODEL;
    try {
      const cache = new CauseCache();
      const rateLimiter = new RateLimiter();
      const seenModels: string[] = [];

      const client: GeminiClient = {
        isFake: true,
        async readPicture() {
          return "";
        },
        async explainCause(req) {
          seenModels.push(req.model ?? "");
          return FAKE_CAUSE_SENTENCE;
        },
      };

      const first = await explainMismatchCause({
        groupLabel: "Total current assets",
        rows: [
          { label: "Cash", value: "36,305", number: 36305 },
          { label: "Inventories", value: "15,541", number: 15541 },
        ],
        statedTotal: 173857,
        computedSum: 174857,
        gap: 1000,
        diff: 1000,
        client,
        cache,
        rateLimiter,
        browserId: "browser-cause-1234567",
        ip: "198.51.100.9",
      });

      expect(first.model).toBe(DEFAULT_CAUSE_MODEL);
      expect(seenModels).toEqual([DEFAULT_CAUSE_MODEL]);
      expect(first.sentence).toBe(FAKE_CAUSE_SENTENCE);
      expect(first.fromCache).toBe(false);
      expect(first.modelCalls).toBe(1);

      // Cached second call makes 0 model calls.
      const second = await explainMismatchCause({
        groupLabel: "Total current assets",
        rows: [
          { label: "Cash", value: "36,305", number: 36305 },
          { label: "Inventories", value: "15,541", number: 15541 },
        ],
        statedTotal: 173857,
        computedSum: 174857,
        gap: 1000,
        diff: 1000,
        client,
        cache,
        rateLimiter,
        browserId: "browser-cause-1234567",
        ip: "198.51.100.9",
      });
      expect(second.fromCache).toBe(true);
      expect(second.modelCalls).toBe(0);
      expect(second.sentence).toBe(FAKE_CAUSE_SENTENCE);

      // Failing first call retries once; when both fail, returns sentence: null without throwing.
      let failAttempts = 0;
      const failingClient: GeminiClient = {
        isFake: true,
        async readPicture() {
          return "";
        },
        async explainCause() {
          failAttempts += 1;
          throw new Error("model error");
        },
      };

      const failed = await explainMismatchCause({
        groupLabel: "Total current assets",
        rows: [{ label: "Cash", value: "100", number: 100 }],
        statedTotal: 200,
        computedSum: 100,
        gap: 100,
        diff: -100,
        client: failingClient,
        timeoutMs: 500,
      });
      expect(failAttempts).toBe(2);
      expect(failed.sentence).toBeNull();
      expect(failed.usedRepeat).toBe(true);
    } finally {
      if (previousModel !== undefined) {
        process.env.CAUSE_MODEL = previousModel;
      }
    }
  });
});
