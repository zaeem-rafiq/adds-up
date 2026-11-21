import { NextRequest, NextResponse } from "next/server";
import {
  canHideCell,
  parseChangedNumberInput,
  proveColumns,
} from "@/lib/adding";
import { findCompanyByCik, isValidCik } from "@/lib/companies";
import {
  GeminiConfigError,
  getGeminiClient,
  hasGeminiApiKey,
} from "@/lib/gemini";
import {
  logServerError,
  MODIFY_FAILED_MESSAGE,
  publicStatementError,
  READING_UNAVAILABLE_MESSAGE,
} from "@/lib/public-errors";
import {
  BROWSER_COOKIE_NAME,
  extractClientIp,
  getGlobalRateLimiter,
  getOrCreateBrowserId,
  RateLimitError,
} from "@/lib/rate-limit";
import {
  compareReadingWithStatement,
  getGlobalReadingCache,
  getReadTimeoutMs,
  ReadingFailedError,
  ReadingTimeoutError,
  readStatementWithModification,
  type ReadingProgressEvent,
  type StatementModification,
} from "@/lib/reading";
import {
  MAX_NUMBER_TEXT_CHARS,
  parsePreviousRows,
  readJsonBody,
} from "@/lib/request-limits";
import { loadStatement } from "@/lib/statements";

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

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return applyBrowserCookie(
      request,
      NextResponse.json(
        { code: parsedBody.code, error: parsedBody.message },
        { status: parsedBody.status },
      ),
      browserId,
      isNew,
    );
  }
  if (!parsedBody.value || typeof parsedBody.value !== "object") {
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
  const body = parsedBody.value as Record<string, unknown>;

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
    const parsedValue =
      rawValue.length > MAX_NUMBER_TEXT_CHARS
        ? ({
            ok: false,
            error: "Enter a valid number, such as 15,541.",
          } as const)
        : parseChangedNumberInput(rawValue);
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

  // The rows come from the visitor: checked, clipped and never written to a shared cache.
  const previousRowsResult = parsePreviousRows(body.previousRows);
  if (!previousRowsResult.ok) {
    return applyBrowserCookie(
      request,
      NextResponse.json(
        { code: "too_large", error: previousRowsResult.message },
        { status: 400 },
      ),
      browserId,
      isNew,
    );
  }
  const previousRows = previousRowsResult.rows;

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
    const { status, message } = publicStatementError(error);
    return applyBrowserCookie(
      request,
      NextResponse.json({ code: "failed", error: message }, { status }),
      browserId,
      isNew,
    );
  }

  // Check whether the selected cell can be hidden or changed BEFORE any model call.
  const beforeProof = (() => {
    if (previousRows && previousRows.length > 0) {
      const comparison = compareReadingWithStatement(
        statementResult.statement,
        previousRows,
      );
      return proveColumns(
        comparison.rows.map((r) => r.cells[0].read),
        comparison.rows.map((r) => r.cells[1].read),
        {
          unreadMask: comparison.rows.map(
            (r) =>
              [
                r.cells[0].unread || r.cells[0].hidden,
                r.cells[1].unread || r.cells[1].hidden,
              ] as const,
          ),
        },
      );
    }
    const numberRows = statementResult.statement.rows.filter(
      (r) => r.kind === "number",
    );
    return proveColumns(
      numberRows.map((r) => r.numbers[0]),
      numberRows.map((r) => r.numbers[1]),
      {
        unreadMask: numberRows.map(() => [false, false] as const),
      },
    );
  })();

  const cellCheck = canHideCell(beforeProof, numberRowIndex, colIndex);
  if (!cellCheck.allowed) {
    return applyBrowserCookie(
      request,
      NextResponse.json(
        { code: "cannot_modify", error: cellCheck.reason },
        { status: 400 },
      ),
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
          error: READING_UNAVAILABLE_MESSAGE,
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
          logServerError("changing a number on a statement", error);
          send({
            type: "error",
            code: "missing_key",
            message: READING_UNAVAILABLE_MESSAGE,
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
          logServerError("changing a number on a statement", error);
          send({
            type: "error",
            code: "failed",
            message: MODIFY_FAILED_MESSAGE,
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
