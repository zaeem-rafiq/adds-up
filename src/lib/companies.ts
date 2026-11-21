import { readFile } from "node:fs/promises";
import path from "node:path";

export type Company = {
  cik: string;
  ticker: string;
  name: string;
};

export class CompanyListError extends Error {
  readonly status: number;

  constructor(message: string, status = 503) {
    super(message);
    this.name = "CompanyListError";
    this.status = status;
  }
}

const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const MAX_SEARCH_RESULTS = 6;

let cachedCompanies: Company[] | null = null;
let cachedInTestMode: boolean | null = null;
let inFlightLoad: Promise<Company[]> | null = null;

export function normalizeCik(value: string | number): string {
  const digits = String(value).trim().replace(/^0+/, "");
  return digits.length > 0 ? digits : "0";
}

export function parseSecCompanyTickers(raw: unknown): Company[] {
  if (!raw || typeof raw !== "object") {
    throw new CompanyListError("The SEC company list had an unexpected format.", 502);
  }

  const companies: Company[] = [];
  for (const entry of Object.values(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rawCik = record.cik_str;
    const rawTicker = record.ticker;
    const rawTitle = record.title;

    if (
      (typeof rawCik !== "number" && typeof rawCik !== "string") ||
      typeof rawTicker !== "string" ||
      typeof rawTitle !== "string"
    ) {
      continue;
    }

    const ticker = rawTicker.trim();
    const name = rawTitle.trim();
    if (!ticker || !name) continue;

    companies.push({
      cik: normalizeCik(rawCik),
      ticker,
      name,
    });
  }

  return companies;
}

export function searchCompanies(
  companies: readonly Company[],
  rawQuery: string,
  limit = MAX_SEARCH_RESULTS,
): Company[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const exactTicker: Company[] = [];
  const namePrefix: Company[] = [];
  const otherMatches: Company[] = [];

  for (const company of companies) {
    const tickerLower = company.ticker.toLowerCase();
    const nameLower = company.name.toLowerCase();

    if (tickerLower === query) {
      exactTicker.push(company);
    } else if (nameLower.startsWith(query)) {
      namePrefix.push(company);
    } else if (tickerLower.includes(query) || nameLower.includes(query)) {
      otherMatches.push(company);
    }
  }

  // Names keep the SEC list's own order, which puts the largest companies first.
  // One company can have several tickers, so each SEC number shows once.
  const seen = new Set<string>();
  const ranked: Company[] = [];
  for (const company of [...exactTicker, ...namePrefix, ...otherMatches]) {
    if (seen.has(company.cik)) continue;
    seen.add(company.cik);
    ranked.push(company);
    if (ranked.length === limit) break;
  }
  return ranked;
}

async function fetchCompaniesFromSource(testMode: boolean): Promise<Company[]> {
  if (testMode) {
    const fixturePath = path.join(process.cwd(), "src/fixtures/company-tickers.json");
    const contents = await readFile(fixturePath, "utf-8");
    return parseSecCompanyTickers(JSON.parse(contents));
  }

  const userAgent = process.env.SEC_USER_AGENT?.trim();
  if (!userAgent) {
    throw new CompanyListError(
      "Company search is unavailable because SEC_USER_AGENT is not set on the server.",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(SEC_COMPANY_TICKERS_URL, {
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CompanyListError(
      "Could not reach the SEC company list right now. Please try again.",
      502,
    );
  }

  if (!response.ok) {
    throw new CompanyListError(
      "Could not load the SEC company list right now. Please try again.",
      502,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new CompanyListError("The SEC company list could not be read.", 502);
  }

  return parseSecCompanyTickers(data);
}

export async function loadCompanyList(): Promise<Company[]> {
  const testMode = process.env.ADDS_UP_TEST === "1";

  if (cachedCompanies && cachedInTestMode === testMode) {
    return cachedCompanies;
  }

  if (inFlightLoad && cachedInTestMode === testMode) {
    return inFlightLoad;
  }

  cachedInTestMode = testMode;
  const pending = fetchCompaniesFromSource(testMode)
    .then((companies) => {
      cachedCompanies = companies;
      return companies;
    })
    .finally(() => {
      if (inFlightLoad === pending) {
        inFlightLoad = null;
      }
    });

  inFlightLoad = pending;
  return pending;
}

export async function findCompanyByCik(rawCik: string): Promise<Company | null> {
  const target = normalizeCik(rawCik);
  const companies = await loadCompanyList();
  return companies.find((company) => company.cik === target) ?? null;
}

export function resetCompanyListCache(): void {
  cachedCompanies = null;
  cachedInTestMode = null;
  inFlightLoad = null;
}
