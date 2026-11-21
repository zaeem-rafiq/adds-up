import { GoogleGenAI } from "@google/genai";
import type { Statement, StatementRow } from "@/lib/statements";

export const GEMINI_HYDROGEN_MODEL = "gemini-4-hydrogen";

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
  half: "A" | "B" | "whole";
  slow?: boolean;
  attempt: number;
  timeoutMs: number;
};

export type ReadPictureRequest = {
  png: Buffer;
  prompt: string;
  signal?: AbortSignal;
  /** Context used only by the fake test-mode client; ignored by the real client. */
  testContext?: FakeReadContext;
};

export type GeminiClient = {
  readonly isFake: boolean;
  readPicture(request: ReadPictureRequest): Promise<string>;
};

export function hasGeminiApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function formatStatementRowsAsReply(rows: StatementRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.kind !== "number") continue;
    const left = row.values[0] ?? "";
    const right = row.values[1] ?? "";
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
  };
}

export type FakeGeminiClientOptions = {
  slowFirstDelayMs?: number;
  slowRepeatDelayMs?: number;
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
        if (ctx.half === "B" || ctx.half === "whole") {
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

      return formatStatementRowsAsReply(rows);
    },
  };
}

export function getGeminiClient(): GeminiClient {
  if (process.env.ADDS_UP_TEST === "1") {
    return createFakeGeminiClient();
  }
  return createRealGeminiClient();
}
