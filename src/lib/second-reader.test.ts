import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, test } from "vitest";
import { POST as postReadRoute } from "@/app/api/company/[cik]/read/route";
import appleFixture from "@/fixtures/apple-statement.json";
import northstarFixture from "@/fixtures/northstar-statement.json";
import { proveColumns } from "@/lib/adding";
import {
  createFakeGeminiClient,
  createRealGeminiClient,
  GeminiConfigError,
  type DecideQuestionsRequest,
  type GeminiClient,
} from "@/lib/gemini";
import { RateLimiter } from "@/lib/rate-limit";
import {
  compareReadingWithStatement,
  formatStatementRowsAsReplyForTest,
  type ReadingProgressEvent,
  type StatementReadingResult,
} from "@/lib/reading-test-helpers";
import {
  buildDecisionInstruction,
  classifyProbability,
  DecisionCache,
  DEFAULT_CUTOFFS,
  loadCutoffs,
  recheckNumbers,
  recheckStatementNumbers,
  type SecondReaderItem,
} from "@/lib/second-reader";
import type { Statement, StatementRow } from "@/lib/statements";

const APPLE_STATEMENT = appleFixture as unknown as Statement;
const NORTHSTAR_STATEMENT = northstarFixture as unknown as Statement;

function makeStandaloneItems(count: number, pictureKey = "pic-1"): SecondReaderItem[] {
  const png = Buffer.from(`fake-png-${pictureKey}`);
  return Array.from({ length: count }, (_, idx) => ({
    rowIndex: idx,
    colIndex: 0 as const,
    label: `Standalone row ${idx + 1}`,
    value: String((idx + 1) * 100),
    png,
    pictureKey,
  }));
}

function makeReadingResultForStatement(statement: Statement): StatementReadingResult {
  const rows = formatStatementRowsAsReplyForTest(statement.rows);
  const comparison = compareReadingWithStatement(statement, rows);
  return {
    rows,
    comparison,
    fromCache: false,
    usedRepeat: false,
    modelCalls: 1,
  };
}

function makeUnprovenMultiStripStatement(rowCount: number): Statement {
  const rows: StatementRow[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    // Prime-like non-summing numbers so no row forms a total.
    const left = (i + 1) * 1000 + 7;
    const right = (i + 1) * 1000 + 13;
    rows.push({
      kind: "number",
      label: `Item ${i + 1}`,
      indent: 1,
      isTotal: false,
      values: [left.toLocaleString("en-US"), right.toLocaleString("en-US")],
      numbers: [left, right],
    });
  }
  return {
    cik: "990002",
    companyName: "Multi Strip Corp",
    form: "10-K",
    filingDate: "2026-11-05",
    title: "CONSOLIDATED BALANCE SHEETS",
    columns: ["Sep. 30, 2026", "Sep. 30, 2025"],
    unitLine: "USD ($) $ in Millions",
    rows,
  };
}

describe("The second reader — section F of docs/test-cases.md", () => {
  test("F1: 45 numbers outside every total sends three requests with 20, 20 and 5 questions", async () => {
    const items = makeStandaloneItems(45);
    const batchSizes: number[] = [];

    const fakeClient: GeminiClient = {
      isFake: true,
      async readPicture() {
        return "";
      },
      async decideQuestions(req: DecideQuestionsRequest) {
        batchSizes.push(req.questions.length);
        const answers: Record<string, number> = {};
        for (const q of req.questions) {
          answers[q.id] = 0.97;
        }
        return answers;
      },
    };

    const outcome = await recheckNumbers({
      items,
      client: fakeClient,
      cutoffs: DEFAULT_CUTOFFS,
    });

    expect(batchSizes).toEqual([20, 20, 5]);
    expect(outcome.modelCalls).toBe(3);
    expect(outcome.results).toHaveLength(45);
    expect(outcome.failedBatches).toBe(0);
    expect(outcome.results.every((r) => r.verdict === "agrees")).toBe(true);
  });

  test("F2: no number outside every total sends no request", async () => {
    let calls = 0;
    const fakeClient: GeminiClient = {
      isFake: true,
      async readPicture() {
        return "";
      },
      async decideQuestions() {
        calls += 1;
        return {};
      },
    };

    // Apple fixture has 26 proven numbers and 0 numbers outside every total.
    const readingResult = makeReadingResultForStatement(APPLE_STATEMENT);
    const outcome = await recheckStatementNumbers({
      statement: APPLE_STATEMENT,
      readingResult,
      client: fakeClient,
      cutoffs: DEFAULT_CUTOFFS,
    });

    expect(calls).toBe(0);
    expect(outcome.modelCalls).toBe(0);
    expect(outcome.results).toEqual([]);
  });

  test("F3: when the second of three requests fails, its 20 numbers show Needs your eye and the other 25 keep their results", async () => {
    const items = makeStandaloneItems(45);
    let callIndex = 0;

    const fakeClient: GeminiClient = {
      isFake: true,
      async readPicture() {
        return "";
      },
      async decideQuestions(req: DecideQuestionsRequest) {
        callIndex += 1;
        if (callIndex === 2) {
          throw new Error("Simulated Decision 1 failure");
        }
        const answers: Record<string, number> = {};
        for (const q of req.questions) {
          answers[q.id] = 0.97;
        }
        return answers;
      },
    };

    const outcome = await recheckNumbers({
      items,
      client: fakeClient,
      cutoffs: DEFAULT_CUTOFFS,
    });

    expect(callIndex).toBe(3);
    expect(outcome.failedBatches).toBe(1);
    expect(outcome.results).toHaveLength(45);

    // Batch 1 (indices 0..19): kept agrees result.
    for (let i = 0; i < 20; i += 1) {
      expect(outcome.results[i].verdict).toBe("agrees");
      expect(outcome.results[i].probability).toBe(0.97);
      expect(outcome.results[i].failed).toBe(false);
    }

    // Batch 2 (indices 20..39): failed -> Needs your eye ("unsure", failed: true).
    for (let i = 20; i < 40; i += 1) {
      expect(outcome.results[i].verdict).toBe("unsure");
      expect(outcome.results[i].probability).toBeNull();
      expect(outcome.results[i].failed).toBe(true);
    }

    // Batch 3 (indices 40..44): kept agrees result.
    for (let i = 40; i < 45; i += 1) {
      expect(outcome.results[i].verdict).toBe("agrees");
      expect(outcome.results[i].probability).toBe(0.97);
      expect(outcome.results[i].failed).toBe(false);
    }
  });

  test("F4: probability 0.97 gives Not proven with no question (agrees)", () => {
    expect(classifyProbability(0.97, DEFAULT_CUTOFFS)).toBe("agrees");
  });

  test("F5: probability 0.90 at upper cut-off counts as agreeing (Not proven)", () => {
    expect(classifyProbability(0.9, DEFAULT_CUTOFFS)).toBe("agrees");
  });

  test("F6: probability 0.60 gives Needs your eye (unsure)", () => {
    expect(classifyProbability(0.6, DEFAULT_CUTOFFS)).toBe("unsure");
  });

  test("F7: probability 0.30 at lower cut-off gives Needs your eye and does not count as disagreeing", () => {
    expect(classifyProbability(0.3, DEFAULT_CUTOFFS)).toBe("unsure");
  });

  test("F8: probability 0.10 gives Needs your eye marked in red (disagrees)", () => {
    expect(classifyProbability(0.1, DEFAULT_CUTOFFS)).toBe("disagrees");
  });

  test("F9: number inside a total that re-adds sends no request and keeps its tick from adding alone", async () => {
    // Northstar fixture has 12 proven numbers (inside totals) and 2 numbers outside every total.
    const askedLabels: string[] = [];
    const fakeClient: GeminiClient = {
      isFake: true,
      async readPicture() {
        return "";
      },
      async decideQuestions(req: DecideQuestionsRequest) {
        const answers: Record<string, number> = {};
        for (const q of req.questions) {
          askedLabels.push(q.rowLabel ?? "");
          // Even if the second reader returned a tiny probability, proven numbers are never asked.
          answers[q.id] = 0.05;
        }
        return answers;
      },
    };

    const readingResult = makeReadingResultForStatement(NORTHSTAR_STATEMENT);
    const numberRows = NORTHSTAR_STATEMENT.rows.filter(
      (r) => r.kind === "number",
    );
    const proof = proveColumns(
      numberRows.map((r) => r.numbers[0]),
      numberRows.map((r) => r.numbers[1]),
      {
        unreadMask: numberRows.map(() => [false, false] as const),
      },
    );
    expect(proof.counts.proven).toBe(12);
    expect(proof.counts.notProven).toBe(2);

    const outcome = await recheckStatementNumbers({
      statement: NORTHSTAR_STATEMENT,
      readingResult,
      proof,
      client: fakeClient,
      cutoffs: DEFAULT_CUTOFFS,
    });

    // Only the 2 outside-total numbers were sent; none of the 12 proven numbers were asked.
    expect(askedLabels).toEqual(["Restricted cash", "Deferred tax asset"]);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.map((r) => r.rowIndex)).toEqual([6, 7]);
    // Every proven cell retains its proven status from adding alone.
    for (let i = 0; i < 6; i += 1) {
      expect(proof.left.cellStatuses[i]).toBe("proven");
      expect(proof.right.cellStatuses[i]).toBe("proven");
    }
  });
});

describe("Second reader grouping, cut-offs, caching, rate limits, and fake/real clients", () => {
  afterEach(() => {
    process.env.ADDS_UP_TEST = "1";
  });

  test("groups questions by <=12-row strip picture and splits a 24-number strip into batches of 20 and 4", async () => {
    // 14 rows of non-summing pairs -> strip 1 has 12 rows (24 numbers -> 20 + 4), strip 2 has 2 rows (4 numbers -> 4).
    const statement = makeUnprovenMultiStripStatement(14);
    const readingResult = makeReadingResultForStatement(statement);

    const calls: Array<{ pngLength: number; questionCount: number; firstLabel: string }> = [];
    const fakeClient: GeminiClient = {
      isFake: true,
      async readPicture() {
        return "";
      },
      async decideQuestions(req: DecideQuestionsRequest) {
        calls.push({
          pngLength: req.png.byteLength,
          questionCount: req.questions.length,
          firstLabel: req.questions[0]?.rowLabel ?? "",
        });
        const answers: Record<string, number> = {};
        for (const q of req.questions) {
          answers[q.id] = 0.97;
        }
        return answers;
      },
    };

    const outcome = await recheckStatementNumbers({
      statement,
      readingResult,
      client: fakeClient,
      cutoffs: DEFAULT_CUTOFFS,
    });

    expect(calls.map((c) => c.questionCount)).toEqual([20, 4, 4]);
    expect(calls[0].firstLabel).toBe("Item 1");
    expect(calls[1].firstLabel).toBe("Item 11");
    expect(calls[2].firstLabel).toBe("Item 13");
    // Strip 1's two batches share the same strip PNG; strip 2 has a different (shorter) strip PNG.
    expect(calls[0].pngLength).toBe(calls[1].pngLength);
    expect(calls[2].pngLength).not.toBe(calls[0].pngLength);
    expect(outcome.modelCalls).toBe(3);
    expect(outcome.results).toHaveLength(28);
  });

  test("builds yes-or-no instructions in docs/gemini-calls.md shape", () => {
    expect(
      buildDecisionInstruction({
        label: "Cash and cash equivalents",
        value: "36,305",
        colIndex: 0,
      }),
    ).toBe(
      "Is the value 36,305 printed for the row 'Cash and cash equivalents' in the left column?",
    );
    expect(
      buildDecisionInstruction({
        label: "Deferred tax asset",
        value: "275",
        colIndex: 1,
      }),
    ).toBe(
      "Is the value 275 printed for the row 'Deferred tax asset' in the right column?",
    );
  });

  test("reads cut-offs from JSON file and defaults to 0.90 and 0.30 when missing", async () => {
    const missingCutoffs = await loadCutoffs(
      path.join(process.cwd(), "data", "does-not-exist-cutoffs.json"),
    );
    expect(missingCutoffs).toEqual({ upper: 0.9, lower: 0.3 });

    const customCutoffs = await loadCutoffs(
      path.join(process.cwd(), "src", "fixtures", "cutoffs-test.json"),
    );
    expect(customCutoffs).toEqual({ upper: 0.95, lower: 0.2 });
    expect(classifyProbability(0.92, customCutoffs)).toBe("unsure");
    expect(classifyProbability(0.95, customCutoffs)).toBe("agrees");
    expect(classifyProbability(0.25, customCutoffs)).toBe("unsure");
    expect(classifyProbability(0.19, customCutoffs)).toBe("disagrees");
  });

  test("uses DecisionCache and counts each gemini-decision-1 request as one model call in RateLimiter", async () => {
    const cache = new DecisionCache();
    const limiter = new RateLimiter({
      limits: { browserPerHour: 10, ipPerHour: 20, globalModelCallsPerDay: 4 },
    });
    const browserId = "browser-decision-limit-1";
    const ip = "198.51.100.55";

    let callCount = 0;
    const baseFake = createFakeGeminiClient();
    const countingClient: GeminiClient = {
      isFake: true,
      readPicture: baseFake.readPicture,
      async decideQuestions(req) {
        callCount += 1;
        return baseFake.decideQuestions!(req);
      },
    };

    // 45 items = 3 requests = 3 model calls.
    const items = makeStandaloneItems(45);
    const first = await recheckNumbers({
      items,
      client: countingClient,
      cache,
      rateLimiter: limiter,
      browserId,
      ip,
    });
    expect(first.modelCalls).toBe(3);
    expect(first.fromCache).toBe(false);
    expect(callCount).toBe(3);
    expect(limiter.getCounts({ browserId, ip }).dailyModelCalls).toBe(3);

    // Repeat with same picture and questions -> served from cache, 0 model calls!
    const second = await recheckNumbers({
      items,
      client: countingClient,
      cache,
      rateLimiter: limiter,
      browserId,
      ip,
    });
    expect(second.fromCache).toBe(true);
    expect(second.modelCalls).toBe(0);
    expect(callCount).toBe(3);
    expect(limiter.getCounts({ browserId, ip }).dailyModelCalls).toBe(3);

    // New uncached 2-batch request needs 2 model calls, but only 1 daily call remains -> blocked, 0 calls, Needs your eye!
    const moreItems = makeStandaloneItems(25, "pic-2");
    const blocked = await recheckNumbers({
      items: moreItems,
      client: countingClient,
      cache,
      rateLimiter: limiter,
      browserId,
      ip,
    });
    expect(blocked.rateLimited).toBe(true);
    expect(blocked.modelCalls).toBe(0);
    expect(callCount).toBe(3);
    expect(blocked.results.every((r) => r.verdict === "unsure" && r.failed)).toBe(
      true,
    );
  });

  test("fake client answers 0.97 by default, 0.10 for ?doubt and 0.60 for ?unsure", async () => {
    const client = createFakeGeminiClient();
    const readingResult = makeReadingResultForStatement(NORTHSTAR_STATEMENT);

    const defaultOutcome = await recheckStatementNumbers({
      statement: NORTHSTAR_STATEMENT,
      readingResult,
      client,
      cutoffs: DEFAULT_CUTOFFS,
    });
    expect(defaultOutcome.results.map((r) => [r.rowIndex, r.probability, r.verdict])).toEqual([
      [6, 0.97, "agrees"],
      [7, 0.97, "agrees"],
    ]);

    const overrideOutcome = await recheckStatementNumbers({
      statement: NORTHSTAR_STATEMENT,
      readingResult,
      client,
      cutoffs: DEFAULT_CUTOFFS,
      bypassCache: true,
      testContext: {
        unsureLabels: ["Restricted cash"],
        doubtLabels: ["Deferred tax asset"],
      },
    });
    expect(overrideOutcome.results.map((r) => [r.rowIndex, r.probability, r.verdict])).toEqual([
      [6, 0.6, "unsure"],
      [7, 0.1, "disagrees"],
    ]);
  });

  test("read route streams done immediately followed by recheck event in test mode with ?doubt and ?unsure", async () => {
    process.env.ADDS_UP_TEST = "1";
    const req = new NextRequest(
      "http://localhost/api/company/990001/read?unsure=Restricted+cash&doubt=Deferred+tax+asset",
      { method: "POST" },
    );
    const res = await postReadRoute(req, {
      params: Promise.resolve({ cik: "990001" }),
    });
    expect(res.status).toBe(200);

    const text = await res.text();
    const events = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReadingProgressEvent);

    const doneIdx = events.findIndex((e) => e.type === "done");
    const recheckIdx = events.findIndex((e) => e.type === "recheck");
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(recheckIdx).toBeGreaterThan(doneIdx);

    const recheckEvent = events[recheckIdx];
    expect(recheckEvent.type).toBe("recheck");
    if (recheckEvent.type === "recheck") {
      expect(
        recheckEvent.recheck.results.map((r) => [r.rowIndex, r.probability, r.verdict]),
      ).toEqual([
        [6, 0.6, "unsure"],
        [7, 0.1, "disagrees"],
      ]);
    }
  });

  test("real client throws GeminiConfigError for decideQuestions when GEMINI_API_KEY is missing", async () => {
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const client = createRealGeminiClient();
      await expect(
        client.decideQuestions!({
          png: Buffer.from("fake-png"),
          questions: [
            {
              id: "q01",
              instructions: "Is the value 450 printed for the row 'Restricted cash' in the left column?",
            },
          ],
        }),
      ).rejects.toBeInstanceOf(GeminiConfigError);
    } finally {
      if (previous !== undefined) {
        process.env.GEMINI_API_KEY = previous;
      }
    }
  });
});
