import { NextRequest, NextResponse } from "next/server";
import {
  GeminiConfigError,
  getGeminiClient,
  hasGeminiApiKey,
} from "@/lib/gemini";
import {
  logServerError,
  READING_UNAVAILABLE_MESSAGE,
  UPLOAD_READ_FAILED_MESSAGE,
} from "@/lib/public-errors";
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
  type ReadingProgressEvent,
} from "@/lib/reading";
import { getGlobalUploadStore, readUploadedPicture } from "@/lib/uploads";

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
  context: RouteContext<"/api/upload/[id]/read">,
) {
  const { id } = await context.params;
  const testMode = process.env.ADDS_UP_TEST === "1";
  const slow = testMode && request.nextUrl.searchParams.get("slow") === "1";

  const { browserId, isNew } = getOrCreateBrowserId(
    request.cookies.get(BROWSER_COOKIE_NAME)?.value,
  );
  const ip = extractClientIp(request.headers);

  const store = getGlobalUploadStore();
  const record = store.get(id);
  if (!record) {
    return applyBrowserCookie(
      request,
      NextResponse.json(
        {
          code: "not_found",
          error:
            "This uploaded statement is no longer in memory. Please upload it again.",
        },
        { status: 404 },
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
        await readUploadedPicture({
          record,
          client,
          cache,
          rateLimiter,
          browserId,
          ip,
          timeoutMs,
          slow,
          bypassCache: slow,
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
          logServerError("reading an uploaded picture", error);
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
            strip: 1,
            totalStrips: 1,
          });
        } else if (error instanceof ReadingFailedError) {
          send({
            type: "error",
            code: "failed",
            message: error.message,
            strip: 1,
            totalStrips: 1,
          });
        } else {
          logServerError("reading an uploaded picture", error);
          send({
            type: "error",
            code: "failed",
            message: UPLOAD_READ_FAILED_MESSAGE,
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
