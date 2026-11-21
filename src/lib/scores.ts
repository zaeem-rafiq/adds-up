import { readFile } from "node:fs/promises";
import path from "node:path";

export const RECHECK_LABELS = [
  "90% or more",
  "70% to 90%",
  "30% to 70%",
  "Under 30%",
] as const;

export type RecheckLabel = (typeof RECHECK_LABELS)[number];

export interface StepFlags {
  A: boolean;
  B: boolean;
  C: boolean;
  D: boolean;
  E: boolean;
  F: boolean;
}

export interface HardTotals {
  numbers: number;
  readRight: number;
  wrongShownAsRight: number;
}

export interface ModelTotals {
  numbers: number;
  readRight: number;
  wrongShownAsRight: number;
  hiddenTried: number;
  hiddenRebuilt: number;
  changedTried: number;
  changedCaught: number;
  hard: HardTotals | null;
}

export interface AddsUpTotals extends ModelTotals {
  cleanPagesFlagged: number;
}

export interface PassMark {
  measure: string;
  mark: string;
  value: string;
  met: boolean | null;
}

export interface Cutoffs {
  upper: number | null;
  lower: number | null;
  setOnFilings: number;
}

export interface RecheckBucket {
  said: string;
  answers: number;
  trulyThere: number;
}

export interface ScoreFailure {
  company: string;
  step: string;
  number: string;
  shown: string;
  truth: string;
}

export interface FilingScore {
  company: string;
  cik: string;
  form: string;
  filed: string;
  numbers: number;
  readRight: number;
  wrongTicked: number;
  flagged: boolean;
  hiddenRebuilt: boolean | null;
  changedCaught: boolean | null;
  seconds: number;
}

export interface SkippedCompany {
  company: string;
  reason: string;
}

export interface ScoresFile {
  status: "running" | "done";
  startedAt: string;
  finishedAt: string | null;
  filingsPlanned: number;
  filingsScored: number;
  stepsRun: StepFlags;
  totals: {
    addsUp: AddsUpTotals;
    oneCall: ModelTotals;
  };
  outsideTotals: number;
  passMarks: PassMark[];
  cutoffs: Cutoffs | null;
  recheck: RecheckBucket[] | null;
  causes: string[];
  failures: ScoreFailure[];
  filings: FilingScore[];
  skipped: SkippedCompany[];
}

export type ScoresLoadResult =
  | { kind: "empty" }
  | { kind: "ready"; scores: ScoresFile }
  | { kind: "error"; message: string };

export interface LoadScoresOptions {
  fixtureQuery?: string | null;
  isTestMode?: boolean;
  scoresPath?: string;
  fixturesDir?: string;
}

const VALID_FIXTURES = new Set(["full", "running", "empty"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStepFlags(value: unknown): value is StepFlags {
  if (!isRecord(value)) return false;
  return (
    isBoolean(value.A) &&
    isBoolean(value.B) &&
    isBoolean(value.C) &&
    isBoolean(value.D) &&
    isBoolean(value.E) &&
    isBoolean(value.F)
  );
}

function isHardTotals(value: unknown): value is HardTotals {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.numbers) &&
    isFiniteNumber(value.readRight) &&
    isFiniteNumber(value.wrongShownAsRight)
  );
}

function isModelTotals(value: unknown): value is ModelTotals {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.numbers) &&
    isFiniteNumber(value.readRight) &&
    isFiniteNumber(value.wrongShownAsRight) &&
    isFiniteNumber(value.hiddenTried) &&
    isFiniteNumber(value.hiddenRebuilt) &&
    isFiniteNumber(value.changedTried) &&
    isFiniteNumber(value.changedCaught) &&
    (value.hard === null || isHardTotals(value.hard))
  );
}

function isAddsUpTotals(value: unknown): value is AddsUpTotals {
  if (!isRecord(value)) return false;
  return isModelTotals(value) && isFiniteNumber(value.cleanPagesFlagged);
}

function isScoresFile(value: unknown): value is ScoresFile {
  if (!isRecord(value)) return false;
  if (value.status !== "running" && value.status !== "done") return false;
  if (!isFiniteNumber(value.filingsPlanned) || !isFiniteNumber(value.filingsScored)) {
    return false;
  }
  if (!isStepFlags(value.stepsRun)) return false;
  if (!isRecord(value.totals)) return false;
  if (!isAddsUpTotals(value.totals.addsUp) || !isModelTotals(value.totals.oneCall)) {
    return false;
  }
  if (!isFiniteNumber(value.outsideTotals)) return false;
  if (!Array.isArray(value.passMarks)) return false;
  if (!Array.isArray(value.causes)) return false;
  if (!Array.isArray(value.failures)) return false;
  if (!Array.isArray(value.filings)) return false;
  if (!Array.isArray(value.skipped)) return false;
  return true;
}

export function resolveScoresPath(options: LoadScoresOptions = {}): string {
  const cwd = process.cwd();
  const isTestMode = options.isTestMode ?? process.env.ADDS_UP_TEST === "1";
  const query = options.fixtureQuery?.trim();

  if (isTestMode && query && VALID_FIXTURES.has(query)) {
    const fixturesDir =
      options.fixturesDir ?? path.join(cwd, "src", "fixtures", "scores");
    return path.join(fixturesDir, `${query}.json`);
  }

  return options.scoresPath ?? path.join(cwd, "data", "scores.json");
}

export function parseScoresText(rawText: string): ScoresLoadResult {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { kind: "empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      kind: "error",
      message: "The test results file could not be read because its JSON is not valid.",
    };
  }

  if (parsed === null) {
    return { kind: "empty" };
  }

  if (isRecord(parsed)) {
    if (Object.keys(parsed).length === 0 || parsed.status === "empty") {
      return { kind: "empty" };
    }
    if (
      parsed.status === "done" &&
      parsed.filingsScored === 0 &&
      (!Array.isArray(parsed.filings) || parsed.filings.length === 0)
    ) {
      return { kind: "empty" };
    }
  }

  if (!isScoresFile(parsed)) {
    return {
      kind: "error",
      message: "The test results file is missing required fields.",
    };
  }

  return { kind: "ready", scores: parsed };
}

export async function loadScores(
  options: LoadScoresOptions = {},
): Promise<ScoresLoadResult> {
  const filePath = resolveScoresPath(options);

  try {
    const text = await readFile(/* turbopackIgnore: true */ filePath, "utf-8");
    return parseScoresText(text);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : null;
    if (code === "ENOENT") {
      return { kind: "empty" };
    }
    return {
      kind: "error",
      message: "Could not read the test results file.",
    };
  }
}

export function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatShare(
  part: number,
  total: number,
  decimals = 1,
): string {
  if (total <= 0) return "—";
  return `${((part / total) * 100).toFixed(decimals)}%`;
}

export function formatWrongShownAsRight(
  wrong: number,
  total: number,
  stepRan: boolean,
): string {
  if (!stepRan || total <= 0) return "not run";
  if (wrong === 0) return `0 of ${formatInt(total)}`;
  return `${((wrong / total) * 100).toFixed(2)}%`;
}

export function formatCountOf(part: number, total: number): string {
  return `${formatInt(part)} of ${formatInt(total)}`;
}

export function formatCutoffPercent(cutoff: number | null): string | null {
  if (cutoff === null || !Number.isFinite(cutoff)) return null;
  const pct = cutoff <= 1 ? cutoff * 100 : cutoff;
  const rounded = Number(pct.toFixed(1));
  return `${rounded}%`;
}

export interface ComparisonRow {
  measure: string;
  note?: string;
  oneCall: string;
  addsUp: string;
  oneCallDetail?: string;
  addsUpDetail?: string;
}

export function buildComparisonRows(scores: ScoresFile): ComparisonRow[] {
  const { stepsRun, totals, filingsScored } = scores;
  const { oneCall, addsUp } = totals;

  const hardOneCall =
    stepsRun.F && oneCall.hard && oneCall.hard.numbers > 0
      ? {
          main: `${formatShare(oneCall.hard.readRight, oneCall.hard.numbers, 1)} right`,
          detail: `${formatWrongShownAsRight(oneCall.hard.wrongShownAsRight, oneCall.hard.numbers, true)} wrong shown`,
        }
      : { main: "not run", detail: undefined };

  const hardAddsUp =
    stepsRun.F && addsUp.hard && addsUp.hard.numbers > 0
      ? {
          main: `${formatShare(addsUp.hard.readRight, addsUp.hard.numbers, 1)} right`,
          detail: `${formatWrongShownAsRight(addsUp.hard.wrongShownAsRight, addsUp.hard.numbers, true)} wrong shown`,
        }
      : { main: "not run", detail: undefined };

  return [
    {
      measure: "Numbers read correctly",
      oneCall:
        stepsRun.B && oneCall.numbers > 0
          ? formatShare(oneCall.readRight, oneCall.numbers, 1)
          : "not run",
      addsUp:
        stepsRun.A && addsUp.numbers > 0
          ? formatShare(addsUp.readRight, addsUp.numbers, 1)
          : "not run",
    },
    {
      measure: "Wrong numbers shown as right",
      oneCall: formatWrongShownAsRight(
        oneCall.wrongShownAsRight,
        oneCall.numbers,
        stepsRun.B,
      ),
      addsUp: formatWrongShownAsRight(
        addsUp.wrongShownAsRight,
        addsUp.numbers,
        stepsRun.A,
      ),
    },
    {
      measure: "Clean pages flagged by mistake",
      oneCall: "Does not apply",
      addsUp: stepsRun.A
        ? formatCountOf(addsUp.cleanPagesFlagged, filingsScored)
        : "not run",
    },
    {
      measure: "Hidden numbers rebuilt",
      oneCall: stepsRun.C
        ? formatCountOf(oneCall.hiddenRebuilt, oneCall.hiddenTried)
        : "not run",
      addsUp: stepsRun.C
        ? formatCountOf(addsUp.hiddenRebuilt, addsUp.hiddenTried)
        : "not run",
    },
    {
      measure: "Changed numbers caught",
      note: "Numbers inside a group only.",
      oneCall: stepsRun.D
        ? formatCountOf(oneCall.changedCaught, oneCall.changedTried)
        : "not run",
      addsUp: stepsRun.D
        ? formatCountOf(addsUp.changedCaught, addsUp.changedTried)
        : "not run",
    },
    {
      measure: "Same test on blurred, tilted copies",
      oneCall: hardOneCall.main,
      oneCallDetail: hardOneCall.detail,
      addsUp: hardAddsUp.main,
      addsUpDetail: hardAddsUp.detail,
    },
  ];
}

export interface FormattedRecheckRow {
  said: RecheckLabel;
  answers: string;
  trulyThere: string;
}

export function buildRecheckRows(scores: ScoresFile): FormattedRecheckRow[] {
  if (!scores.stepsRun.E || !scores.recheck) {
    return RECHECK_LABELS.map((said) => ({
      said,
      answers: "not run",
      trulyThere: "not run",
    }));
  }

  const byLabel = new Map<string, RecheckBucket>();
  for (const bucket of scores.recheck) {
    byLabel.set(bucket.said.trim().toLowerCase(), bucket);
  }

  return RECHECK_LABELS.map((said) => {
    const bucket = byLabel.get(said.toLowerCase());
    if (!bucket) {
      return { said, answers: "0", trulyThere: "—" };
    }
    if (bucket.answers <= 0) {
      return { said, answers: "0", trulyThere: "—" };
    }
    const share =
      bucket.trulyThere > 0 && bucket.trulyThere < 1
        ? `${(bucket.trulyThere * 100).toFixed(1)}%`
        : `${formatShare(bucket.trulyThere, bucket.answers, 1)} (${formatInt(bucket.trulyThere)})`;
    return {
      said,
      answers: formatInt(bucket.answers),
      trulyThere: share,
    };
  });
}

export function getOutsideTotalsSummary(scores: ScoresFile): string | null {
  if (!scores.stepsRun.A || scores.totals.addsUp.numbers <= 0) {
    return null;
  }
  const share = formatShare(
    scores.outsideTotals,
    scores.totals.addsUp.numbers,
    1,
  );
  return `${share} (${formatInt(scores.outsideTotals)} of ${formatInt(scores.totals.addsUp.numbers)} numbers)`;
}
