import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GET } from "@/app/api/companies/route";
import {
  CompanyListError,
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

  test("fixture holds ten companies with the required entries and order", () => {
    expect(fixtureCompanies).toHaveLength(10);
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

  test("returns a plain error when SEC_USER_AGENT is missing outside test mode", async () => {
    process.env.ADDS_UP_TEST = "0";
    delete process.env.SEC_USER_AGENT;
    resetCompanyListCache();

    await expect(loadCompanyList()).rejects.toBeInstanceOf(CompanyListError);

    const response = await GET(
      new NextRequest("http://localhost/api/companies?q=apple"),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string; companies: Company[] };
    expect(body.companies).toEqual([]);
    expect(body.error).toContain("SEC_USER_AGENT");
  });
});
