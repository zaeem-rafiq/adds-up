import { NextRequest, NextResponse } from "next/server";
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
  readStatementPictures,
  type ReadingProgressEvent,
} from "@/lib/reading";
import {
  getGlobalDecisionCache,
  recheckStatementNumbers,
} from "@/lib/second-reader";
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

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/company/[cik]/read">,
) {
  const { cik } = await context.params;
  if (!isValidCik(cik)) {
    return NextResponse.json(
      { code: "not_found", error: "Company not found." },
      { status: 404 },
    );
  }
  const testMode = process.env.ADDS_UP_TEST === "1";
  // Outside test mode, ?slow=1, ?doubt= and ?unsure= do nothing.
  const slow = testMode && request.nextUrl.searchParams.get("slow") === "1";
  const doubtLabels = testMode
    ? request.nextUrl.searchParams
        .getAll("doubt")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const unsureLabels = testMode
    ? request.nextUrl.searchParams
        .getAll("unsure")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const hasTestRecheckOverrides =
    testMode && (doubtLabels.length > 0 || unsureLabels.length > 0);

  const { browserId, isNew } = getOrCreateBrowserId(
    request.cookies.get(BROWSER_COOKIE_NAME)?.value,
  );
  const ip = extractClientIp(request.headers);

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

      let readingFinished = false;
      try {
        const readingResult = await readStatementPictures({
          statement: statementResult.statement,
          client,
          cache,
          rateLimiter,
          browserId,
          ip,
          timeoutMs,
          slow,
          // In test mode with ?slow=1, bypass the memory cache so browser tests
          // always exercise the slow first call and repeat.
          bypassCache: slow,
          signal: request.signal,
          onProgress: send,
        });
        readingFinished = true;

        // Run the second reader AFTER sending "done" so ticks never wait for it.
        if (!request.signal.aborted) {
          const recheck = await recheckStatementNumbers({
            statement: statementResult.statement,
            readingResult,
            client,
            cache: getGlobalDecisionCache(),
            rateLimiter,
            browserId,
            ip,
            timeoutMs,
            bypassCache: hasTestRecheckOverrides,
            testContext: testMode ? { doubtLabels, unsureLabels } : undefined,
            signal: request.signal,
          });
          if (recheck.results.length > 0 && !request.signal.aborted) {
            send({ type: "recheck", recheck });
          }
        }
      } catch (error) {
        if (
          readingFinished ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          // Reading already delivered its result, or client aborted (e.g. clicked Stop).
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
            message: "Could not read the balance sheet picture right now.",
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
