import { NextRequest, NextResponse } from "next/server";
import {
  canHideCell,
  parseChangedNumberInput,
  proveColumns,
} from "@/lib/adding";
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
  logServerError,
  MODIFY_FAILED_MESSAGE,
  READING_UNAVAILABLE_MESSAGE,
} from "@/lib/public-errors";
import {
  getGlobalReadingCache,
  getReadTimeoutMs,
  ReadingFailedError,
  ReadingTimeoutError,
  type ReadingProgressEvent,
} from "@/lib/reading";
import {
  clipText,
  MAX_NUMBER_TEXT_CHARS,
  readJsonBody,
} from "@/lib/request-limits";
import {
  getGlobalUploadStore,
  modifyUploadedPicture,
  type UploadModification,
} from "@/lib/uploads";

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
  context: RouteContext<"/api/upload/[id]/modify">,
) {
  const { id } = await context.params;
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
  // Both go into the paid locate prompt, so each is cut to 200 characters.
  const rowLabel =
    typeof body.rowLabel === "string" ? clipText(body.rowLabel.trim()) : "";
  const printedValue =
    typeof body.printedValue === "string"
      ? clipText(body.printedValue.trim())
      : "";

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

  let modification: UploadModification;
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

  // Check whether the selected cell can be hidden or changed BEFORE any model call.
  if (record.reading?.status === "ok") {
    const readRows = record.reading.result.rows;
    const beforeProof = proveColumns(
      readRows.map((r) => r.cells[0].number),
      readRows.map((r) => r.cells[1].number),
      {
        unreadMask: readRows.map(
          (r) => [r.cells[0].hidden, r.cells[1].hidden] as const,
        ),
      },
    );
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
        await modifyUploadedPicture({
          record,
          modification,
          rowLabel: rowLabel || `Row ${numberRowIndex + 1}`,
          printedValue,
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
          // Client aborted.
        } else if (error instanceof RateLimitError) {
          send({
            type: "error",
            code: "rate_limit",
            message: error.message,
          });
        } else if (error instanceof GeminiConfigError) {
          logServerError("changing a number on an uploaded picture", error);
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
          logServerError("changing a number on an uploaded picture", error);
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
