import { NextRequest, NextResponse } from "next/server";
import { parseChangedNumberInput } from "@/lib/adding";
import { findCompanyByCik, isValidCik } from "@/lib/companies";
import {
  GeminiConfigError,
  getGeminiClient,
  hasGeminiApiKey,
} from "@/lib/gemini";
import {
  BROWSER_COOKIE_NAME,
  extractClientIp,
  getGlobalRateLimiter,
  getOrCreateBrowserId,
  RateLimitError,
} from "@/lib/rate-limit";
import {
  getGlobalReadingCache,
  getReadTimeoutMs,
  ReadingFailedError,
  ReadingTimeoutError,
  readStatementWithModification,
  type ReadingProgressEvent,
  type ReadRow,
  type StatementModification,
} from "@/lib/reading";
import { loadStatement, StatementError } from "@/lib/statements";

function applyBrowserCookie(
  request: NextRequest,
  response: NextResponse,
  browserId: string,
  isNew: boolean,
): NextResponse {
  if (isNew) {
    const isHttps =
      request.nextUrl.protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https";
    response.cookies.set(BROWSER_COOKIE_NAME, browserId, {
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return response;
}

function isReadRowArray(value: unknown): value is ReadRow[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return (
      typeof row.label === "string" &&
      Array.isArray(row.cells) &&
      row.cells.length === 2
    );
  });
}

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/company/[cik]/modify">,
) {
  const { cik } = await context.params;
  if (!isValidCik(cik)) {
    return NextResponse.json(
      { code: "not_found", error: "Company not found." },
      { status: 404 },
    );
  }
  const { browserId, isNew } = getOrCreateBrowserId(
    request.cookies.get(BROWSER_COOKIE_NAME)?.value,
  );
  const ip = extractClientIp(request.headers);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return applyBrowserCookie(
        request,
        NextResponse.json(
          { code: "failed", error: "Invalid request body." },
          { status: 400 },
        ),
        browserId,
        isNew,
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return applyBrowserCookie(
      request,
      NextResponse.json(
        { code: "failed", error: "Invalid request body." },
        { status: 400 },
      ),
      browserId,
      isNew,
    );
  }

  const action = body.action;
  const numberRowIndex = body.numberRowIndex;
  const colIndex = body.colIndex;

  if (
    (action !== "hide" && action !== "change") ||
    typeof numberRowIndex !== "number" ||
    !Number.isInteger(numberRowIndex) ||
    numberRowIndex < 0 ||
    (colIndex !== 0 && colIndex !== 1)
  ) {
    return applyBrowserCookie(
      request,
      NextResponse.json(
        { code: "failed", error: "Invalid balance sheet cell selection." },
        { status: 400 },
      ),
      browserId,
      isNew,
    );
  }

  let modification: StatementModification;
  if (action === "hide") {
    modification = {
      kind: "hide",
      numberRowIndex,
      colIndex,
    };
  } else {
    const rawValue = typeof body.newValue === "string" ? body.newValue : "";
    const parsedValue = parseChangedNumberInput(rawValue);
    if (!parsedValue.ok) {
      return applyBrowserCookie(
        request,
        NextResponse.json(
          { code: "invalid_number", error: parsedValue.error },
          { status: 400 },
        ),
        browserId,
        isNew,
      );
    }
    modification = {
      kind: "change",
      numberRowIndex,
      colIndex,
      newValue: parsedValue.formatted,
    };
  }

  const previousRows = isReadRowArray(body.previousRows)
    ? body.previousRows
    : undefined;

  let companyName = "";
  try {
    const company = await findCompanyByCik(cik);
    if (company) {
      companyName = company.name;
    }
  } catch {
    // Allow saved-copy fallback even if the SEC company list is unreachable.
  }

  let statementResult;
  try {
    statementResult = await loadStatement(cik, { companyName });
  } catch (error) {
    const status = error instanceof StatementError ? error.status : 500;
    const message =
      error instanceof StatementError
        ? error.message
        : "Could not load this company's balance sheet.";
    return applyBrowserCookie(
      request,
      NextResponse.json({ code: "failed", error: message }, { status }),
      browserId,
      isNew,
    );
  }

  const client = getGeminiClient();
  const cache = getGlobalReadingCache();
  const rateLimiter = getGlobalRateLimiter();
  const timeoutMs = getReadTimeoutMs();

  if (!client.isFake && !hasGeminiApiKey()) {
    return applyBrowserCookie(
      request,
      NextResponse.json(
        {
          code: "missing_key",
          error:
            "Reading is unavailable because GEMINI_API_KEY is not set on the server.",
        },
        { status: 503 },
      ),
      browserId,
      isNew,
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: ReadingProgressEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };

      try {
        await readStatementWithModification({
          statement: statementResult.statement,
          modification,
          previousRows,
          client,
          cache,
          rateLimiter,
          browserId,
          ip,
          timeoutMs,
          signal: request.signal,
          onProgress: send,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Client aborted (e.g. clicked Stop).
        } else if (error instanceof RateLimitError) {
          send({
            type: "error",
            code: "rate_limit",
            message: error.message,
          });
        } else if (error instanceof GeminiConfigError) {
          send({
            type: "error",
            code: "missing_key",
            message: error.message,
          });
        } else if (error instanceof ReadingTimeoutError) {
          send({
            type: "error",
            code: "timeout",
            message: error.message,
            strip: error.strip,
            totalStrips: error.totalStrips,
          });
        } else if (error instanceof ReadingFailedError) {
          send({
            type: "error",
            code: "failed",
            message: error.message,
            strip: error.strip,
            totalStrips: error.totalStrips,
          });
        } else {
          send({
            type: "error",
            code: "failed",
            message: "Could not read the updated balance sheet picture right now.",
          });
        }
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
  });

  const response = new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });

  return applyBrowserCookie(request, response, browserId, isNew);
}
