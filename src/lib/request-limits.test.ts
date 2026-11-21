import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST as postCompanyCause } from "@/app/api/company/[cik]/cause/route";
import { POST as postCompanyModify } from "@/app/api/company/[cik]/modify/route";
import { POST as postUploadCause } from "@/app/api/upload/[id]/cause/route";
import { POST as postUploadModify } from "@/app/api/upload/[id]/modify/route";
import appleFixture from "@/fixtures/apple-statement.json";
import {
  createFakeGeminiClient,
  type GeminiClient,
  type LocateCellBoxRequest,
} from "@/lib/gemini";
import { resetGlobalRateLimiter } from "@/lib/rate-limit";
import type { ReadingProgressEvent, ReadRow } from "@/lib/reading";
import { getGlobalCauseCache, getGlobalReadingCache } from "@/lib/reading";
import { formatStatementRowsAsReplyForTest } from "@/lib/reading-test-helpers";
import {
  clipText,
  MAX_JSON_BODY_BYTES,
  MAX_LABEL_CHARS,
  MAX_REQUEST_ROWS,
  parsePreviousRows,
  readJsonBody,
  REQUEST_TOO_LARGE_MESSAGE,
  TOO_MANY_ROWS_MESSAGE,
} from "@/lib/request-limits";
import type { Statement } from "@/lib/statements";
import { getGlobalUploadStore, resetGlobalUploadStore } from "@/lib/uploads";

type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]>;

const geminiHolder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return {
    ...actual,
    getGeminiClient: () => (geminiHolder.client as GeminiClient | null) ?? actual.getGeminiClient(),
  };
});

const APPLE = appleFixture as unknown as Statement;
const CLEAN_ROWS = formatStatementRowsAsReplyForTest(APPLE.rows);

function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A JSON body a little over 300 KB. */
function oversizedBody(): string {
  return JSON.stringify({ filler: "x".repeat(MAX_JSON_BODY_BYTES + 10) });
}

function streamEvents(text: string): ReadingProgressEvent[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReadingProgressEvent);
}

beforeEach(() => {
  resetGlobalRateLimiter();
  resetGlobalUploadStore();
  getGlobalReadingCache().clear();
  getGlobalCauseCache().clear();
  geminiHolder.client = null;
});

afterEach(() => {
  geminiHolder.client = null;
  vi.restoreAllMocks();
});

describe("Capped request reader", () => {
  test("reads a body under 300 KB", async () => {
    const result = await readJsonBody(jsonRequest("http://localhost/x", { a: 1 }));
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  test("refuses a declared content-length over 300 KB without reading the body", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("{}"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const result = await readJsonBody(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body,
        duplex: "half",
        headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
      } as NextRequestInit),
    );
    expect(result).toMatchObject({ ok: false, status: 413, code: "too_large" });
    expect(pulls).toBe(0);
  });

  test("cuts off a body that streams past 300 KB with no content-length", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(64 * 1024));
          if (pulls >= 1000) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const result = await readJsonBody(
      new NextRequest("http://localhost/x", {
        method: "POST",
        body,
        duplex: "half",
      } as NextRequestInit),
    );
    expect(result).toMatchObject({ ok: false, status: 413 });
    expect(pulls).toBeLessThan(10);
  });

  test("answers 400 for text that is not JSON", async () => {
    const result = await readJsonBody(jsonRequest("http://localhost/x", "{not json"));
    expect(result).toMatchObject({ ok: false, status: 400, code: "failed" });
  });
});

describe("Label and row caps", () => {
  test("clipText keeps text up to 200 characters and cuts longer text without splitting a character", () => {
    expect(MAX_LABEL_CHARS).toBe(200);
    expect(clipText("a".repeat(200))).toBe("a".repeat(200));
    expect(clipText("a".repeat(201))).toBe("a".repeat(200));
    // A two-unit emoji that straddles the cut is dropped whole.
    expect(clipText(`${"a".repeat(199)}\u{1F600}`)).toBe("a".repeat(199));
  });

  test("parsePreviousRows clips each label to 200 characters and keeps the cells", () => {
    const result = parsePreviousRows([
      {
        label: "L".repeat(410),
        cells: [
          { raw: "1,000", number: 1000, hidden: false },
          { raw: "HIDDEN", number: null, hidden: true },
        ],
        extra: "dropped",
      },
    ]);
    expect(result).toEqual({
      ok: true,
      rows: [
        {
          label: "L".repeat(200),
          cells: [
            { raw: "1,000", number: 1000, hidden: false },
            { raw: "HIDDEN", number: null, hidden: true },
          ],
        },
      ],
    });
  });

  test("parsePreviousRows refuses more than 200 rows and accepts exactly 200", () => {
    const row = {
      label: "Cash",
      cells: [
        { raw: "1", number: 1, hidden: false },
        { raw: "1", number: 1, hidden: false },
      ],
    };
    expect(MAX_REQUEST_ROWS).toBe(200);
    expect(parsePreviousRows(new Array(201).fill(row))).toEqual({
      ok: false,
      message: TOO_MANY_ROWS_MESSAGE,
    });
    expect(parsePreviousRows(new Array(200).fill(row))).toMatchObject({ ok: true });
  });

  test("parsePreviousRows ignores rows whose cells are not well formed, as before", () => {
    const base = { label: "Cash" };
    const good = { raw: "1", number: 1, hidden: false };
    for (const cells of [
      [good],
      [good, { raw: "1", number: "1", hidden: false }],
      [good, { raw: "1", number: 1, hidden: "no" }],
      [good, { raw: 5, number: 1, hidden: false }],
      [good, { raw: "r".repeat(201), number: 1, hidden: false }],
      [good, null],
      "cells",
    ]) {
      expect(parsePreviousRows([{ ...base, cells }])).toEqual({ ok: true, rows: undefined });
    }
    expect(parsePreviousRows("not a list")).toEqual({ ok: true, rows: undefined });
    expect(parsePreviousRows(undefined)).toEqual({ ok: true, rows: undefined });
  });
});

describe("Cause routes", () => {
  const causeBody = {
    groupLabel: "Total current assets",
    rows: [{ label: "Cash", value: "10", number: 10 }],
    statedTotal: 20,
    computedSum: 10,
    gap: 10,
    diff: -10,
  };

  function explainSpy() {
    const calls: Array<{ groupLabel: string; rows: Array<{ label: string; value: string }> }> = [];
    const client: GeminiClient = {
      isFake: true,
      readPicture: async () => "",
      explainCause: async (request) => {
        calls.push(request);
        return "One line is off.";
      },
    };
    geminiHolder.client = client;
    return calls;
  }

  test("refuses a body over 300 KB with 413 and makes no model call", async () => {
    const calls = explainSpy();
    const company = await postCompanyCause(
      jsonRequest("http://localhost/api/company/320193/cause", oversizedBody()),
      { params: Promise.resolve({ cik: "320193" }) },
    );
    expect(company.status).toBe(413);
    expect(((await company.json()) as { error: string }).error).toBe(
      REQUEST_TOO_LARGE_MESSAGE,
    );

    const upload = await postUploadCause(
      jsonRequest("http://localhost/api/upload/abc/cause", oversizedBody()),
    );
    expect(upload.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  test("refuses more rows than the route allows", async () => {
    const calls = explainSpy();
    const rows = new Array(201).fill({ label: "Cash", value: "1", number: 1 });
    const response = await postCompanyCause(
      jsonRequest("http://localhost/api/company/320193/cause", { ...causeBody, rows }),
      { params: Promise.resolve({ cik: "320193" }) },
    );
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("cuts every label to 200 characters before the paid call, and still answers", async () => {
    const calls = explainSpy();
    const long = "Common stock, par value and shares authorized ".repeat(10);
    const body = {
      ...causeBody,
      groupLabel: long,
      rows: [{ label: long, value: "v".repeat(500), number: 10 }],
    };
    for (const route of ["company", "upload"] as const) {
      getGlobalCauseCache().clear();
      const response =
        route === "company"
          ? await postCompanyCause(
              jsonRequest("http://localhost/api/company/320193/cause", body),
              { params: Promise.resolve({ cik: "320193" }) },
            )
          : await postUploadCause(
              jsonRequest("http://localhost/api/upload/abc/cause", body),
            );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { sentence: string }).sentence).toBe(
        "One line is off.",
      );
    }
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.groupLabel.length).toBe(200);
      expect(call.rows[0].label.length).toBe(200);
      expect(call.rows[0].value.length).toBe(200);
    }
  });
});

describe("Upload modify route", () => {
  async function storedUpload() {
    const png = await readFile(
      path.join(process.cwd(), "src/fixtures/uploads/statement-apple.png"),
    );
    return getGlobalUploadStore().create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: png,
    });
  }

  function post(id: string, body: unknown) {
    return postUploadModify(
      jsonRequest(`http://localhost/api/upload/${id}/modify`, body),
      { params: Promise.resolve({ id }) },
    );
  }

  test("refuses a body over 300 KB with 413", async () => {
    const record = await storedUpload();
    const response = await post(record.id, oversizedBody());
    expect(response.status).toBe(413);
  });

  test("refuses a long number text with a plain message", async () => {
    const record = await storedUpload();
    const response = await post(record.id, {
      action: "change",
      numberRowIndex: 4,
      colIndex: 0,
      newValue: "9".repeat(100),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_number");
  });

  test("cuts the row label and printed value to 200 characters and still reads the picture", async () => {
    const record = await storedUpload();
    const fake = createFakeGeminiClient();
    const located: LocateCellBoxRequest[] = [];
    geminiHolder.client = {
      isFake: true,
      readPicture: fake.readPicture.bind(fake),
      locateCellBox: async (request: LocateCellBoxRequest) => {
        located.push(request);
        return fake.locateCellBox!(request);
      },
    } satisfies GeminiClient;

    const response = await post(record.id, {
      action: "hide",
      numberRowIndex: 4,
      colIndex: 0,
      rowLabel: "Inventories and other things ".repeat(30),
      printedValue: "14,541 ".repeat(100),
    });
    expect(response.status).toBe(200);
    const events = streamEvents(await response.text());
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(located).toHaveLength(1);
    expect(located[0].rowLabel.length).toBeLessThanOrEqual(200);
    expect(located[0].rowLabel.length).toBeGreaterThan(150);
    expect(located[0].printedValue.length).toBeLessThanOrEqual(200);
  });
});

describe("Company modify route", () => {
  function post(body: unknown) {
    return postCompanyModify(
      jsonRequest("http://localhost/api/company/320193/modify", body),
      { params: Promise.resolve({ cik: "320193" }) },
    );
  }

  test("refuses a body over 300 KB with 413", async () => {
    const response = await post(oversizedBody());
    expect(response.status).toBe(413);
  });

  test("refuses more than 200 previous rows with a plain message", async () => {
    const response = await post({
      action: "hide",
      numberRowIndex: 4,
      colIndex: 0,
      previousRows: new Array(201).fill(CLEAN_ROWS[0]),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(TOO_MANY_ROWS_MESSAGE);
  });

  test("a label over 200 characters is cut and the request still goes through", async () => {
    const rows: ReadRow[] = structuredClone(CLEAN_ROWS);
    // Repeating the words keeps the label matching its statement row after the cut.
    rows[0].label = `${rows[0].label} `.repeat(30);
    expect(rows[0].label.length).toBeGreaterThan(MAX_LABEL_CHARS);

    const response = await post({
      action: "hide",
      numberRowIndex: 4,
      colIndex: 0,
      previousRows: rows,
    });
    expect(response.status).toBe(200);
    const events = streamEvents(await response.text());
    const done = events.find((event) => event.type === "done");
    expect(done).toBeDefined();
    if (done?.type === "done") {
      expect(done.result.rows.every((row) => row.label.length <= MAX_LABEL_CHARS)).toBe(true);
    }
  });

  test("refuses a long number text", async () => {
    const response = await post({
      action: "change",
      numberRowIndex: 4,
      colIndex: 0,
      newValue: "9".repeat(100),
      previousRows: CLEAN_ROWS,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_number");
  });
});
