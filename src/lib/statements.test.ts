import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GET as getPictureRoute } from "@/app/api/company/[cik]/picture/route";
import {
  formatFilingDate,
  getGlobalStatementCache,
  loadStatement,
  parseFilingSummaryXml,
  parseSecReportHtml,
  parseSecSubmissions,
  StatementCache,
  StatementError,
  type Statement,
  type StatementNumberRow,
} from "./statements";

const FIXTURE_B_PATH = path.join(process.cwd(), "src/fixtures/sec-report-b.html");
const FIXTURE_SAVED_DIR = path.join(process.cwd(), "src/fixtures/saved");

describe("Reading the SEC's report table — section B of docs/test-cases.md", () => {
  let fixtureHtml: string;
  let parsed: Statement;
  let numberRows: StatementNumberRow[];

  beforeEach(async () => {
    fixtureHtml = await readFile(FIXTURE_B_PATH, "utf-8");
    parsed = parseSecReportHtml(fixtureHtml, {
      cik: "320193",
      companyName: "Apple Inc.",
      form: "10-K",
      filingDate: "2026-11-03",
    });
    numberRows = parsed.rows.filter(
      (row): row is StatementNumberRow => row.kind === "number",
    );
  });

  afterEach(() => {
    process.env.ADDS_UP_TEST = "1";
    delete process.env.SEC_USER_AGENT;
    getGlobalStatementCache().clear();
  });

  test("B1: statement has 1 heading row and 6 number rows, with no rows from authRefData", () => {
    const headings = parsed.rows.filter((row) => row.kind === "heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]?.label).toBe("Current assets:");
    expect(numberRows).toHaveLength(6);

    const allLabels = parsed.rows.map((row) => row.label);
    expect(allLabels).not.toContain("Definition 1");
    expect(allLabels).not.toContain("Definition 2");
    expect(allLabels).not.toContain("Definition 3");
  });

  test("B2: column headings are Sep. 26, 2026 and Sep. 27, 2025, and unit line is USD ($) $ in Millions", () => {
    expect(parsed.columns).toEqual(["Sep. 26, 2026", "Sep. 27, 2025"]);
    expect(parsed.unitLine).toBe("USD ($) $ in Millions");
    expect(parsed.title).toBe("CONSOLIDATED BALANCE SHEETS");
  });

  test("B3: row 3 gives 36305 and 35934 with dollar sign and commas removed", () => {
    // Row 3 of the report table is row index 1 in parsed.rows (after heading row 2).
    const row3 = parsed.rows[1];
    expect(row3?.kind).toBe("number");
    if (row3?.kind === "number") {
      expect(row3.label).toBe("Cash and cash equivalents");
      expect(row3.numbers).toEqual([36305, 35934]);
    }
  });

  test("B4: row 5 has the total flag and rows 3, 4, 6, 7 and 8 do not", () => {
    const flags = numberRows.map((row) => ({
      label: row.label,
      isTotal: row.isTotal,
    }));
    expect(flags).toEqual([
      { label: "Cash and cash equivalents", isTotal: false },
      { label: "Marketable securities", isTotal: false },
      { label: "Total current assets", isTotal: true },
      { label: "Accumulated deficit", isTotal: false },
      { label: "Commercial paper", isTotal: false },
      { label: "Term debt", isTotal: false },
    ]);
  });

  test("B5: row 6 gives -1234 and -987", () => {
    const row6 = numberRows[3];
    expect(row6?.label).toBe("Accumulated deficit");
    expect(row6?.numbers).toEqual([-1234, -987]);
  });

  test("B6: row 7 gives no value on the left and 1000 on the right", () => {
    const row7 = numberRows[4];
    expect(row7?.label).toBe("Commercial paper");
    expect(row7?.numbers).toEqual([null, 1000]);
    expect(row7?.values[0]).toBeNull();
  });

  test("B7: row 8 has label Term debt without footnote mark and no value on the right", () => {
    const row8 = numberRows[5];
    expect(row8?.label).toBe("Term debt");
    expect(row8?.numbers).toEqual([5000, null]);
    expect(row8?.values[1]).toBeNull();
  });

  test("B8: page with no report table gives a clear error and falls back to the saved copy", async () => {
    const badHtml =
      "<!doctype html><html><body><table class='other'><tr><td>No report here</td></tr></table></body></html>";

    expect(() =>
      parseSecReportHtml(badHtml, {
        cik: "320193",
        companyName: "Apple Inc.",
        form: "10-K",
        filingDate: "2026-11-03",
      }),
    ).toThrow(StatementError);

    expect(() =>
      parseSecReportHtml(badHtml, {
        cik: "320193",
        companyName: "Apple Inc.",
        form: "10-K",
        filingDate: "2026-11-03",
      }),
    ).toThrow(/report table/i);

    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("submissions/CIK0000320193.json")) {
        return new Response(
          JSON.stringify({
            name: "Apple Inc.",
            filings: {
              recent: {
                form: ["10-K"],
                filingDate: ["2026-11-03"],
                accessionNumber: ["0000320193-26-000106"],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/FilingSummary.xml")) {
        return new Response(
          `<FilingSummary><MyReports><Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>CONSOLIDATED BALANCE SHEETS</ShortName>
            <HtmlFileName>R5.htm</HtmlFileName>
          </Report></MyReports></FilingSummary>`,
          { status: 200 },
        );
      }
      return new Response(badHtml, { status: 200 });
    };

    const result = await loadStatement("320193", {
      companyName: "Apple Inc.",
      savedDir: FIXTURE_SAVED_DIR,
      fetchImpl: mockFetch,
      rateLimitMs: 0,
    });

    expect(result.source).toBe("saved");
    expect(result.statement.companyName).toBe("Apple Inc.");
    expect(result.fallbackReason).toMatch(/report table/i);
  });
});

describe("SEC steps 2-4, fallback, timeout and fixture statement", () => {
  afterEach(() => {
    process.env.ADDS_UP_TEST = "1";
    delete process.env.SEC_USER_AGENT;
    getGlobalStatementCache().clear();
  });

  test("parseSecSubmissions picks the newest 10-K or 10-Q and ignores other forms", () => {
    const latest = parseSecSubmissions({
      name: "Apple Inc.",
      filings: {
        recent: {
          form: ["8-K", "10-Q", "10-K", "DEF 14A"],
          filingDate: ["2026-11-15", "2026-08-01", "2026-11-03", "2026-01-10"],
          accessionNumber: [
            "0000320193-26-000110",
            "0000320193-26-000080",
            "0000320193-26-000106",
            "0000320193-26-000010",
          ],
        },
      },
    });

    expect(latest).toEqual({
      form: "10-K",
      filingDate: "2026-11-03",
      accessionNumber: "0000320193-26-000106",
      companyName: "Apple Inc.",
    });
  });

  test("parseFilingSummaryXml picks the first non-parenthetical Statements balance sheet", () => {
    const xml = `
      <FilingSummary>
        <MyReports>
          <Report>
            <MenuCategory>Cover</MenuCategory>
            <ShortName>Balance Sheet Cover</ShortName>
            <HtmlFileName>R1.htm</HtmlFileName>
          </Report>
          <Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>Consolidated Balance Sheets (Parenthetical)</ShortName>
            <HtmlFileName>R4.htm</HtmlFileName>
          </Report>
          <Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>Consolidated Statements of Financial Position</ShortName>
            <HtmlFileName>R5.htm</HtmlFileName>
          </Report>
        </MyReports>
      </FilingSummary>
    `;

    expect(parseFilingSummaryXml(xml)).toEqual({
      shortName: "Consolidated Statements of Financial Position",
      htmlFileName: "R5.htm",
    });
  });

  test("parseFilingSummaryXml finds a bank's balance sheet named Statements of Condition", () => {
    // Bank of Hawaii's quarterly report names its balance sheet this way.
    const xml = `
      <FilingSummary>
        <MyReports>
          <Report>
            <MenuCategory>Cover</MenuCategory>
            <ShortName>Cover page</ShortName>
            <HtmlFileName>R1.htm</HtmlFileName>
          </Report>
          <Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>Consolidated Statements of Condition (Unaudited)</ShortName>
            <HtmlFileName>R2.htm</HtmlFileName>
          </Report>
          <Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>Consolidated Statements of Condition (Unaudited) (Parenthetical)</ShortName>
            <HtmlFileName>R3.htm</HtmlFileName>
          </Report>
          <Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>Consolidated Statements of Income (Unaudited)</ShortName>
            <HtmlFileName>R4.htm</HtmlFileName>
          </Report>
        </MyReports>
      </FilingSummary>
    `;

    expect(parseFilingSummaryXml(xml)).toEqual({
      shortName: "Consolidated Statements of Condition (Unaudited)",
      htmlFileName: "R2.htm",
    });
  });

  test("follows steps 2 to 4 and sends SEC_USER_AGENT on every request", async () => {
    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";

    const fixtureHtml = await readFile(FIXTURE_B_PATH, "utf-8");
    const calls: Array<{ url: string; userAgent: string | undefined }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, userAgent: headers?.["User-Agent"] });

      if (url === "https://data.sec.gov/submissions/CIK0000320193.json") {
        return new Response(
          JSON.stringify({
            name: "Apple Inc.",
            filings: {
              recent: {
                form: ["10-K"],
                filingDate: ["2026-11-03"],
                accessionNumber: ["0000320193-26-000106"],
              },
            },
          }),
          { status: 200 },
        );
      }

      if (
        url ===
        "https://www.sec.gov/Archives/edgar/data/320193/000032019326000106/FilingSummary.xml"
      ) {
        return new Response(
          `<FilingSummary><MyReports><Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>CONSOLIDATED BALANCE SHEETS</ShortName>
            <HtmlFileName>R5.htm</HtmlFileName>
          </Report></MyReports></FilingSummary>`,
          { status: 200 },
        );
      }

      if (
        url ===
        "https://www.sec.gov/Archives/edgar/data/320193/000032019326000106/R5.htm"
      ) {
        return new Response(fixtureHtml, { status: 200 });
      }

      return new Response("Not found", { status: 404 });
    };

    const result = await loadStatement("0000320193", {
      companyName: "Apple Inc.",
      fetchImpl: mockFetch,
      rateLimitMs: 0,
    });

    expect(result.source).toBe("sec");
    expect(result.statement.form).toBe("10-K");
    expect(result.statement.filingDate).toBe("2026-11-03");
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.userAgent).toBe("AddsUpTestAgent/1.0");
    }
  });

  test("falls back to saved copy when SEC times out", async () => {
    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";

    const hangingFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });

    const result = await loadStatement("320193", {
      savedDir: FIXTURE_SAVED_DIR,
      fetchImpl: hangingFetch,
      timeoutMs: 30,
      rateLimitMs: 0,
    });

    expect(result.source).toBe("saved");
    expect(result.statement.companyName).toBe("Apple Inc.");
    expect(result.fallbackReason).toMatch(/8 seconds/i);
  });

  test("when SEC_USER_AGENT is missing outside test mode, uses saved copy if present and errors plainly otherwise", async () => {
    process.env.ADDS_UP_TEST = "0";
    delete process.env.SEC_USER_AGENT;

    const savedResult = await loadStatement("320193", {
      savedDir: FIXTURE_SAVED_DIR,
    });
    expect(savedResult.source).toBe("saved");
    expect(savedResult.statement.cik).toBe("320193");

    await expect(
      loadStatement("999999", { savedDir: FIXTURE_SAVED_DIR }),
    ).rejects.toThrow(/SEC_USER_AGENT/i);
  });

  test("test mode returns Apple Inc. fixture with case C11 left values and section D right values", async () => {
    process.env.ADDS_UP_TEST = "1";
    const result = await loadStatement("320193");

    expect(result.source).toBe("fixture");
    expect(result.statement.companyName).toBe("Apple Inc.");
    expect(result.statement.form).toBe("10-K");
    expect(result.statement.filingDate).toBe("2026-11-03");
    expect(formatFilingDate(result.statement.filingDate)).toBe("Nov 3, 2026");

    const numberRows = result.statement.rows.filter(
      (row): row is StatementNumberRow => row.kind === "number",
    );
    const currentAssetRows = numberRows.slice(0, 7);
    expect(currentAssetRows.map((row) => row.numbers[0])).toEqual([
      36305, 20417, 43817, 39896, 14541, 18881, 173857,
    ]);
    expect(currentAssetRows.map((row) => row.numbers[1])).toEqual([
      35934, 18763, 39777, 33180, 5718, 14585, 147957,
    ]);
  });

  test("GET /api/company/[cik]/picture returns a PNG in test mode without calling the SEC", async () => {
    process.env.ADDS_UP_TEST = "1";

    const response = await getPictureRoute(
      new NextRequest("http://localhost/api/company/320193/picture"),
      { params: Promise.resolve({ cik: "320193" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");

    const bytes = new Uint8Array(await response.arrayBuffer());
    // PNG magic signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(bytes.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(bytes.byteLength).toBeGreaterThan(2000);
  });

  test("caches fetched SEC statement in memory for one hour so a second load makes no fetch", async () => {
    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";

    const fixtureHtml = await readFile(FIXTURE_B_PATH, "utf-8");
    let now = 1_700_000_000_000;
    const cache = new StatementCache({ now: () => now });
    let fetchCount = 0;

    const mockFetch: typeof fetch = async (input) => {
      fetchCount += 1;
      const url = String(input);
      if (url.includes("submissions/CIK0000320193.json")) {
        return new Response(
          JSON.stringify({
            name: "Apple Inc.",
            filings: {
              recent: {
                form: ["10-K"],
                filingDate: ["2026-11-03"],
                accessionNumber: ["0000320193-26-000106"],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/FilingSummary.xml")) {
        return new Response(
          `<FilingSummary><MyReports><Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>CONSOLIDATED BALANCE SHEETS</ShortName>
            <HtmlFileName>R5.htm</HtmlFileName>
          </Report></MyReports></FilingSummary>`,
          { status: 200 },
        );
      }
      return new Response(fixtureHtml, { status: 200 });
    };

    const first = await loadStatement("0000320193", {
      companyName: "Apple Inc.",
      fetchImpl: mockFetch,
      rateLimitMs: 0,
      cache,
    });
    expect(first.source).toBe("sec");
    expect(fetchCount).toBe(3);

    // 30 minutes later: still inside the one-hour window, so no SEC fetch is made.
    now += 30 * 60 * 1000;
    const second = await loadStatement("320193", {
      companyName: "Apple Inc.",
      fetchImpl: mockFetch,
      rateLimitMs: 0,
      cache,
    });
    expect(second.source).toBe("sec");
    expect(second.statement).toEqual(first.statement);
    expect(fetchCount).toBe(3);

    // Past one hour: cache entry expires and a fresh SEC fetch runs.
    now += 31 * 60 * 1000;
    const third = await loadStatement("320193", {
      companyName: "Apple Inc.",
      fetchImpl: mockFetch,
      rateLimitMs: 0,
      cache,
    });
    expect(third.source).toBe("sec");
    expect(fetchCount).toBe(6);
  });

  test("deduplicates concurrent loads for the same company into one SEC fetch", async () => {
    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";

    const fixtureHtml = await readFile(FIXTURE_B_PATH, "utf-8");
    const cache = new StatementCache();
    let fetchCount = 0;
    const controls: { releaseSubmissions?: () => void } = {};
    const submissionsGate = new Promise<void>((resolve) => {
      controls.releaseSubmissions = resolve;
    });

    const mockFetch: typeof fetch = async (input) => {
      fetchCount += 1;
      const url = String(input);
      if (url.includes("submissions/CIK0000320193.json")) {
        await submissionsGate;
        return new Response(
          JSON.stringify({
            name: "Apple Inc.",
            filings: {
              recent: {
                form: ["10-K"],
                filingDate: ["2026-11-03"],
                accessionNumber: ["0000320193-26-000106"],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/FilingSummary.xml")) {
        return new Response(
          `<FilingSummary><MyReports><Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>CONSOLIDATED BALANCE SHEETS</ShortName>
            <HtmlFileName>R5.htm</HtmlFileName>
          </Report></MyReports></FilingSummary>`,
          { status: 200 },
        );
      }
      return new Response(fixtureHtml, { status: 200 });
    };

    const loadA = loadStatement("320193", {
      companyName: "Apple Inc.",
      savedDir: path.join(process.cwd(), "src/fixtures/does-not-exist"),
      fetchImpl: mockFetch,
      rateLimitMs: 0,
      cache,
    });
    const loadB = loadStatement("0000320193", {
      companyName: "Apple Inc.",
      savedDir: path.join(process.cwd(), "src/fixtures/does-not-exist"),
      fetchImpl: mockFetch,
      rateLimitMs: 0,
      cache,
    });

    // Give both calls a tick to join the shared in-flight fetch before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controls.releaseSubmissions?.();

    const [resA, resB] = await Promise.all([loadA, loadB]);
    expect(resA.source).toBe("sec");
    expect(resB.source).toBe("sec");
    expect(resA.statement).toEqual(resB.statement);
    // Only one 3-request SEC fetch ran for both callers.
    expect(fetchCount).toBe(3);
  });

  test("slow SEC with a saved copy answers with the saved copy within the shortened timeout and caches the SEC answer when it arrives", async () => {
    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";

    const fixtureHtml = await readFile(FIXTURE_B_PATH, "utf-8");
    const cache = new StatementCache();
    let fetchCount = 0;
    const controls: { releaseSec?: () => void } = {};
    const secGate = new Promise<void>((resolve) => {
      controls.releaseSec = resolve;
    });

    const mockFetch: typeof fetch = async (input) => {
      fetchCount += 1;
      const url = String(input);
      if (url.includes("submissions/CIK0000320193.json")) {
        await secGate;
        return new Response(
          JSON.stringify({
            name: "Apple Inc.",
            filings: {
              recent: {
                form: ["10-K"],
                filingDate: ["2026-11-20"],
                accessionNumber: ["0000320193-26-000106"],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/FilingSummary.xml")) {
        return new Response(
          `<FilingSummary><MyReports><Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>CONSOLIDATED BALANCE SHEETS</ShortName>
            <HtmlFileName>R5.htm</HtmlFileName>
          </Report></MyReports></FilingSummary>`,
          { status: 200 },
        );
      }
      return new Response(fixtureHtml, { status: 200 });
    };

    const startedAt = Date.now();
    const first = await loadStatement("320193", {
      companyName: "Apple Inc.",
      savedDir: FIXTURE_SAVED_DIR,
      fetchImpl: mockFetch,
      savedFallbackTimeoutMs: 40,
      timeoutMs: 5_000,
      rateLimitMs: 0,
      cache,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(first.source).toBe("saved");
    expect(first.statement.companyName).toBe("Apple Inc.");
    expect(first.statement.filingDate).toBe("2026-11-03");
    expect(elapsedMs).toBeLessThan(1_000);

    // Now let the slow SEC fetch finish in the background.
    controls.releaseSec?.();
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The next view gets the SEC's answer from memory with no extra SEC fetch.
    const second = await loadStatement("320193", {
      companyName: "Apple Inc.",
      savedDir: FIXTURE_SAVED_DIR,
      fetchImpl: mockFetch,
      savedFallbackTimeoutMs: 40,
      timeoutMs: 5_000,
      rateLimitMs: 0,
      cache,
    });
    expect(second.source).toBe("sec");
    expect(second.statement.filingDate).toBe("2026-11-20");
    expect(fetchCount).toBe(3);
  });

  test("without a saved copy, keeps waiting past the 3-second saved-copy timeout up to the 8-second SEC timeout", async () => {
    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";

    const fixtureHtml = await readFile(FIXTURE_B_PATH, "utf-8");
    const cache = new StatementCache();

    const slowFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("submissions/CIK0000999999.json")) {
        await new Promise((resolve) => setTimeout(resolve, 70));
        return new Response(
          JSON.stringify({
            name: "No Saved Copy Corp.",
            filings: {
              recent: {
                form: ["10-K"],
                filingDate: ["2026-11-10"],
                accessionNumber: ["0000999999-26-000001"],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/FilingSummary.xml")) {
        return new Response(
          `<FilingSummary><MyReports><Report>
            <MenuCategory>Statements</MenuCategory>
            <ShortName>CONSOLIDATED BALANCE SHEETS</ShortName>
            <HtmlFileName>R5.htm</HtmlFileName>
          </Report></MyReports></FilingSummary>`,
          { status: 200 },
        );
      }
      return new Response(fixtureHtml, { status: 200 });
    };

    const result = await loadStatement("999999", {
      companyName: "No Saved Copy Corp.",
      savedDir: FIXTURE_SAVED_DIR,
      fetchImpl: slowFetch,
      savedFallbackTimeoutMs: 25,
      timeoutMs: 2_000,
      rateLimitMs: 0,
      cache,
    });

    expect(result.source).toBe("sec");
    expect(result.statement.companyName).toBe("No Saved Copy Corp.");
  });
});
