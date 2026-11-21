import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { proveColumns, type TwoColumnProof } from "@/lib/adding";
import { drawStatementPng } from "@/lib/draw-statement";
import {
  GEMINI_DECISION_MODEL,
  type DecisionQuestion,
  type FakeDecideContext,
  type GeminiClient,
} from "@/lib/gemini";
import type { RateLimiter } from "@/lib/rate-limit";
import {
  computePictureCacheKey,
  getReadTimeoutMs,
  type RowComparison,
  type StatementReadingResult,
} from "@/lib/reading";
import type { Statement } from "@/lib/statements";
import { splitStatementIntoStrips } from "@/lib/strips";
import {
  secondReaderCellKey,
  type SecondReaderCellResult,
  type SecondReaderCutoffs,
  type SecondReaderResult,
  type SecondReaderVerdict,
} from "@/lib/second-reader-types";

export {
  secondReaderCellKey,
  type SecondReaderCellResult,
  type SecondReaderCutoffs,
  type SecondReaderResult,
  type SecondReaderVerdict,
};

export const MAX_DECISION_QUESTIONS = 20;

export const DEFAULT_CUTOFFS: SecondReaderCutoffs = {
  upper: 0.9,
  lower: 0.3,
};

const DEFAULT_CUTOFFS_PATH = path.join(process.cwd(), "data", "cutoffs.json");

export type SecondReaderItem = {
  rowIndex: number;
  colIndex: 0 | 1;
  label: string;
  value: string;
  columnName?: string;
  png: Buffer;
  pictureKey: string;
};

export type DecisionBatch = {
  pictureKey: string;
  png: Buffer;
  items: SecondReaderItem[];
};

function parseCutoffValue(raw: unknown, fallback: number): number | null {
  if (raw === null) return null;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    return raw;
  }
  return fallback;
}

/**
 * Reads the two second-reader cut-offs from data/cutoffs.json.
 * Falls back to 0.90 and 0.30 when the file is missing or invalid.
 */
export async function loadCutoffs(
  filePath = DEFAULT_CUTOFFS_PATH,
): Promise<SecondReaderCutoffs> {
  try {
    const text = await readFile(/* turbopackIgnore: true */ filePath, "utf-8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_CUTOFFS };
    }
    const record = parsed as Record<string, unknown>;
    return {
      upper: parseCutoffValue(record.upper, DEFAULT_CUTOFFS.upper!),
      lower: parseCutoffValue(record.lower, DEFAULT_CUTOFFS.lower!),
    };
  } catch {
    return { ...DEFAULT_CUTOFFS };
  }
}

/**
 * Maps a Decision 1 yes-probability into one of the three section F classes:
 * - probability >= upper -> "agrees" ("Not proven", no question)
 * - probability < lower -> "disagrees" ("Needs your eye", marked in red)
 * - between cut-offs (including equal to lower) or missing -> "unsure" ("Needs your eye")
 */
export function classifyProbability(
  probability: number | null,
  cutoffs: SecondReaderCutoffs = DEFAULT_CUTOFFS,
): SecondReaderVerdict {
  if (probability === null || !Number.isFinite(probability)) {
    return "unsure";
  }
  if (cutoffs.upper !== null && probability >= cutoffs.upper) {
    return "agrees";
  }
  if (cutoffs.lower !== null && probability < cutoffs.lower) {
    return "disagrees";
  }
  return "unsure";
}

export function buildDecisionInstruction(item: {
  label: string;
  value: string;
  colIndex: 0 | 1;
}): string {
  const side = item.colIndex === 0 ? "left" : "right";
  return `Is the value ${item.value} printed for the row '${item.label}' in the ${side} column?`;
}

/**
 * Groups questions by picture (preserving first-seen picture order) and chunks
 * each picture's questions into batches of at most 20.
 */
export function groupAndBatchItems(
  items: readonly SecondReaderItem[],
  maxPerBatch = MAX_DECISION_QUESTIONS,
): DecisionBatch[] {
  const limit = Math.max(1, Math.floor(maxPerBatch));
  const groupsByKey = new Map<
    string,
    { pictureKey: string; png: Buffer; items: SecondReaderItem[] }
  >();

  for (const item of items) {
    let group = groupsByKey.get(item.pictureKey);
    if (!group) {
      group = {
        pictureKey: item.pictureKey,
        png: item.png,
        items: [],
      };
      groupsByKey.set(item.pictureKey, group);
    }
    group.items.push(item);
  }

  const batches: DecisionBatch[] = [];
  for (const group of groupsByKey.values()) {
    for (let i = 0; i < group.items.length; i += limit) {
      batches.push({
        pictureKey: group.pictureKey,
        png: group.png,
        items: group.items.slice(i, i + limit),
      });
    }
  }

  return batches;
}

export class DecisionCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Record<string, number>>();

  constructor(maxEntries = 400) {
    this.maxEntries = maxEntries;
  }

  get(key: string): Record<string, number> | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, answers: Record<string, number>): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, answers);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const globalForDecisionCache = globalThis as typeof globalThis & {
  __addsUpDecisionCache?: DecisionCache;
};

export function getGlobalDecisionCache(): DecisionCache {
  if (!globalForDecisionCache.__addsUpDecisionCache) {
    globalForDecisionCache.__addsUpDecisionCache = new DecisionCache();
  }
  return globalForDecisionCache.__addsUpDecisionCache;
}

export function computeDecisionBatchCacheKey(
  pictureKey: string,
  questions: readonly DecisionQuestion[],
): string {
  const hash = createHash("sha256");
  hash.update(GEMINI_DECISION_MODEL);
  hash.update(":");
  hash.update(pictureKey);
  hash.update(":");
  hash.update(
    JSON.stringify(questions.map((q) => [q.id, q.instructions])),
  );
  return hash.digest("hex");
}

function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (outerSignal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const controller = new AbortController();
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    };

    const onOuterAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };

    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      controller.abort();
      reject(new Error("Second reader request timed out."));
    }, timeoutMs);

    run(controller.signal).then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export type RecheckNumbersOptions = {
  items: readonly SecondReaderItem[];
  client: GeminiClient;
  cutoffs?: SecondReaderCutoffs;
  cache?: DecisionCache;
  rateLimiter?: RateLimiter;
  browserId?: string;
  ip?: string;
  timeoutMs?: number;
  bypassCache?: boolean;
  testContext?: FakeDecideContext;
  signal?: AbortSignal;
};

/**
 * Runs the second reader (gemini-decision-1) on the given items, grouped by
 * picture and batched into requests of at most 20 questions each.
 * Uses memory caching and the unit 3 rate limits (1 request = 1 model call).
 * A failed batch marks ONLY its own numbers as "Needs your eye" ("unsure").
 */
export async function recheckNumbers(
  options: RecheckNumbersOptions,
): Promise<SecondReaderResult> {
  const {
    items,
    client,
    cutoffs = DEFAULT_CUTOFFS,
    cache,
    rateLimiter,
    browserId = "anonymous",
    ip = "unknown",
    timeoutMs = getReadTimeoutMs(),
    bypassCache = false,
    testContext,
    signal,
  } = options;

  if (items.length === 0) {
    return {
      results: [],
      cutoffs,
      modelCalls: 0,
      fromCache: false,
      failedBatches: 0,
      rateLimited: false,
    };
  }

  const batches = groupAndBatchItems(items, MAX_DECISION_QUESTIONS);

  type PreparedBatch = {
    batch: DecisionBatch;
    questions: DecisionQuestion[];
    cacheKey: string;
    cachedAnswers?: Record<string, number>;
  };

  const prepared: PreparedBatch[] = batches.map((batch) => {
    const questions: DecisionQuestion[] = batch.items.map((item, idx) => ({
      id: `q${String(idx + 1).padStart(2, "0")}`,
      instructions: buildDecisionInstruction(item),
      rowLabel: item.label,
      colIndex: item.colIndex,
    }));
    const cacheKey = computeDecisionBatchCacheKey(batch.pictureKey, questions);
    const cachedAnswers = !bypassCache ? cache?.get(cacheKey) : undefined;
    return { batch, questions, cacheKey, cachedAnswers };
  });

  const uncachedCount = prepared.filter((entry) => !entry.cachedAnswers).length;

  const mapBatchAnswers = (
    entry: PreparedBatch,
    answers: Record<string, number>,
  ): SecondReaderCellResult[] =>
    entry.batch.items.map((item, idx) => {
      const qId = entry.questions[idx].id;
      const prob = answers[qId];
      if (typeof prob !== "number" || !Number.isFinite(prob)) {
        return {
          rowIndex: item.rowIndex,
          colIndex: item.colIndex,
          probability: null,
          verdict: "unsure",
          failed: true,
        };
      }
      return {
        rowIndex: item.rowIndex,
        colIndex: item.colIndex,
        probability: prob,
        verdict: classifyProbability(prob, cutoffs),
        failed: false,
      };
    });

  const mapBatchFailed = (entry: PreparedBatch): SecondReaderCellResult[] =>
    entry.batch.items.map((item) => ({
      rowIndex: item.rowIndex,
      colIndex: item.colIndex,
      probability: null,
      verdict: "unsure",
      failed: true,
    }));

  if (uncachedCount === 0) {
    const results = prepared.flatMap((entry) =>
      mapBatchAnswers(entry, entry.cachedAnswers!),
    );
    return {
      results,
      cutoffs,
      modelCalls: 0,
      fromCache: true,
      failedBatches: 0,
      rateLimited: false,
    };
  }

  if (!client.decideQuestions) {
    const results = prepared.flatMap((entry) =>
      entry.cachedAnswers
        ? mapBatchAnswers(entry, entry.cachedAnswers)
        : mapBatchFailed(entry),
    );
    return {
      results,
      cutoffs,
      modelCalls: 0,
      fromCache: false,
      failedBatches: uncachedCount,
      rateLimited: false,
    };
  }

  if (rateLimiter) {
    const decision = rateLimiter.checkAndConsumeRequest({
      browserId,
      ip,
      plannedModelCalls: uncachedCount,
    });
    if (!decision.allowed) {
      const results = prepared.flatMap((entry) =>
        entry.cachedAnswers
          ? mapBatchAnswers(entry, entry.cachedAnswers)
          : mapBatchFailed(entry),
      );
      return {
        results,
        cutoffs,
        modelCalls: 0,
        fromCache: false,
        failedBatches: uncachedCount,
        rateLimited: true,
      };
    }
  }

  const decideFn = client.decideQuestions.bind(client);
  let modelCalls = 0;
  let failedBatches = 0;

  const batchResults = await Promise.all(
    prepared.map(async (entry): Promise<SecondReaderCellResult[]> => {
      if (entry.cachedAnswers) {
        return mapBatchAnswers(entry, entry.cachedAnswers);
      }

      try {
        // Count this call against the daily cap. A refused batch makes no call.
        rateLimiter?.reserveModelCall();
        modelCalls += 1;
        const answers = await withTimeout(
          (attemptSignal) =>
            decideFn({
              png: entry.batch.png,
              questions: entry.questions,
              signal: attemptSignal,
              testContext,
            }),
          timeoutMs,
          signal,
        );

        const cellResults = mapBatchAnswers(entry, answers);
        const allAnswered = cellResults.every((cell) => !cell.failed);
        if (allAnswered && cache && !bypassCache) {
          cache.set(entry.cacheKey, answers);
        }
        return cellResults;
      } catch {
        failedBatches += 1;
        return mapBatchFailed(entry);
      }
    }),
  );

  return {
    results: batchResults.flat(),
    cutoffs,
    modelCalls,
    fromCache: false,
    failedBatches,
    rateLimited: false,
  };
}

function formatNumberFallback(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    value,
  );
}

type AlignedNumberRow = {
  numberRowIndex: number;
  label: string;
  rawValues: [string, string];
  numbers: [number | null, number | null];
  unread: [boolean, boolean];
};

function alignNumberRows(
  statement: Statement,
  readingResult: StatementReadingResult,
): AlignedNumberRow[] {
  if (readingResult.comparison.rows.length > 0) {
    const compByStmtIdx = new Map<number, RowComparison>();
    for (const rowComp of readingResult.comparison.rows) {
      compByStmtIdx.set(rowComp.statementRowIndex, rowComp);
    }

    const aligned: AlignedNumberRow[] = [];
    let numberRowIndex = 0;

    for (let i = 0; i < statement.rows.length; i += 1) {
      const stmtRow = statement.rows[i];
      if (stmtRow.kind !== "number") continue;

      const comp = compByStmtIdx.get(i);
      const leftCell = comp?.cells[0];
      const rightCell = comp?.cells[1];
      const leftRead = comp?.readRow?.cells[0];
      const rightRead = comp?.readRow?.cells[1];

      const leftNum = leftCell ? leftCell.read : null;
      const rightNum = rightCell ? rightCell.read : null;
      const leftUnread = leftCell ? leftCell.unread || leftCell.hidden : false;
      const rightUnread = rightCell
        ? rightCell.unread || rightCell.hidden
        : false;

      const leftRaw =
        leftRead?.raw || (leftNum !== null ? formatNumberFallback(leftNum) : "");
      const rightRaw =
        rightRead?.raw ||
        (rightNum !== null ? formatNumberFallback(rightNum) : "");

      aligned.push({
        numberRowIndex,
        label: stmtRow.label,
        rawValues: [leftRaw, rightRaw],
        numbers: [leftNum, rightNum],
        unread: [leftUnread, rightUnread],
      });
      numberRowIndex += 1;
    }

    return aligned;
  }

  return readingResult.rows.map((readRow, idx) => ({
    numberRowIndex: idx,
    label: readRow.label,
    rawValues: [readRow.cells[0].raw, readRow.cells[1].raw],
    numbers: [readRow.cells[0].number, readRow.cells[1].number],
    unread: [readRow.cells[0].hidden, readRow.cells[1].hidden],
  }));
}

export type RecheckStatementOptions = {
  statement: Statement;
  readingResult: StatementReadingResult;
  proof?: TwoColumnProof;
  client: GeminiClient;
  cutoffs?: SecondReaderCutoffs;
  cache?: DecisionCache;
  rateLimiter?: RateLimiter;
  browserId?: string;
  ip?: string;
  timeoutMs?: number;
  bypassCache?: boolean;
  testContext?: FakeDecideContext;
  signal?: AbortSignal;
};

/**
 * Finds every number outside every total ("not_proven") on a statement,
 * maps each number to the <=12-row strip picture that holds it, groups
 * questions by picture, and sends batches of at most 20 to gemini-decision-1.
 */
export async function recheckStatementNumbers(
  options: RecheckStatementOptions,
): Promise<SecondReaderResult> {
  const {
    statement,
    readingResult,
    client,
    cutoffs,
    cache,
    rateLimiter,
    browserId,
    ip,
    timeoutMs,
    bypassCache,
    testContext,
    signal,
  } = options;

  const resolvedCutoffs = cutoffs ?? (await loadCutoffs());
  const alignedRows = alignNumberRows(statement, readingResult);
  const proof =
    options.proof ??
    proveColumns(
      alignedRows.map((row) => row.numbers[0]),
      alignedRows.map((row) => row.numbers[1]),
      { unreadMask: alignedRows.map((row) => row.unread) },
    );

  // Collect ONLY cells outside every total ("not_proven"). Never send proven numbers (F9).
  const targets: Array<{
    rowIndex: number;
    colIndex: 0 | 1;
    label: string;
    value: string;
  }> = [];

  for (const row of alignedRows) {
    const idx = row.numberRowIndex;
    const leftStatus = proof.left.cellStatuses[idx];
    const rightStatus = proof.right.cellStatuses[idx];

    if (leftStatus === "not_proven" && row.numbers[0] !== null) {
      targets.push({
        rowIndex: idx,
        colIndex: 0,
        label: row.label,
        value: row.rawValues[0] || formatNumberFallback(row.numbers[0]),
      });
    }
    if (rightStatus === "not_proven" && row.numbers[1] !== null) {
      targets.push({
        rowIndex: idx,
        colIndex: 1,
        label: row.label,
        value: row.rawValues[1] || formatNumberFallback(row.numbers[1]),
      });
    }
  }

  // Case F2: no number outside every total -> no request.
  if (targets.length === 0) {
    return {
      results: [],
      cutoffs: resolvedCutoffs,
      modelCalls: 0,
      fromCache: false,
      failedBatches: 0,
      rateLimited: false,
    };
  }

  const rowStrips = splitStatementIntoStrips(statement);
  const stripIndexByNumberRow = new Map<number, number>();
  let seenNumberRows = 0;
  for (let stripIdx = 0; stripIdx < rowStrips.length; stripIdx += 1) {
    for (const row of rowStrips[stripIdx]) {
      if (row.kind === "number") {
        stripIndexByNumberRow.set(seenNumberRows, stripIdx);
        seenNumberRows += 1;
      }
    }
  }

  const stripPictureCache = new Map<
    number,
    { png: Buffer; pictureKey: string }
  >();
  const getStripPicture = (stripIdx: number) => {
    let cached = stripPictureCache.get(stripIdx);
    if (!cached) {
      const stripRows = rowStrips[stripIdx] ?? statement.rows;
      const png = drawStatementPng(statement, { rows: stripRows });
      cached = { png, pictureKey: computePictureCacheKey([png]) };
      stripPictureCache.set(stripIdx, cached);
    }
    return cached;
  };

  const items: SecondReaderItem[] = targets.map((target) => {
    const stripIdx = stripIndexByNumberRow.get(target.rowIndex) ?? 0;
    const { png, pictureKey } = getStripPicture(stripIdx);
    return {
      rowIndex: target.rowIndex,
      colIndex: target.colIndex,
      label: target.label,
      value: target.value,
      columnName: statement.columns[target.colIndex],
      png,
      pictureKey,
    };
  });

  return recheckNumbers({
    items,
    client,
    cutoffs: resolvedCutoffs,
    cache,
    rateLimiter,
    browserId,
    ip,
    timeoutMs,
    bypassCache,
    testContext,
    signal,
  });
}
