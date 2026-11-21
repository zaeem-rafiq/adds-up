import { GoogleGenAI } from "@google/genai";
import type { Statement, StatementRow } from "@/lib/statements";

export const GEMINI_HYDROGEN_MODEL = "gemini-4-hydrogen";
export const GEMINI_DECISION_MODEL = "gemini-decision-1";
export const DEFAULT_CAUSE_MODEL = "gemini-4-carbon";
export const FAKE_CAUSE_SENTENCE =
  "The printed total still fits the rest of the statement, so one line in this group is off.";

export function getCauseModelName(): string {
  return process.env.CAUSE_MODEL?.trim() || DEFAULT_CAUSE_MODEL;
}

export const READING_PROMPT = [
  "Read every printed row in this balance sheet picture that has a number, a dash, or a black covered box.",
  "Output one line per row in the exact printed order, using this format:",
  "label | left value | right value",
  "",
  "Rules:",
  "- Write each number exactly as printed, including dollar signs, commas, and brackets or parentheses.",
  "- Leave a cell empty where the page shows nothing.",
  "- If a cell is covered by a black box, write HIDDEN for that cell.",
  "- Do not include section headings that have no numbers or dashes.",
  "- Output only the row lines, with no extra text.",
].join("\n");

export class GeminiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiConfigError";
  }
}

export type FakeReadContext = {
  statement: Statement;
  rows: StatementRow[];
  strip: number;
  totalStrips: number;
  slow?: boolean;
  attempt: number;
  timeoutMs: number;
  /** 0-based index within `rows` */
  coverCell?: { rowIndex: number; colIndex: 0 | 1 };
  /** 0-based index within `rows` */
  overrideCell?: { rowIndex: number; colIndex: 0 | 1; value: string };
};

export type ReadPictureRequest = {
  png: Buffer;
  prompt: string;
  signal?: AbortSignal;
  /** Context used only by the fake test-mode client; ignored by the real client. */
  testContext?: FakeReadContext;
};

export type CauseGroupRow = {
  label: string;
  value: string;
  number: number;
};

export type ExplainCauseRequest = {
  groupLabel: string;
  rows: CauseGroupRow[];
  statedTotal: number;
  computedSum: number;
  gap: number;
  diff: number;
  model?: string;
  signal?: AbortSignal;
};

export type DecisionQuestion = {
  id: string;
  instructions: string;
  /** Row label used only by the fake test-mode client. */
  rowLabel?: string;
  colIndex?: 0 | 1;
};

export type FakeDecideContext = {
  doubtLabels?: string[];
  unsureLabels?: string[];
};

export type DecideQuestionsRequest = {
  png: Buffer;
  questions: DecisionQuestion[];
  signal?: AbortSignal;
  /** Context used only by the fake test-mode client; ignored by the real client. */
  testContext?: FakeDecideContext;
};

export type GeminiClient = {
  readonly isFake: boolean;
  readPicture(request: ReadPictureRequest): Promise<string>;
  explainCause?(request: ExplainCauseRequest): Promise<string>;
  decideQuestions?(
    request: DecideQuestionsRequest,
  ): Promise<Record<string, number>>;
};

export function hasGeminiApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function buildCausePrompt(request: ExplainCauseRequest): string {
  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
  const direction =
    request.diff > 0
      ? `the rows add up to ${fmt(request.gap)} more than the stated total`
      : `the rows add up to ${fmt(request.gap)} less than the stated total`;
  const rowLines = request.rows.map(
    (row) => `- ${row.label}: ${row.value || fmt(row.number)}`,
  );

  return [
    "These rows from one balance sheet group do not add up to the stated total.",
    `Group total label: ${request.groupLabel}`,
    "Group rows:",
    ...rowLines,
    `Sum of the rows: ${fmt(request.computedSum)}`,
    `Stated total: ${fmt(request.statedTotal)}`,
    `Gap: ${fmt(request.gap)} (${direction}).`,
    "",
    "Write one plain sentence of at most 25 words explaining the likely cause of this gap. Output only that one sentence.",
  ].join("\n");
}

export function formatStatementRowsAsReply(
  rows: StatementRow[],
  options?: {
    coverCell?: { rowIndex: number; colIndex: 0 | 1 };
    overrideCell?: { rowIndex: number; colIndex: 0 | 1; value: string };
  },
): string {
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.kind !== "number") continue;
    let left = row.values[0] ?? "";
    let right = row.values[1] ?? "";
    if (options?.coverCell?.rowIndex === i) {
      if (options.coverCell.colIndex === 0) left = "HIDDEN";
      else right = "HIDDEN";
    }
    if (options?.overrideCell?.rowIndex === i) {
      if (options.overrideCell.colIndex === 0) left = options.overrideCell.value;
      else right = options.overrideCell.value;
    }
    lines.push(`${row.label} | ${left} | ${right}`);
  }
  return lines.join("\n");
}

function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createRealGeminiClient(): GeminiClient {
  let cachedAi: GoogleGenAI | null = null;

  return {
    isFake: false,
    async readPicture(request: ReadPictureRequest): Promise<string> {
      if (!hasGeminiApiKey()) {
        throw new GeminiConfigError(
          "Reading is unavailable because GEMINI_API_KEY is not set on the server.",
        );
      }

      if (!cachedAi) {
        // Reads GEMINI_API_KEY from process.env inside the SDK.
        cachedAi = new GoogleGenAI({ apiVersion: "v1beta" });
      }

      const pngBase64 = request.png.toString("base64");
      const response = await cachedAi.interactions.create(
        {
          model: GEMINI_HYDROGEN_MODEL,
          input: [
            {
              type: "image",
              data: pngBase64,
              mime_type: "image/png",
              resolution: "high",
            },
            { type: "text", text: request.prompt },
          ],
          generation_config: { thinking_level: "low" },
        },
        request.signal ? { signal: request.signal } : undefined,
      );

      return response.output_text ?? "";
    },
    async explainCause(request: ExplainCauseRequest): Promise<string> {
      if (!hasGeminiApiKey()) {
        throw new GeminiConfigError(
          "Cause explanation is unavailable because GEMINI_API_KEY is not set on the server.",
        );
      }

      if (!cachedAi) {
        cachedAi = new GoogleGenAI({ apiVersion: "v1beta" });
      }

      const model = request.model?.trim() || getCauseModelName();
      const prompt = buildCausePrompt(request);
      const response = await cachedAi.interactions.create(
        {
          model,
          input: [{ type: "text", text: prompt }],
          generation_config: { thinking_level: "low" },
        },
        request.signal ? { signal: request.signal } : undefined,
      );

      return (response.output_text ?? "").trim();
    },
    async decideQuestions(
      request: DecideQuestionsRequest,
    ): Promise<Record<string, number>> {
      if (!hasGeminiApiKey()) {
        throw new GeminiConfigError(
          "Second reader is unavailable because GEMINI_API_KEY is not set on the server.",
        );
      }

      if (!cachedAi) {
        cachedAi = new GoogleGenAI({ apiVersion: "v1beta" });
      }

      const pngBase64 = request.png.toString("base64");
      const questionsPayload: Record<
        string,
        { type: "noul"; instructions: string }
      > = {};
      for (const question of request.questions) {
        questionsPayload[question.id] = {
          type: "noul",
          instructions: question.instructions,
        };
      }

      const response = await cachedAi.decisions.create(
        {
          model: GEMINI_DECISION_MODEL,
          input: [
            {
              type: "image",
              data: pngBase64,
              mime_type: "image/png",
              resolution: "ultra_high",
            },
          ],
          questions: questionsPayload,
        },
        request.signal ? { signal: request.signal } : undefined,
      );

      const probabilities: Record<string, number> = {};
      for (const question of request.questions) {
        const answer = response.answers?.[question.id];
        if (
          answer &&
          "noul" in answer &&
          typeof answer.noul === "number" &&
          Number.isFinite(answer.noul)
        ) {
          probabilities[question.id] = answer.noul;
        }
      }
      return probabilities;
    },
  };
}

export type FakeGeminiClientOptions = {
  slowFirstDelayMs?: number;
  slowRepeatDelayMs?: number;
  causeSentence?: string;
};

export function createFakeGeminiClient(
  options?: FakeGeminiClientOptions,
): GeminiClient {
  return {
    isFake: true,
    async readPicture(request: ReadPictureRequest): Promise<string> {
      const ctx = request.testContext;
      const rows = ctx?.rows ?? ctx?.statement.rows ?? [];

      if (ctx?.slow) {
        const timeoutMs = Math.max(100, ctx.timeoutMs);
        if (ctx.strip === ctx.totalStrips) {
          if (ctx.attempt === 1) {
            const delayMs =
              options?.slowFirstDelayMs ?? Math.max(timeoutMs * 4, 2_000);
            await waitAbortable(delayMs, request.signal);
          } else {
            // Keep the repeat long enough for browser tests to inspect the slow
            // screen, while finishing comfortably before the repeat timeout.
            const delayMs =
              options?.slowRepeatDelayMs ??
              Math.min(Math.max(Math.floor(timeoutMs * 0.55), 400), 1100);
            await waitAbortable(delayMs, request.signal);
          }
        } else {
          await waitAbortable(25, request.signal);
        }
      }

      return formatStatementRowsAsReply(rows, {
        coverCell: ctx?.coverCell,
        overrideCell: ctx?.overrideCell,
      });
    },
    async explainCause(): Promise<string> {
      return options?.causeSentence ?? FAKE_CAUSE_SENTENCE;
    },
    async decideQuestions(
      request: DecideQuestionsRequest,
    ): Promise<Record<string, number>> {
      const doubtSet = new Set(
        (request.testContext?.doubtLabels ?? [])
          .map((label) => label.trim().toLowerCase())
          .filter(Boolean),
      );
      const unsureSet = new Set(
        (request.testContext?.unsureLabels ?? [])
          .map((label) => label.trim().toLowerCase())
          .filter(Boolean),
      );

      const probabilities: Record<string, number> = {};
      for (const question of request.questions) {
        const normalizedLabel = (question.rowLabel ?? "").trim().toLowerCase();
        if (normalizedLabel && doubtSet.has(normalizedLabel)) {
          probabilities[question.id] = 0.1;
        } else if (normalizedLabel && unsureSet.has(normalizedLabel)) {
          probabilities[question.id] = 0.6;
        } else {
          probabilities[question.id] = 0.97;
        }
      }
      return probabilities;
    },
  };
}

export function getGeminiClient(): GeminiClient {
  if (process.env.ADDS_UP_TEST === "1") {
    return createFakeGeminiClient();
  }
  return createRealGeminiClient();
}
