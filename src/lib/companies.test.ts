import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GET } from "@/app/api/companies/route";
import { GET as getStatementRoute } from "@/app/api/company/[cik]/statement/route";
import { GET as getPictureRoute } from "@/app/api/company/[cik]/picture/route";
import { POST as postReadRoute } from "@/app/api/company/[cik]/read/route";
import { POST as postModifyRoute } from "@/app/api/company/[cik]/modify/route";
import { POST as postCauseRoute } from "@/app/api/company/[cik]/cause/route";
import { proxy } from "@/proxy";
import {
  isValidCik,
  loadCompanyList,
  resetCompanyListCache,
  searchCompanies,
  type Company,
} from "./companies";

describe("Company search — section A of docs/test-cases.md", () => {
  let fixtureCompanies: Company[];

  beforeEach(async () => {
    process.env.ADDS_UP_TEST = "1";
    resetCompanyListCache();
    fixtureCompanies = await loadCompanyList();
  });

  afterEach(() => {
    process.env.ADDS_UP_TEST = "1";
    delete process.env.SEC_USER_AGENT;
    resetCompanyListCache();
    vi.restoreAllMocks();
  });

  test("fixture holds eleven companies with the required entries and order", () => {
    expect(fixtureCompanies).toHaveLength(11);
    const names = fixtureCompanies.map((c) => c.name);
    expect(names).toContain("Apple Inc.");
    expect(names).toContain("Apple Hospitality REIT, Inc.");
    expect(names).toContain("Applied Materials, Inc.");
    expect(names).toContain("Microsoft Corp");
    expect(names.indexOf("Apple Inc.")).toBeLessThan(
      names.indexOf("Apple Hospitality REIT, Inc."),
    );
  });

  test("A1: typing 'apple' returns Apple Inc. as the first match", () => {
    const matches = searchCompanies(fixtureCompanies, "apple");
    expect(matches[0]?.name).toBe("Apple Inc.");
    expect(matches[0]?.ticker).toBe("AAPL");
  });

  test("A2: typing 'app' matches both Apple Inc. and Applied Materials, Inc.", () => {
    const matches = searchCompanies(fixtureCompanies, "app");
    const names = matches.map((c) => c.name);
    expect(names).toContain("Apple Inc.");
    expect(names).toContain("Applied Materials, Inc.");
  });

  test("A3: typing 'AAPL' matches Apple Inc. by its ticker", () => {
    const matches = searchCompanies(fixtureCompanies, "AAPL");
    expect(matches[0]?.name).toBe("Apple Inc.");
    expect(matches[0]?.ticker).toBe("AAPL");
  });

  test("A4: typing '  Apple  ' gives the same result as A1", () => {
    const a1 = searchCompanies(fixtureCompanies, "apple");
    const a4 = searchCompanies(fixtureCompanies, "  Apple  ");
    expect(a4).toEqual(a1);
  });

  test("A5: typing 'MICROSOFT' matches Microsoft Corp regardless of case", () => {
    const matches = searchCompanies(fixtureCompanies, "MICROSOFT");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Microsoft Corp");
  });

  test("A6: typing 'zzzz' returns no matches", () => {
    const matches = searchCompanies(fixtureCompanies, "zzzz");
    expect(matches).toEqual([]);
  });

  test("A7: typing nothing returns no matches", () => {
    expect(searchCompanies(fixtureCompanies, "")).toEqual([]);
    expect(searchCompanies(fixtureCompanies, "   ")).toEqual([]);
  });

  test("A8: typing 'apple' puts Apple Inc. before Apple Hospitality REIT, Inc.", () => {
    const matches = searchCompanies(fixtureCompanies, "apple");
    expect(matches.map((c) => c.name)).toEqual([
      "Apple Inc.",
      "Apple Hospitality REIT, Inc.",
    ]);
  });
});

describe("Company search ranking, limit, caching and SEC route", () => {
  afterEach(() => {
    process.env.ADDS_UP_TEST = "1";
    delete process.env.SEC_USER_AGENT;
    resetCompanyListCache();
    vi.restoreAllMocks();
  });

  test("ranks exact ticker first, then name prefixes in the list's own order, then other matches, max 6 rows", () => {
    const list: Company[] = [
      { cik: "1", ticker: "ZCAT", name: "Global Cat Holdings" },
      { cik: "2", ticker: "CATH", name: "Caterpillar Heavy Machinery Corp" },
      { cik: "3", ticker: "CATX", name: "Cat Co" },
      { cik: "4", ticker: "CAT", name: "Caterpillar Inc." },
      { cik: "5", ticker: "CATB", name: "Cat Bakery" },
      { cik: "6", ticker: "CATC", name: "Cat Cafe Group" },
      { cik: "7", ticker: "CATD", name: "Cat Diagnostics Ltd" },
      { cik: "8", ticker: "CATE", name: "Cat Energy Partners" },
    ];

    const matches = searchCompanies(list, "cat");
    expect(matches).toHaveLength(6);
    expect(matches.map((c) => c.ticker)).toEqual([
      "CAT", // exact ticker match
      "CATH", // name prefixes follow in the list's own order
      "CATX",
      "CATB",
      "CATC",
      "CATD",
    ]);
  });

  test("places substring matches after name-prefix matches", () => {
    const list: Company[] = [
      { cik: "1", ticker: "SUB", name: "Big Apple Ventures" },
      { cik: "3", ticker: "AAPL", name: "Apple Inc." },
      { cik: "2", ticker: "LONG", name: "Apple Hospitality REIT, Inc." },
    ];

    const matches = searchCompanies(list, "apple");
    expect(matches.map((c) => c.name)).toEqual([
      "Apple Inc.",
      "Apple Hospitality REIT, Inc.",
      "Big Apple Ventures",
    ]);
  });

  test("GET /api/companies returns ranked matches in test mode and handles empty query", async () => {
    process.env.ADDS_UP_TEST = "1";
    resetCompanyListCache();

    const emptyRes = await GET(new NextRequest("http://localhost/api/companies?q="));
    expect(emptyRes.status).toBe(200);
    expect(await emptyRes.json()).toEqual({ companies: [] });

    const appleRes = await GET(
      new NextRequest("http://localhost/api/companies?q=apple"),
    );
    expect(appleRes.status).toBe(200);
    const body = (await appleRes.json()) as { companies: Company[] };
    expect(body.companies.map((c) => c.name)).toEqual([
      "Apple Inc.",
      "Apple Hospitality REIT, Inc.",
    ]);
  });

  test("loads SEC company list once in memory and sends SEC_USER_AGENT outside test mode", async () => {
    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";
    resetCompanyListCache();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const first = await loadCompanyList();
    const second = await loadCompanyList();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)["User-Agent"]).toBe(
      "AddsUpTestAgent/1.0",
    );
    expect(first).toEqual([{ cik: "320193", ticker: "AAPL", name: "Apple Inc." }]);
    expect(second).toBe(first);
  });

  test("falls back to data/saved/ and src/fixtures/ when SEC_USER_AGENT is missing outside test mode", async () => {
    process.env.ADDS_UP_TEST = "0";
    delete process.env.SEC_USER_AGENT;
    resetCompanyListCache();

    const fallback = await loadCompanyList();
    expect(fallback.length).toBeGreaterThan(10);
    expect(fallback.some((c) => c.cik === "320193")).toBe(true);
    expect(fallback.some((c) => c.cik === "1326801")).toBe(true);

    const response = await GET(
      new NextRequest("http://localhost/api/companies?q=facebook"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error?: string; companies: Company[] };
    expect(body.error).toBeUndefined();
    expect(body.companies[0]?.cik).toBe("1326801");
  });

  test("falls back when SEC takes longer than timeout and tries SEC again on a later request", async () => {
    process.env.ADDS_UP_TEST = "0";
    process.env.SEC_USER_AGENT = "AddsUpTestAgent/1.0";
    resetCompanyListCache();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise<Response>(() => {
            // Simulates a hanging SEC response.
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
            "1": { cik_str: 1652044, ticker: "GOOGL", title: "Alphabet Inc." },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const startedAt = Date.now();
    const first = await loadCompanyList({ timeoutMs: 40 });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(first.some((c) => c.cik === "320193")).toBe(true);
    expect(first.some((c) => c.cik === "1326801")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A later request tries the SEC again and caches the SEC list once it succeeds.
    const second = await loadCompanyList({ timeoutMs: 1_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).toEqual([
      { cik: "320193", ticker: "AAPL", name: "Apple Inc." },
      { cik: "1652044", ticker: "GOOGL", name: "Alphabet Inc." },
    ]);

    const third = await loadCompanyList({ timeoutMs: 1_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(third).toBe(second);
  });
});

describe("Everyday company names and aliases (H2)", () => {
  const realSecCompanies: Company[] = [
    { cik: "1652044", ticker: "GOOGL", name: "Alphabet Inc." },
    { cik: "1326801", ticker: "META", name: "Meta Platforms, Inc." },
    { cik: "1018724", ticker: "AMZN", name: "AMAZON COM INC" },
    { cik: "63908", ticker: "MCD", name: "MCDONALDS CORP" },
    { cik: "317540", ticker: "COKE", name: "Coca-Cola Consolidated, Inc." },
    { cik: "21344", ticker: "KO", name: "COCA COLA CO" },
    { cik: "34088", ticker: "XOM", name: "EXXON MOBIL CORP" },
    { cik: "2115436", ticker: "XOMH", name: "ExxonMobil Holdings Corp" },
    { cik: "1283699", ticker: "TMUS", name: "T-Mobile US, Inc." },
    { cik: "200406", ticker: "JNJ", name: "JOHNSON & JOHNSON" },
    { cik: "80424", ticker: "PG", name: "PROCTER & GAMBLE Co" },
    { cik: "830524", ticker: "CCF", name: "Chase Corp" },
    { cik: "19617", ticker: "JPM", name: "JPMORGAN CHASE & CO" },
  ];

  const cases: ReadonlyArray<{ typed: string; expectedCik: string; label: string }> = [
    { typed: "google", expectedCik: "1652044", label: "Alphabet Inc." },
    { typed: "facebook", expectedCik: "1326801", label: "Meta Platforms" },
    { typed: "instagram", expectedCik: "1326801", label: "Meta Platforms" },
    { typed: "youtube", expectedCik: "1652044", label: "Alphabet Inc." },
    { typed: "waymo", expectedCik: "1652044", label: "Alphabet Inc." },
    { typed: "whatsapp", expectedCik: "1326801", label: "Meta Platforms" },
    { typed: "chase", expectedCik: "19617", label: "JPMorgan Chase" },
    { typed: "amazon.com", expectedCik: "1018724", label: "AMAZON COM INC" },
    { typed: "mcdonald's", expectedCik: "63908", label: "MCDONALDS CORP" },
    { typed: "coca-cola", expectedCik: "317540", label: "Coca-Cola in SEC order" },
    { typed: "coke", expectedCik: "21344", label: "COCA COLA CO" },
    { typed: "exxon mobil", expectedCik: "34088", label: "EXXON MOBIL CORP" },
    { typed: "t mobile", expectedCik: "1283699", label: "T-Mobile US, Inc." },
    { typed: "j&j", expectedCik: "200406", label: "JOHNSON & JOHNSON" },
    { typed: "procter and gamble", expectedCik: "80424", label: "PROCTER & GAMBLE Co" },
    { typed: "jp morgan", expectedCik: "19617", label: "JPMORGAN CHASE & CO" },
  ];

  for (const { typed, expectedCik, label } of cases) {
    test(`typing '${typed}' finds ${label} (${expectedCik})`, () => {
      const matches = searchCompanies(realSecCompanies, typed);
      expect(matches[0]?.cik).toBe(expectedCik);
    });
  }

  test("typing 'coca-cola' finds both Coca-Cola companies in SEC list order", () => {
    const matches = searchCompanies(realSecCompanies, "coca-cola");
    expect(matches.map((c) => c.cik)).toEqual(["317540", "21344"]);
  });

  test("typing 'exxon mobil' matches both spaced and joined ExxonMobil names", () => {
    const matches = searchCompanies(realSecCompanies, "exxon mobil");
    expect(matches.map((c) => c.cik)).toEqual(["34088", "2115436"]);
  });
});

describe("CIK validation across routes and proxy (H2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("isValidCik accepts 1 to 10 digits only", () => {
    expect(isValidCik("0")).toBe(true);
    expect(isValidCik("320193")).toBe(true);
    expect(isValidCik("0000320193")).toBe(true);
    expect(isValidCik("1234567890")).toBe(true);

    expect(isValidCik("")).toBe(false);
    expect(isValidCik("12345678901")).toBe(false);
    expect(isValidCik("abc")).toBe(false);
    expect(isValidCik("320193a")).toBe(false);
    expect(isValidCik("..")).toBe(false);
    expect(isValidCik("../scores")).toBe(false);
    expect(isValidCik(" 320193")).toBe(false);
    expect(isValidCik("-320193")).toBe(false);
  });

  test("all /api/company/[cik]/* routes and /company/[cik] proxy answer 404 before any request for invalid CIKs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    // The route handlers get the decoded value straight from Next, so ".." and "../scores"
    // reach them as written.
    for (const badCik of ["abc", "12345678901", "..", "../scores", "320193a"]) {
      const params = Promise.resolve({ cik: badCik });

      const stmtRes = await getStatementRoute(
        new NextRequest(`http://localhost/api/company/${badCik}/statement`),
        { params },
      );
      expect(stmtRes.status).toBe(404);

      const picRes = await getPictureRoute(
        new NextRequest(`http://localhost/api/company/${badCik}/picture`),
        { params },
      );
      expect(picRes.status).toBe(404);

      const readRes = await postReadRoute(
        new NextRequest(`http://localhost/api/company/${badCik}/read`, {
          method: "POST",
        }),
        { params },
      );
      expect(readRes.status).toBe(404);

      const modRes = await postModifyRoute(
        new NextRequest(`http://localhost/api/company/${badCik}/modify`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        { params },
      );
      expect(modRes.status).toBe(404);

      const causeRes = await postCauseRoute(
        new NextRequest(`http://localhost/api/company/${badCik}/cause`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        { params },
      );
      expect(causeRes.status).toBe(404);
    }

    // A bare ".." never reaches the proxy as a company: URL parsing turns /company/.. into /.
    // So the proxy gets only values that stay in the path, including encoded traversal.
    for (const badPath of [
      "abc",
      "12345678901",
      "320193a",
      "..%2Fscores",
      "%2e%2e%2fscores",
      "1%2F2",
    ]) {
      const request = new NextRequest(`http://localhost/company/${badPath}`);
      expect(request.nextUrl.pathname).toBe(`/company/${badPath}`);
      expect(proxy(request).status).toBe(404);
    }

    const validProxyRes = proxy(new NextRequest("http://localhost/company/320193"));
    expect(validProxyRes.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
