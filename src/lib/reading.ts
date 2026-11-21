import { createHash } from "node:crypto";
import { drawStatementPng } from "@/lib/draw-statement";
import {
  READING_PROMPT,
  type GeminiClient,
} from "@/lib/gemini";
import { RateLimitError, type RateLimiter } from "@/lib/rate-limit";
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
  | { type: "done"; result: StatementReadingResult }
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
      const controller = new AbortController();
      controllers.push(controller);
      activeAttempts += 1;
      modelCalls += 1;
      onModelCall?.();

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
            const message =
              error instanceof Error
                ? error.message
                : "Could not read the balance sheet picture.";
            finishFailure(new ReadingFailedError(message, strip, totalStrips));
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
        rateLimiter?.recordModelCalls(1);
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
