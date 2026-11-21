import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GET as getCompanies } from "@/app/api/companies/route";
import { GET as getCompanyPicture } from "@/app/api/company/[cik]/picture/route";
import { POST as postCompanyModify } from "@/app/api/company/[cik]/modify/route";
import { POST as postCompanyRead } from "@/app/api/company/[cik]/read/route";
import { GET as getCompanyStatement } from "@/app/api/company/[cik]/statement/route";
import { POST as postUploadModify } from "@/app/api/upload/[id]/modify/route";
import { POST as postUploadRead } from "@/app/api/upload/[id]/read/route";
import appleFixture from "@/fixtures/apple-statement.json";
import { CompanyListError } from "@/lib/companies";
import type { GeminiClient } from "@/lib/gemini";
import {
  COMPANY_SEARCH_UNAVAILABLE_MESSAGE,
  MODEL_FAILED_MESSAGE,
  publicCompanyListError,
  publicStatementError,
  READING_UNAVAILABLE_MESSAGE,
  SAVED_COPY_MESSAGE,
  STATEMENT_NOT_FOUND_MESSAGE,
  STATEMENT_UNAVAILABLE_MESSAGE,
} from "@/lib/public-errors";
import { resetGlobalRateLimiter } from "@/lib/rate-limit";
import { getGlobalCauseCache, getGlobalReadingCache, type ReadingProgressEvent } from "@/lib/reading";
import { formatStatementRowsAsReplyForTest } from "@/lib/reading-test-helpers";
import { StatementError, type Statement } from "@/lib/statements";
import { getGlobalUploadStore, resetGlobalUploadStore } from "@/lib/uploads";

const mocks = vi.hoisted(() => ({
  client: null as unknown,
  loadStatement: null as null | (() => Promise<unknown>),
  loadCompanyList: null as null | (() => Promise<unknown>),
}));

vi.mock("@/lib/gemini", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gemini")>();
  return {
    ...actual,
    getGeminiClient: () => (mocks.client as GeminiClient | null) ?? actual.getGeminiClient(),
  };
});

vi.mock("@/lib/statements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/statements")>();
  return {
    ...actual,
    loadStatement: (...args: Parameters<typeof actual.loadStatement>) =>
      mocks.loadStatement ? mocks.loadStatement() : actual.loadStatement(...args),
  };
});

vi.mock("@/lib/companies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/companies")>();
  return {
    ...actual,
    loadCompanyList: (...args: Parameters<typeof actual.loadCompanyList>) =>
      mocks.loadCompanyList ? mocks.loadCompanyList() : actual.loadCompanyList(...args),
  };
});

const APPLE = appleFixture as unknown as Statement;
const CLEAN_ROWS = formatStatementRowsAsReplyForTest(APPLE.rows);

/** Fragments of text that name a setting, a key or the raw detail of an outside failure. */
const FORBIDDEN =
  /GEMINI_API_KEY|SEC_USER_AGENT|CAUSE_MODEL|RAW_DETAIL|ECONNRESET|Could not reach the SEC|10\.1\.2\.3|permission denied/i;

function expectPlain(text: string) {
  expect(text).not.toMatch(FORBIDDEN);
  expect(text.length).toBeGreaterThan(10);
}

const rawFailingClient: GeminiClient = {
  isFake: true,
  async readPicture() {
    throw new Error("RAW_DETAIL permission denied for the key at 10.1.2.3");
  },
  async locateCellBox() {
    throw new Error("RAW_DETAIL permission denied for the key at 10.1.2.3");
  },
};

const cikParams = { params: Promise.resolve({ cik: "320193" }) };

function jsonPost(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function events(text: string): ReadingProgressEvent[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReadingProgressEvent);
}

let savedKey: string | undefined;

beforeEach(() => {
  resetGlobalRateLimiter();
  resetGlobalUploadStore();
  getGlobalReadingCache().clear();
  getGlobalCauseCache().clear();
  mocks.client = null;
  mocks.loadStatement = null;
  mocks.loadCompanyList = null;
  savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe("Plain sentences for the browser", () => {
  test("a statement error becomes a plain sentence and its detail goes to the log", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = new StatementError("Could not reach the SEC: ECONNRESET 10.1.2.3", 502);
    expect(publicStatementError(raw)).toEqual({
      status: 502,
      message: STATEMENT_UNAVAILABLE_MESSAGE,
    });
    expect(String(logged.mock.calls[0][0])).toContain("ECONNRESET");

    expect(
      publicStatementError(
        new StatementError("Cannot fetch because SEC_USER_AGENT is not set on the server.", 503),
      ),
    ).toEqual({ status: 503, message: STATEMENT_UNAVAILABLE_MESSAGE });
    expect(publicStatementError(new StatementError("No 10-K found", 404))).toEqual({
      status: 404,
      message: STATEMENT_NOT_FOUND_MESSAGE,
    });
    expect(publicStatementError(new TypeError("x is undefined")).message).toBe(
      STATEMENT_UNAVAILABLE_MESSAGE,
    );
  });

  test("a company list error becomes a plain sentence", () => {
    const result = publicCompanyListError(
      new CompanyListError(
        "Company search is unavailable because SEC_USER_AGENT is not set on the server.",
        503,
      ),
    );
    expect(result).toEqual({ status: 503, message: COMPANY_SEARCH_UNAVAILABLE_MESSAGE });
    expectPlain(result.message);
  });

  test("the plain sentences themselves hold no setting names or raw detail", () => {
    for (const message of [
      MODEL_FAILED_MESSAGE,
      READING_UNAVAILABLE_MESSAGE,
      STATEMENT_NOT_FOUND_MESSAGE,
      STATEMENT_UNAVAILABLE_MESSAGE,
      COMPANY_SEARCH_UNAVAILABLE_MESSAGE,
      SAVED_COPY_MESSAGE,
    ]) {
      expectPlain(message);
    }
  });
});

describe("Company routes", () => {
  test("the statement route sends a plain sentence when loading fails", async () => {
    mocks.loadStatement = async () => {
      throw new StatementError("Could not reach the SEC: ECONNRESET 10.1.2.3", 502);
    };
    const response = await getCompanyStatement(
      new NextRequest("http://localhost/api/company/320193/statement"),
      cikParams,
    );
    expect(response.status).toBe(502);
    expectPlain(((await response.json()) as { error: string }).error);
  });

  test("the statement route does not pass on the raw reason for a saved copy", async () => {
    mocks.loadStatement = async () => ({
      statement: APPLE,
      source: "saved",
      fallbackReason: "RAW_DETAIL: Could not reach the SEC: ECONNRESET",
    });
    const response = await getCompanyStatement(
      new NextRequest("http://localhost/api/company/320193/statement"),
      cikParams,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { source: string; fallbackReason: string };
    expect(payload.source).toBe("saved");
    expect(payload.fallbackReason).toBe(SAVED_COPY_MESSAGE);
  });

  test("the picture route sends a plain sentence when loading fails", async () => {
    mocks.loadStatement = async () => {
      throw new StatementError("Could not reach the SEC: ECONNRESET 10.1.2.3", 502);
    };
    const response = await getCompanyPicture(
      new NextRequest("http://localhost/api/company/320193/picture"),
      cikParams,
    );
    expect(response.status).toBe(502);
    expectPlain(((await response.json()) as { error: string }).error);
  });

  test("the company search route sends a plain sentence when the list fails", async () => {
    mocks.loadCompanyList = async () => {
      throw new CompanyListError(
        "Company search is unavailable because SEC_USER_AGENT is not set on the server.",
        503,
      );
    };
    const response = await getCompanies(new NextRequest("http://localhost/api/companies?q=apple"));
    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: string; companies: unknown[] };
    expectPlain(payload.error);
    expect(payload.companies).toEqual([]);
  });

  test("the read route sends a plain sentence when the statement cannot be loaded", async () => {
    mocks.loadStatement = async () => {
      throw new StatementError(
        "Could not load the balance sheet because SEC_USER_AGENT is not set on the server.",
        503,
      );
    };
    const response = await postCompanyRead(
      new NextRequest("http://localhost/api/company/320193/read", { method: "POST" }),
      cikParams,
    );
    expect(response.status).toBe(503);
    expectPlain(((await response.json()) as { error: string }).error);
  });

  test("the read, modify and upload routes name no key when the Gemini key is missing", async () => {
    mocks.client = { isFake: false, readPicture: async () => "" } satisfies GeminiClient;
    const record = getGlobalUploadStore().create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: await readFile(
        path.join(process.cwd(), "src/fixtures/uploads/statement-apple.png"),
      ),
    });

    const responses = [
      await postCompanyRead(
        new NextRequest("http://localhost/api/company/320193/read", { method: "POST" }),
        cikParams,
      ),
      await postCompanyModify(
        jsonPost("http://localhost/api/company/320193/modify", {
          action: "hide",
          numberRowIndex: 4,
          colIndex: 0,
          previousRows: CLEAN_ROWS,
        }),
        cikParams,
      ),
      await postUploadRead(
        new NextRequest(`http://localhost/api/upload/${record.id}/read`, { method: "POST" }),
        { params: Promise.resolve({ id: record.id }) },
      ),
      await postUploadModify(
        jsonPost(`http://localhost/api/upload/${record.id}/modify`, {
          action: "hide",
          numberRowIndex: 4,
          colIndex: 0,
        }),
        { params: Promise.resolve({ id: record.id }) },
      ),
    ];
    for (const response of responses) {
      expect(response.status).toBe(503);
      const payload = (await response.json()) as { code: string; error: string };
      expect(payload.code).toBe("missing_key");
      expect(payload.error).toBe(READING_UNAVAILABLE_MESSAGE);
    }
  });
});

describe("Streamed error events carry plain sentences", () => {
  test("a model that fails with raw detail reaches the visitor as one plain sentence", async () => {
    mocks.client = rawFailingClient;
    const record = getGlobalUploadStore().create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: await readFile(
        path.join(process.cwd(), "src/fixtures/uploads/statement-apple.png"),
      ),
    });

    const streams = [
      await postCompanyRead(
        new NextRequest("http://localhost/api/company/320193/read", { method: "POST" }),
        cikParams,
      ),
      await postCompanyModify(
        jsonPost("http://localhost/api/company/320193/modify", {
          action: "hide",
          numberRowIndex: 4,
          colIndex: 0,
          previousRows: CLEAN_ROWS,
        }),
        cikParams,
      ),
      await postUploadRead(
        new NextRequest(`http://localhost/api/upload/${record.id}/read`, { method: "POST" }),
        { params: Promise.resolve({ id: record.id }) },
      ),
    ];
    for (const response of streams) {
      expect(response.status).toBe(200);
      const all = events(await response.text());
      const error = all.find((event) => event.type === "error");
      expect(error).toBeDefined();
      if (error?.type === "error") {
        expect(error.message).toBe(MODEL_FAILED_MESSAGE);
        expectPlain(error.message);
      }
    }
    // The detail is not lost: it is in the server log.
    expect(
      vi.mocked(console.error).mock.calls.some((call) => String(call[0]).includes("RAW_DETAIL")),
    ).toBe(true);
  });

  test("a failed cell lookup on an uploaded picture does not show the raw detail either", async () => {
    mocks.client = rawFailingClient;
    const record = getGlobalUploadStore().create({
      fileName: "statement-apple.png",
      mimeType: "image/png",
      buffer: await readFile(
        path.join(process.cwd(), "src/fixtures/uploads/statement-apple.png"),
      ),
    });
    const response = await postUploadModify(
      jsonPost(`http://localhost/api/upload/${record.id}/modify`, {
        action: "hide",
        numberRowIndex: 4,
        colIndex: 0,
      }),
      { params: Promise.resolve({ id: record.id }) },
    );
    const text = await response.text();
    expect(text).not.toMatch(FORBIDDEN);
    expect(events(text).some((event) => event.type === "error")).toBe(true);
  });
});
