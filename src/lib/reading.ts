import { createHash } from "node:crypto";
import { drawStatementPng } from "@/lib/draw-statement";
import {
  getCauseModelName,
  READING_PROMPT,
  type CauseGroupRow,
  type ExplainCauseRequest,
  type GeminiClient,
} from "@/lib/gemini";
import { logServerError, MODEL_FAILED_MESSAGE } from "@/lib/public-errors";
import { RateLimitError, type RateLimiter } from "@/lib/rate-limit";
import type { SecondReaderResult } from "@/lib/second-reader-types";
import {
  parseNumberCell,
  type Statement,
  type StatementNumberRow,
  type StatementRow,
} from "@/lib/statements";
import {
  countStatementStrips,
  MAX_NUMBER_ROWS_PER_PICTURE,
  splitStatementIntoStrips,
} from "@/lib/strips";

export {
  countStatementStrips,
  MAX_NUMBER_ROWS_PER_PICTURE,
  splitStatementIntoStrips,
};

export const DEFAULT_READ_TIMEOUT_MS = 12_000;

export function getReadTimeoutMs(): number {
  const raw = process.env.ADDS_UP_READ_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_READ_TIMEOUT_MS;
}

export type ReadCell = {
  raw: string;
  number: number | null;
  hidden: boolean;
};

export type ReadRow = {
  label: string;
  cells: [ReadCell, ReadCell];
};

export type CellComparison = {
  expected: number | null;
  read: number | null;
  hidden: boolean;
  unread: boolean;
  matches: boolean;
};

export type RowComparison = {
  statementRowIndex: number;
  label: string;
  readRow: ReadRow | null;
  unread: boolean;
  cells: [CellComparison, CellComparison];
};

export type ReadingComparison = {
  totalStatementNumbers: number;
  readCount: number;
  matchCount: number;
  unreadCount: number;
  rows: RowComparison[];
};

export type StatementReadingResult = {
  rows: ReadRow[];
  comparison: ReadingComparison;
  fromCache: boolean;
  usedRepeat: boolean;
  modelCalls: number;
};

export type ReadingProgressEvent =
  | { type: "started"; totalNumbers: number; totalStrips: number }
  | {
      type: "strip_done";
      strip: number;
      completedStrips?: number;
      totalStrips: number;
      numbersRead: number;
      totalNumbers: number;
    }
  | { type: "slow"; strip: number; totalStrips: number; timeoutMs: number }
  | { type: "done"; result: StatementReadingResult; modPictureKey?: string }
  | { type: "bad_upload"; fileName: string; rowCount: number }
  | { type: "recheck"; recheck: SecondReaderResult }
  | {
      type: "error";
      code: "timeout" | "rate_limit" | "missing_key" | "failed";
      message: string;
      strip?: number;
      totalStrips?: number;
    };

export class ReadingTimeoutError extends Error {
  readonly strip?: number;
  readonly totalStrips?: number;

  constructor(message: string, strip?: number, totalStrips?: number) {
    super(message);
    this.name = "ReadingTimeoutError";
    this.strip = strip;
    this.totalStrips = totalStrips;
  }
}

export class ReadingFailedError extends Error {
  readonly strip?: number;
  readonly totalStrips?: number;

  constructor(message: string, strip?: number, totalStrips?: number) {
    super(message);
    this.name = "ReadingFailedError";
    this.strip = strip;
    this.totalStrips = totalStrips;
  }
}

export function parseReadCell(raw: string): ReadCell {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { raw: "", number: null, hidden: false };
  }
  if (/^\[?hidden\]?$/i.test(trimmed)) {
    return { raw: "HIDDEN", number: null, hidden: true };
  }
  const parsed = parseNumberCell(trimmed);
  return {
    raw: trimmed,
    number: parsed.number,
    hidden: false,
  };
}

export function parseReadingReply(text: string): ReadRow[] {
  const rows: ReadRow[] = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) continue;

    // Allow markdown-bordered table rows like `| Cash | 100 | 200 |`
    // without breaking unbordered rows with an empty trailing cell `Cash | 100 |`.
    if (line.startsWith("|") && line.endsWith("|") && line.length > 1) {
      line = line.slice(1, -1).trim();
    }

    const parts = line.split("|");
    // A valid row must contain at least two bars (three fields).
    if (parts.length < 3) continue;

    const rightRaw = parts[parts.length - 1].trim();
    const leftRaw = parts[parts.length - 2].trim();
    const label = parts.slice(0, -2).join("|").trim();
    if (!label) continue;

    // Ignore markdown separator rows like `--- | --- | ---`.
    if (
      /^[-:\s]+$/.test(label) &&
      /^[-:\s]*$/.test(leftRaw) &&
      /^[-:\s]*$/.test(rightRaw)
    ) {
      continue;
    }

    rows.push({
      label,
      cells: [parseReadCell(leftRaw), parseReadCell(rightRaw)],
    });
  }

  return rows;
}

export function countStatementNumbers(rows: StatementRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.kind !== "number") continue;
    if (row.numbers[0] !== null) total += 1;
    if (row.numbers[1] !== null) total += 1;
  }
  return total;
}

export function countReadNumbers(rows: ReadRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.cells[0].number !== null) total += 1;
    if (row.cells[1].number !== null) total += 1;
  }
  return total;
}

export function splitStatementForReading(
  statement: Statement,
  maxNumberRows = MAX_NUMBER_ROWS_PER_PICTURE,
): StatementRow[][] {
  return splitStatementIntoStrips(statement, maxNumberRows);
}

export function joinStripReadings(strips: ReadRow[][]): ReadRow[] {
  return strips.flat();
}

export function joinHalfReadings(halfA: ReadRow[], halfB: ReadRow[]): ReadRow[] {
  return joinStripReadings([halfA, halfB]);
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function labelSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const wordsA = new Set(a.split(" ").filter(Boolean));
  const wordsB = new Set(b.split(" ").filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let shared = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) shared += 1;
  }

  return (2 * shared) / (wordsA.size + wordsB.size);
}

function pairScore(stmtRow: StatementNumberRow, readRow: ReadRow): number {
  const normStmt = normalizeLabel(stmtRow.label);
  const normRead = normalizeLabel(readRow.label);

  let labelScore = 0;
  if (normStmt === normRead) {
    labelScore = 100;
  } else {
    const similarity = labelSimilarity(normStmt, normRead);
    if (similarity >= 0.7) {
      labelScore = Math.round(similarity * 80);
    }
  }

  if (labelScore === 0) {
    return -1;
  }

  // Value-match bonus disambiguates repeated labels (e.g. two "Marketable securities" rows).
  let valueBonus = 0;
  for (const col of [0, 1] as const) {
    const expected = stmtRow.numbers[col];
    const actual = readRow.cells[col].number;
    if (expected !== null && actual !== null && expected === actual) {
      valueBonus += 15;
    }
  }

  return labelScore + valueBonus;
}

export function compareReadingWithStatement(
  statement: Statement,
  readRows: ReadRow[],
): ReadingComparison {
  const stmtNumberEntries: Array<{
    statementRowIndex: number;
    row: StatementNumberRow;
  }> = [];

  for (let i = 0; i < statement.rows.length; i += 1) {
    const row = statement.rows[i];
    if (row.kind === "number") {
      stmtNumberEntries.push({ statementRowIndex: i, row });
    }
  }

  const m = stmtNumberEntries.length;
  const n = readRows.length;

  // Order-preserving sequence alignment (DP) so a missing row stays unread
  // and never shifts subsequent rows.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  // Choice: 0 = skip stmt row, 1 = skip read row, 2 = match (i, j)
  const choice: Uint8Array[] = Array.from(
    { length: m + 1 },
    () => new Uint8Array(n + 1),
  );

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      let best = dp[i - 1][j];
      let bestChoice = 0;

      if (dp[i][j - 1] > best) {
        best = dp[i][j - 1];
        bestChoice = 1;
      }

      const score = pairScore(stmtNumberEntries[i - 1].row, readRows[j - 1]);
      if (score > 0 && dp[i - 1][j - 1] + score > best) {
        best = dp[i - 1][j - 1] + score;
        bestChoice = 2;
      }

      dp[i][j] = best;
      choice[i][j] = bestChoice;
    }
  }

  const matchedReadForStmt = new Array<ReadRow | null>(m).fill(null);
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    const c = choice[i][j];
    if (c === 2) {
      matchedReadForStmt[i - 1] = readRows[j - 1];
      i -= 1;
      j -= 1;
    } else if (c === 1) {
      j -= 1;
    } else {
      i -= 1;
    }
  }

  let totalStatementNumbers = 0;
  let readCount = 0;
  let matchCount = 0;
  let unreadCount = 0;
  const rows: RowComparison[] = [];

  for (let idx = 0; idx < m; idx += 1) {
    const { statementRowIndex, row } = stmtNumberEntries[idx];
    const readRow = matchedReadForStmt[idx];

    const cells: [CellComparison, CellComparison] = [0, 1].map((colIndex) => {
      const col = colIndex as 0 | 1;
      const expected = row.numbers[col];
      const readCell = readRow ? readRow.cells[col] : null;
      const readVal = readCell ? readCell.number : null;
      const hidden = readCell ? readCell.hidden : false;

      if (expected !== null) {
        totalStatementNumbers += 1;
      }

      if (!readRow) {
        if (expected !== null) {
          unreadCount += 1;
        }
        return {
          expected,
          read: null,
          hidden: false,
          unread: expected !== null,
          matches: false,
        };
      }

      if (readVal !== null) {
        readCount += 1;
      } else if (expected !== null) {
        unreadCount += 1;
      }

      const matches = expected !== null && readVal !== null && expected === readVal;
      if (matches) {
        matchCount += 1;
      }

      return {
        expected,
        read: readVal,
        hidden,
        unread: expected !== null && readVal === null,
        matches,
      };
    }) as [CellComparison, CellComparison];

    rows.push({
      statementRowIndex,
      label: row.label,
      readRow,
      unread: readRow === null,
      cells,
    });
  }

  return {
    totalStatementNumbers,
    readCount,
    matchCount,
    unreadCount,
    rows,
  };
}

export function computePictureCacheKey(pictures: Buffer[]): string {
  const hash = createHash("sha256");
  hash.update(String(pictures.length));
  hash.update(":");
  for (const picture of pictures) {
    hash.update(String(picture.length));
    hash.update(":");
    hash.update(picture);
  }
  return hash.digest("hex");
}

export class ReadingCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, ReadRow[]>();

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  get(key: string): ReadRow[] | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    // Refresh recency
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, rows: ReadRow[]): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, rows);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const globalForCache = globalThis as typeof globalThis & {
  __addsUpReadingCache?: ReadingCache;
};

export function getGlobalReadingCache(): ReadingCache {
  if (!globalForCache.__addsUpReadingCache) {
    globalForCache.__addsUpReadingCache = new ReadingCache();
  }
  return globalForCache.__addsUpReadingCache;
}

export type SpeedRuleOptions = {
  call: (attempt: 1 | 2, signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
  signal?: AbortSignal;
  strip?: number;
  totalStrips?: number;
  onSlow?: () => void;
  onModelCall?: () => void;
};

export type SpeedRuleOutcome = {
  rows: ReadRow[];
  usedRepeat: boolean;
  timedOutFirst: boolean;
  modelCalls: number;
};

export function readPictureWithSpeedRule(
  options: SpeedRuleOptions,
): Promise<SpeedRuleOutcome> {
  const {
    call,
    timeoutMs,
    signal: outerSignal,
    strip,
    totalStrips,
    onSlow,
    onModelCall,
  } = options;

  return new Promise<SpeedRuleOutcome>((resolve, reject) => {
    if (outerSignal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let settled = false;
    let repeatStarted = false;
    let timedOutFirst = false;
    let modelCalls = 0;
    let activeAttempts = 0;
    let lastError: unknown = null;

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
      resolve({
        rows,
        usedRepeat: repeatStarted,
        timedOutFirst,
        modelCalls,
      });
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
              : new ReadingFailedError(
                  "Could not read the balance sheet picture.",
                  strip,
                  totalStrips,
                ),
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

          // E10: empty reply or reply with no row lines counts as a failed call.
          activeAttempts -= 1;
          lastError = new ReadingFailedError(
            "The model returned no readable balance sheet rows.",
            strip,
            totalStrips,
          );

          if (!repeatStarted) {
            if (firstTimer !== null) {
              clearTimeout(firstTimer);
              firstTimer = null;
            }
            startRepeat(false);
          } else if (activeAttempts === 0) {
            finishFailure(
              lastError instanceof Error
                ? lastError
                : new ReadingFailedError(
                    "The model returned no readable balance sheet rows.",
                    strip,
                    totalStrips,
                  ),
            );
          }
        })
        .catch((error: unknown) => {
          if (settled) return;
          activeAttempts -= 1;
          lastError = error;

          if (!repeatStarted) {
            if (firstTimer !== null) {
              clearTimeout(firstTimer);
              firstTimer = null;
            }
            startRepeat(false);
          } else if (activeAttempts === 0) {
            // The model's own error text can name keys or settings. Log it here and
            // give the visitor a plain sentence.
            logServerError("reading a balance sheet picture", error);
            finishFailure(
              new ReadingFailedError(
                MODEL_FAILED_MESSAGE,
                strip,
                totalStrips,
              ),
            );
          }
        });
    };

    const startRepeat = (fromTimeout: boolean) => {
      if (settled || repeatStarted) return;
      repeatStarted = true;
      if (fromTimeout) {
        timedOutFirst = true;
        onSlow?.();
      }
      secondTimer = setTimeout(() => {
        finishFailure(
          new ReadingTimeoutError(
            "A model did not answer within 12 seconds. Nothing was guessed.",
            strip,
            totalStrips,
          ),
        );
      }, timeoutMs);
      startAttempt(2);
    };

    firstTimer = setTimeout(() => {
      startRepeat(true);
    }, timeoutMs);

    startAttempt(1);
  });
}

export type ReadStatementOptions = {
  statement: Statement;
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

export async function readStatementPictures(
  options: ReadStatementOptions,
): Promise<StatementReadingResult> {
  const {
    statement,
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

  const rowStrips = splitStatementIntoStrips(statement);
  const parts = rowStrips.map((rows, index) => ({
    strip: index + 1,
    rows,
    png: drawStatementPng(statement, { rows }),
  }));

  const totalNumbers = countStatementNumbers(statement.rows);
  const totalStrips = parts.length;
  const cacheKey = computePictureCacheKey(parts.map((part) => part.png));

  // E11 & E12: check memory cache first; a cached reading costs no model call
  // and does not count against rate limits.
  if (cache && !bypassCache) {
    const cachedRows = cache.get(cacheKey);
    if (cachedRows) {
      const comparison = compareReadingWithStatement(statement, cachedRows);
      const result: StatementReadingResult = {
        rows: cachedRows,
        comparison,
        fromCache: true,
        usedRepeat: false,
        modelCalls: 0,
      };
      onProgress?.({ type: "done", result });
      return result;
    }
  }

  // Enforce rate limits before making any model call.
  if (rateLimiter) {
    const decision = rateLimiter.checkAndConsumeRequest({
      browserId,
      ip,
      plannedModelCalls: parts.length,
    });
    if (!decision.allowed) {
      throw new RateLimitError(
        decision.message,
        decision.reason,
        decision.retryAfterSeconds,
      );
    }
  }

  onProgress?.({ type: "started", totalNumbers, totalStrips });

  let numbersReadSoFar = 0;
  let completedStripsCount = 0;
  let slowEmitted = false;

  const partPromises = parts.map((part) => {
    const stripNumber = part.strip;
    return readPictureWithSpeedRule({
      timeoutMs,
      signal,
      strip: stripNumber,
      totalStrips,
      onModelCall: () => {
        rateLimiter?.reserveModelCall();
      },
      onSlow: () => {
        if (!slowEmitted) {
          slowEmitted = true;
          onProgress?.({
            type: "slow",
            strip: stripNumber,
            totalStrips,
            timeoutMs,
          });
        }
      },
      call: (attempt, attemptSignal) =>
        client.readPicture({
          png: part.png,
          prompt: READING_PROMPT,
          signal: attemptSignal,
          testContext: {
            statement,
            rows: part.rows,
            strip: stripNumber,
            totalStrips,
            slow,
            attempt,
            timeoutMs,
          },
        }),
    }).then((outcome) => {
      completedStripsCount += 1;
      numbersReadSoFar = Math.min(
        totalNumbers,
        numbersReadSoFar + countReadNumbers(outcome.rows),
      );
      onProgress?.({
        type: "strip_done",
        strip: stripNumber,
        completedStrips: completedStripsCount,
        totalStrips,
        numbersRead: numbersReadSoFar,
        totalNumbers,
      });
      return outcome;
    });
  });

  const outcomes = await Promise.all(partPromises);

  const joinedRows = joinStripReadings(outcomes.map((outcome) => outcome.rows));

  const usedRepeat = outcomes.some((outcome) => outcome.usedRepeat);
  const modelCalls = outcomes.reduce((sum, outcome) => sum + outcome.modelCalls, 0);

  if (cache) {
    cache.set(cacheKey, joinedRows);
    for (let i = 0; i < parts.length; i += 1) {
      const stripKey = computePictureCacheKey([parts[i].png]);
      cache.set(stripKey, outcomes[i].rows);
    }
  }

  const comparison = compareReadingWithStatement(statement, joinedRows);
  const result: StatementReadingResult = {
    rows: joinedRows,
    comparison,
    fromCache: false,
    usedRepeat,
    modelCalls,
  };

  onProgress?.({ type: "done", result });
  return result;
}

export type StatementModification =
  | {
      kind: "hide";
      /** 0-based index among statement number rows */
      numberRowIndex: number;
      colIndex: 0 | 1;
    }
  | {
      kind: "change";
      /** 0-based index among statement number rows */
      numberRowIndex: number;
      colIndex: 0 | 1;
      /** Formatted display value printed on the picture */
      newValue: string;
    };

export type ReadModifiedStatementOptions = {
  statement: Statement;
  modification: StatementModification;
  /** Earlier full reading rows used as fallback if an unaffected strip is no longer in server cache */
  previousRows?: ReadRow[];
  client: GeminiClient;
  cache?: ReadingCache;
  rateLimiter?: RateLimiter;
  browserId?: string;
  ip?: string;
  timeoutMs?: number;
  bypassCache?: boolean;
  signal?: AbortSignal;
  onProgress?: (event: ReadingProgressEvent) => void;
};

export type ModifiedReadingResult = StatementReadingResult & {
  usedWholePictureFallback: boolean;
};

export function findStatementRowIndexForNumberRow(
  statement: Statement,
  numberRowIndex: number,
): number {
  let seen = 0;
  for (let i = 0; i < statement.rows.length; i += 1) {
    if (statement.rows[i].kind === "number") {
      if (seen === numberRowIndex) return i;
      seen += 1;
    }
  }
  return -1;
}

function locateTargetInStrips(
  rowStrips: StatementRow[][],
  numberRowIndex: number,
): { stripIndex: number; rowIndexInStrip: number } | null {
  let seenNumbers = 0;
  for (let s = 0; s < rowStrips.length; s += 1) {
    const stripRows = rowStrips[s];
    for (let r = 0; r < stripRows.length; r += 1) {
      if (stripRows[r].kind === "number") {
        if (seenNumbers === numberRowIndex) {
          return { stripIndex: s, rowIndexInStrip: r };
        }
        seenNumbers += 1;
      }
    }
  }
  return null;
}

function slicePreviousRowsForStrip(
  rowStrips: StatementRow[][],
  stripIndex: number,
  previousRows?: ReadRow[],
): ReadRow[] | undefined {
  if (!previousRows || previousRows.length === 0) return undefined;
  let offset = 0;
  for (let s = 0; s < rowStrips.length; s += 1) {
    const count = rowStrips[s].filter((r) => r.kind === "number").length;
    if (s === stripIndex) {
      if (previousRows.length >= offset + count) {
        return previousRows.slice(offset, offset + count);
      }
      return undefined;
    }
    offset += count;
  }
  return undefined;
}

function hasHiddenCell(rows: ReadRow[]): boolean {
  return rows.some((row) => row.cells[0].hidden || row.cells[1].hidden);
}

/**
 * Draws and reads ONLY the strip that holds the hidden or changed cell,
 * reusing earlier readings for all other strips (1 model call).
 * For a hide: if the covered strip returns no HIDDEN cell and the statement
 * has more than one strip, falls back once to reading the whole statement
 * as a single picture and uses that.
 */
export async function readStatementWithModification(
  options: ReadModifiedStatementOptions,
): Promise<ModifiedReadingResult> {
  const {
    statement,
    modification,
    previousRows,
    client,
    cache,
    rateLimiter,
    browserId = "anonymous",
    ip = "unknown",
    timeoutMs = getReadTimeoutMs(),
    bypassCache = false,
    signal,
    onProgress,
  } = options;

  const statementRowIndex = findStatementRowIndexForNumberRow(
    statement,
    modification.numberRowIndex,
  );
  if (statementRowIndex === -1) {
    throw new ReadingFailedError("The selected balance sheet row was not found.");
  }

  const rowStrips = splitStatementIntoStrips(statement);
  const targetLocation = locateTargetInStrips(
    rowStrips,
    modification.numberRowIndex,
  );
  if (!targetLocation) {
    throw new ReadingFailedError("The selected balance sheet row was not found.");
  }

  const { stripIndex: targetStripIndex, rowIndexInStrip } = targetLocation;
  const coverCell =
    modification.kind === "hide"
      ? { rowIndex: rowIndexInStrip, colIndex: modification.colIndex }
      : undefined;
  const overrideCell =
    modification.kind === "change"
      ? {
          rowIndex: rowIndexInStrip,
          colIndex: modification.colIndex,
          value: modification.newValue,
        }
      : undefined;

  const stripParts = rowStrips.map((rows, idx) => {
    const isTarget = idx === targetStripIndex;
    const png = isTarget
      ? drawStatementPng(statement, { rows, coverCell, overrideCell })
      : drawStatementPng(statement, { rows });
    return {
      strip: idx + 1,
      rows,
      png,
      stripKey: computePictureCacheKey([png]),
      isTarget,
    };
  });

  const totalNumbers = countStatementNumbers(statement.rows);
  const totalStrips = stripParts.length;
  const combinedCacheKey = computePictureCacheKey(
    stripParts.map((part) => part.png),
  );

  // Check full modified-statement cache first (0 model calls, not counted).
  if (cache && !bypassCache) {
    const cachedFull = cache.get(combinedCacheKey);
    if (cachedFull) {
      const comparison = compareReadingWithStatement(statement, cachedFull);
      const result: ModifiedReadingResult = {
        rows: cachedFull,
        comparison,
        fromCache: true,
        usedRepeat: false,
        modelCalls: 0,
        usedWholePictureFallback: false,
      };
      onProgress?.({ type: "done", result });
      return result;
    }
  }

  // Reuse cached or previous readings for unaffected strips, and check whether
  // any strip actually needs a model call.
  const reusedByStrip = new Map<number, ReadRow[]>();
  const stripsToRead: typeof stripParts = [];
  // Rows that came from the visitor's `previousRows` are never trusted as a reading:
  // a joined result that holds any of them is not written to the shared cache.
  let usedVisitorRows = false;

  for (let i = 0; i < stripParts.length; i += 1) {
    const part = stripParts[i];
    if (!bypassCache && cache) {
      const cachedStrip = cache.get(part.stripKey);
      if (cachedStrip) {
        reusedByStrip.set(i, cachedStrip);
        continue;
      }
    }

    if (!part.isTarget) {
      const fromPrevious = slicePreviousRowsForStrip(
        rowStrips,
        i,
        previousRows,
      );
      if (fromPrevious) {
        reusedByStrip.set(i, fromPrevious);
        usedVisitorRows = true;
        continue;
      }
    }

    stripsToRead.push(part);
  }

  if (stripsToRead.length === 0) {
    const joinedRows = joinStripReadings(
      stripParts.map((_, idx) => reusedByStrip.get(idx) ?? []),
    );
    if (cache && !usedVisitorRows) {
      cache.set(combinedCacheKey, joinedRows);
    }
    const comparison = compareReadingWithStatement(statement, joinedRows);
    const result: ModifiedReadingResult = {
      rows: joinedRows,
      comparison,
      fromCache: true,
      usedRepeat: false,
      modelCalls: 0,
      usedWholePictureFallback: false,
    };
    onProgress?.({ type: "done", result });
    return result;
  }

  // Enforce rate limits before making any model call.
  if (rateLimiter) {
    const decision = rateLimiter.checkAndConsumeRequest({
      browserId,
      ip,
      plannedModelCalls: stripsToRead.length,
    });
    if (!decision.allowed) {
      throw new RateLimitError(
        decision.message,
        decision.reason,
        decision.retryAfterSeconds,
      );
    }
  }

  onProgress?.({ type: "started", totalNumbers, totalStrips: stripsToRead.length });

  let usedRepeat = false;
  let modelCalls = 0;
  let slowEmitted = false;
  let completed = 0;

  const readOutcomes = await Promise.all(
    stripsToRead.map((part) => {
      const stripIdx = part.strip - 1;
      return readPictureWithSpeedRule({
        timeoutMs,
        signal,
        strip: part.strip,
        totalStrips,
        onModelCall: () => {
          rateLimiter?.reserveModelCall();
        },
        onSlow: () => {
          if (!slowEmitted) {
            slowEmitted = true;
            onProgress?.({
              type: "slow",
              strip: part.strip,
              totalStrips,
              timeoutMs,
            });
          }
        },
        call: (attempt, attemptSignal) =>
          client.readPicture({
            png: part.png,
            prompt: READING_PROMPT,
            signal: attemptSignal,
            testContext: {
              statement,
              rows: part.rows,
              strip: part.strip,
              totalStrips,
              attempt,
              timeoutMs,
              coverCell: part.isTarget ? coverCell : undefined,
              overrideCell: part.isTarget ? overrideCell : undefined,
            },
          }),
      }).then((outcome) => {
        completed += 1;
        onProgress?.({
          type: "strip_done",
          strip: part.strip,
          completedStrips: completed,
          totalStrips: stripsToRead.length,
          numbersRead: countReadNumbers(outcome.rows),
          totalNumbers,
        });
        return { stripIdx, part, outcome };
      });
    }),
  );

  for (const { stripIdx, part, outcome } of readOutcomes) {
    reusedByStrip.set(stripIdx, outcome.rows);
    usedRepeat = usedRepeat || outcome.usedRepeat;
    modelCalls += outcome.modelCalls;
    if (cache && (!part.isTarget || modification.kind !== "hide" || hasHiddenCell(outcome.rows))) {
      cache.set(part.stripKey, outcome.rows);
    }
  }

  let joinedRows = joinStripReadings(
    stripParts.map((_, idx) => reusedByStrip.get(idx) ?? []),
  );
  let usedWholePictureFallback = false;

  // Hide fallback: if reading the covered picture returned no HIDDEN cell and
  // we had split into multiple strips, read the whole statement as one picture
  // once and use that.
  if (
    modification.kind === "hide" &&
    !hasHiddenCell(reusedByStrip.get(targetStripIndex) ?? []) &&
    rowStrips.length > 1
  ) {
    const wholeCoverCell = {
      rowIndex: statementRowIndex,
      colIndex: modification.colIndex,
    };
    const wholePng = drawStatementPng(statement, {
      coverCell: wholeCoverCell,
    });
    const wholeKey = computePictureCacheKey([wholePng]);
    const cachedWhole = !bypassCache ? cache?.get(wholeKey) : undefined;

    if (cachedWhole) {
      joinedRows = cachedWhole;
      usedWholePictureFallback = true;
    } else {
      if (rateLimiter) {
        const decision = rateLimiter.check({
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

      const wholeOutcome = await readPictureWithSpeedRule({
        timeoutMs,
        signal,
        strip: 1,
        totalStrips: 1,
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
            png: wholePng,
            prompt: READING_PROMPT,
            signal: attemptSignal,
            testContext: {
              statement,
              rows: statement.rows,
              strip: 1,
              totalStrips: 1,
              attempt,
              timeoutMs,
              coverCell: wholeCoverCell,
            },
          }),
      });

      joinedRows = wholeOutcome.rows;
      usedRepeat = usedRepeat || wholeOutcome.usedRepeat;
      modelCalls += wholeOutcome.modelCalls;
      usedWholePictureFallback = true;

      if (cache) {
        cache.set(wholeKey, joinedRows);
      }
    }
  }

  // A whole-picture fallback replaces every strip with the server's own reading, so its
  // rows no longer hold anything the visitor supplied.
  if (cache && (!usedVisitorRows || usedWholePictureFallback)) {
    cache.set(combinedCacheKey, joinedRows);
  }

  const comparison = compareReadingWithStatement(statement, joinedRows);
  const result: ModifiedReadingResult = {
    rows: joinedRows,
    comparison,
    fromCache: false,
    usedRepeat,
    modelCalls,
    usedWholePictureFallback,
  };

  onProgress?.({ type: "done", result });
  return result;
}

export class CauseCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, string>();

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
  }

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, sentence: string): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, sentence);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

const globalForCauseCache = globalThis as typeof globalThis & {
  __addsUpCauseCache?: CauseCache;
};

export function getGlobalCauseCache(): CauseCache {
  if (!globalForCauseCache.__addsUpCauseCache) {
    globalForCauseCache.__addsUpCauseCache = new CauseCache();
  }
  return globalForCauseCache.__addsUpCauseCache;
}

export function computeCauseCacheKey(
  model: string,
  request: Omit<ExplainCauseRequest, "signal" | "model">,
): string {
  const hash = createHash("sha256");
  hash.update(model);
  hash.update(":");
  hash.update(
    JSON.stringify({
      groupLabel: request.groupLabel,
      rows: request.rows,
      statedTotal: request.statedTotal,
      computedSum: request.computedSum,
      gap: request.gap,
      diff: request.diff,
    }),
  );
  return hash.digest("hex");
}

function sanitizeCauseSentence(raw: string): string | null {
  const singleLine = raw
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!singleLine) return null;
  return singleLine;
}

function callCauseWithSpeedRule(options: {
  call: (attempt: 1 | 2, signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onModelCall?: () => void;
}): Promise<{ sentence: string | null; modelCalls: number; usedRepeat: boolean }> {
  const { call, timeoutMs, signal: outerSignal, onModelCall } = options;

  return new Promise((resolve) => {
    if (outerSignal?.aborted) {
      resolve({ sentence: null, modelCalls: 0, usedRepeat: false });
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

    const finish = (sentence: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ sentence, modelCalls, usedRepeat: repeatStarted });
    };

    const onOuterAbort = () => {
      finish(null);
    };
    outerSignal?.addEventListener("abort", onOuterAbort, { once: true });

    const startRepeat = () => {
      if (settled || repeatStarted) return;
      repeatStarted = true;
      secondTimer = setTimeout(() => {
        finish(null);
      }, timeoutMs);
      startAttempt(2);
    };

    const startAttempt = (attempt: 1 | 2) => {
      try {
        onModelCall?.();
      } catch {
        // The daily cap is reached: make no call.
        if (activeAttempts === 0) finish(null);
        return;
      }
      const controller = new AbortController();
      controllers.push(controller);
      activeAttempts += 1;
      modelCalls += 1;

      void call(attempt, controller.signal)
        .then((raw) => {
          if (settled) return;
          const clean = sanitizeCauseSentence(raw);
          if (clean) {
            finish(clean);
            return;
          }
          activeAttempts -= 1;
          if (!repeatStarted) {
            if (firstTimer !== null) {
              clearTimeout(firstTimer);
              firstTimer = null;
            }
            startRepeat();
          } else if (activeAttempts === 0) {
            finish(null);
          }
        })
        .catch(() => {
          if (settled) return;
          activeAttempts -= 1;
          if (!repeatStarted) {
            if (firstTimer !== null) {
              clearTimeout(firstTimer);
              firstTimer = null;
            }
            startRepeat();
          } else if (activeAttempts === 0) {
            finish(null);
          }
        });
    };

    firstTimer = setTimeout(() => {
      startRepeat();
    }, timeoutMs);

    startAttempt(1);
  });
}

export type ExplainMismatchCauseOptions = {
  groupLabel: string;
  rows: CauseGroupRow[];
  statedTotal: number;
  computedSum: number;
  gap: number;
  diff: number;
  client: GeminiClient;
  cache?: CauseCache;
  rateLimiter?: RateLimiter;
  browserId?: string;
  ip?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ExplainMismatchCauseResult = {
  sentence: string | null;
  model: string;
  fromCache: boolean;
  modelCalls: number;
  usedRepeat: boolean;
};

/**
 * Calls the cause model (CAUSE_MODEL, defaulting to gemini-4-carbon) with a
 * 12-second timeout and one repeat. Uses memory cache and unit 3 rate limits.
 * Returns { sentence: null } when both attempts fail or limits are hit.
 */
export async function explainMismatchCause(
  options: ExplainMismatchCauseOptions,
): Promise<ExplainMismatchCauseResult> {
  const {
    groupLabel,
    rows,
    statedTotal,
    computedSum,
    gap,
    diff,
    client,
    cache,
    rateLimiter,
    browserId = "anonymous",
    ip = "unknown",
    model = getCauseModelName(),
    timeoutMs = getReadTimeoutMs(),
    signal,
  } = options;

  if (!client.explainCause) {
    return {
      sentence: null,
      model,
      fromCache: false,
      modelCalls: 0,
      usedRepeat: false,
    };
  }

  const requestPayload = {
    groupLabel,
    rows,
    statedTotal,
    computedSum,
    gap,
    diff,
  };
  const cacheKey = computeCauseCacheKey(model, requestPayload);

  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        sentence: cached,
        model,
        fromCache: true,
        modelCalls: 0,
        usedRepeat: false,
      };
    }
  }

  if (rateLimiter) {
    const decision = rateLimiter.checkAndConsumeRequest({
      browserId,
      ip,
      plannedModelCalls: 1,
    });
    if (!decision.allowed) {
      return {
        sentence: null,
        model,
        fromCache: false,
        modelCalls: 0,
        usedRepeat: false,
      };
    }
  }

  const explainFn = client.explainCause.bind(client);
  const outcome = await callCauseWithSpeedRule({
    timeoutMs,
    signal,
    onModelCall: () => {
      rateLimiter?.reserveModelCall();
    },
    call: (_attempt, attemptSignal) =>
      explainFn({
        ...requestPayload,
        model,
        signal: attemptSignal,
      }),
  });

  if (outcome.sentence && cache) {
    cache.set(cacheKey, outcome.sentence);
  }

  return {
    sentence: outcome.sentence,
    model,
    fromCache: false,
    modelCalls: outcome.modelCalls,
    usedRepeat: outcome.usedRepeat,
  };
}
