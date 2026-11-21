import { NextRequest, NextResponse } from "next/server";
import {
  getCauseModelName,
  getGeminiClient,
  hasGeminiApiKey,
  type CauseGroupRow,
} from "@/lib/gemini";
import {
  BROWSER_COOKIE_NAME,
  extractClientIp,
  getGlobalRateLimiter,
  getOrCreateBrowserId,
} from "@/lib/rate-limit";
import {
  explainMismatchCause,
  getGlobalCauseCache,
  getReadTimeoutMs,
} from "@/lib/reading";
import { clipText, readJsonBody } from "@/lib/request-limits";

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

function parseGroupRows(raw: unknown): CauseGroupRow[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 60) {
    return null;
  }
  const rows: CauseGroupRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.label !== "string" ||
      typeof record.value !== "string" ||
      typeof record.number !== "number" ||
      !Number.isFinite(record.number)
    ) {
      return null;
    }
    rows.push({
      label: clipText(record.label),
      value: clipText(record.value),
      number: record.number,
    });
  }
  return rows;
}

export async function POST(request: NextRequest) {
  const { browserId, isNew } = getOrCreateBrowserId(
    request.cookies.get(BROWSER_COOKIE_NAME)?.value,
  );
  const ip = extractClientIp(request.headers);
  const model = getCauseModelName();

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return applyBrowserCookie(
      request,
      NextResponse.json(
        { sentence: null, model, error: parsedBody.message },
        { status: parsedBody.status },
      ),
      browserId,
      isNew,
    );
  }
  if (!parsedBody.value || typeof parsedBody.value !== "object") {
    return applyBrowserCookie(
      request,
      NextResponse.json({ sentence: null, model }, { status: 400 }),
      browserId,
      isNew,
    );
  }
  const body = parsedBody.value as Record<string, unknown>;

  const groupLabel =
    typeof body.groupLabel === "string" ? clipText(body.groupLabel.trim()) : "";
  const rows = parseGroupRows(body.rows);
  const statedTotal = body.statedTotal;
  const computedSum = body.computedSum;
  const gap = body.gap;
  const diff = body.diff;

  if (
    !groupLabel ||
    !rows ||
    typeof statedTotal !== "number" ||
    !Number.isFinite(statedTotal) ||
    typeof computedSum !== "number" ||
    !Number.isFinite(computedSum) ||
    typeof gap !== "number" ||
    !Number.isFinite(gap) ||
    typeof diff !== "number" ||
    !Number.isFinite(diff)
  ) {
    return applyBrowserCookie(
      request,
      NextResponse.json({ sentence: null, model }, { status: 400 }),
      browserId,
      isNew,
    );
  }

  const client = getGeminiClient();
  if (!client.isFake && !hasGeminiApiKey()) {
    return applyBrowserCookie(
      request,
      NextResponse.json({ sentence: null, model }, { status: 200 }),
      browserId,
      isNew,
    );
  }

  const outcome = await explainMismatchCause({
    groupLabel,
    rows,
    statedTotal,
    computedSum,
    gap,
    diff,
    client,
    cache: getGlobalCauseCache(),
    rateLimiter: getGlobalRateLimiter(),
    browserId,
    ip,
    model,
    timeoutMs: getReadTimeoutMs(),
    signal: request.signal,
  });

  return applyBrowserCookie(
    request,
    NextResponse.json(
      {
        sentence: outcome.sentence,
        model: outcome.model,
        fromCache: outcome.fromCache,
      },
      { status: 200 },
    ),
    browserId,
    isNew,
  );
}
