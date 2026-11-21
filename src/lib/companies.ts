import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isValidCik } from "./cik";

export { isValidCik };

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
export const SEC_COMPANY_LIST_TIMEOUT_MS = 3_000;

const COMPANY_ALIASES: ReadonlyArray<{ alias: string; cik: string }> = [
  { alias: "google", cik: "1652044" },
  { alias: "youtube", cik: "1652044" },
  { alias: "waymo", cik: "1652044" },
  { alias: "facebook", cik: "1326801" },
  { alias: "instagram", cik: "1326801" },
  { alias: "whatsapp", cik: "1326801" },
  { alias: "chase", cik: "19617" },
  { alias: "coke", cik: "21344" },
  { alias: "j&j", cik: "200406" },
];

let cachedCompanies: Company[] | null = null;
let cachedInTestMode: boolean | null = null;
let cachedFallbackCompanies: Company[] | null = null;
let inFlightLoad: Promise<Company[]> | null = null;


export function normalizeCik(value: string | number): string {
  const digits = String(value).trim().replace(/^0+/, "");
  return digits.length > 0 ? digits : "0";
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compactSearchText(normalized: string): string {
  return normalized.replace(/ /g, "");
}

const NORMALIZED_ALIASES = COMPANY_ALIASES.map(({ alias, cik }) => {
  const spaced = normalizeSearchText(alias);
  return {
    spaced,
    compact: compactSearchText(spaced),
    cik,
  };
});

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
  const queryLower = rawQuery.trim().toLowerCase();
  if (!queryLower) return [];

  const querySpaced = normalizeSearchText(rawQuery);
  const queryCompact = compactSearchText(querySpaced);
  if (!querySpaced) return [];

  const aliasCiks = new Set<string>();
  for (const entry of NORMALIZED_ALIASES) {
    if (querySpaced === entry.spaced || queryCompact === entry.compact) {
      aliasCiks.add(entry.cik);
    }
  }

  const aliasMatches: Company[] = [];
  const exactTicker: Company[] = [];
  const namePrefix: Company[] = [];
  const otherMatches: Company[] = [];

  for (const company of companies) {
    if (aliasCiks.has(company.cik)) {
      aliasMatches.push(company);
    }

    const hasTicker = company.ticker.length > 0;
    const tickerLower = company.ticker.toLowerCase();
    const tickerSpaced = hasTicker ? normalizeSearchText(company.ticker) : "";
    const tickerCompact = hasTicker ? compactSearchText(tickerSpaced) : "";
    const nameSpaced = normalizeSearchText(company.name);
    const nameCompact = compactSearchText(nameSpaced);

    if (
      hasTicker &&
      (tickerLower === queryLower ||
        tickerSpaced === querySpaced ||
        tickerCompact === queryCompact)
    ) {
      exactTicker.push(company);
    } else if (
      nameSpaced.startsWith(querySpaced) ||
      nameCompact.startsWith(queryCompact)
    ) {
      namePrefix.push(company);
    } else if (
      (hasTicker &&
        (tickerLower.includes(queryLower) ||
          tickerSpaced.includes(querySpaced) ||
          tickerCompact.includes(queryCompact))) ||
      nameSpaced.includes(querySpaced) ||
      nameCompact.includes(queryCompact)
    ) {
      otherMatches.push(company);
    }
  }

  // Alias hits come first, then exact ticker, then names in the SEC list's own order.
  // One company can have several tickers, so each SEC number shows once.
  const seen = new Set<string>();
  const ranked: Company[] = [];
  for (const company of [
    ...aliasMatches,
    ...exactTicker,
    ...namePrefix,
    ...otherMatches,
  ]) {
    if (seen.has(company.cik)) continue;
    seen.add(company.cik);
    ranked.push(company);
    if (ranked.length === limit) break;
  }
  return ranked;
}

async function loadFallbackCompanies(): Promise<Company[]> {
  if (cachedFallbackCompanies) {
    return cachedFallbackCompanies;
  }

  const byCik = new Map<string, Company>();

  try {
    const fixturePath = path.join(
      process.cwd(),
      "src/fixtures/company-tickers.json",
    );
    const contents = await readFile(fixturePath, "utf-8");
    for (const company of parseSecCompanyTickers(JSON.parse(contents))) {
      if (!byCik.has(company.cik)) {
        byCik.set(company.cik, company);
      }
    }
  } catch {
    // Continue reading statement files if company-tickers fixture is unavailable.
  }

  const statementDirs = [
    path.join(process.cwd(), "data/saved"),
    path.join(process.cwd(), "src/fixtures/saved"),
    path.join(process.cwd(), "src/fixtures"),
  ];

  for (const dir of statementDirs) {
    let entries: string[];
    try {
      entries = (await readdir(/* turbopackIgnore: true */ dir))
        .filter((fileName) => fileName.endsWith(".json"))
        .sort();
    } catch {
      continue;
    }

    for (const fileName of entries) {
      if (
        fileName === "company-tickers.json" ||
        fileName === "cutoffs-test.json"
      ) {
        continue;
      }
      try {
        const filePath = path.join(/* turbopackIgnore: true */ dir, fileName);
        const parsed: unknown = JSON.parse(
          await readFile(/* turbopackIgnore: true */ filePath, "utf-8"),
        );
        if (!parsed || typeof parsed !== "object") continue;
        const record = parsed as Record<string, unknown>;
        if (
          (typeof record.cik !== "string" && typeof record.cik !== "number") ||
          typeof record.companyName !== "string"
        ) {
          continue;
        }
        const cik = normalizeCik(record.cik);
        const name = record.companyName.trim();
        if (!cik || !name) continue;
        if (!byCik.has(cik)) {
          byCik.set(cik, { cik, ticker: "", name });
        }
      } catch {
        // Ignore malformed or non-statement JSON files.
      }
    }
  }

  const fallback = Array.from(byCik.values());
  if (fallback.length > 0) {
    cachedFallbackCompanies = fallback;
  }
  return fallback;
}

async function fetchCompaniesFromSec(timeoutMs: number): Promise<Company[]> {
  const userAgent = process.env.SEC_USER_AGENT?.trim();
  if (!userAgent) {
    throw new CompanyListError(
      "Company search is unavailable because SEC_USER_AGENT is not set on the server.",
      503,
    );
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new CompanyListError(
          "The SEC company list took too long to respond.",
          504,
        ),
      );
    }, timeoutMs);
  });

  const fetchPromise = (async () => {
    let response: Response;
    try {
      response = await fetch(SEC_COMPANY_TICKERS_URL, {
        headers: {
          "User-Agent": userAgent,
          Accept: "application/json",
        },
        signal: controller.signal,
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
  })();

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new CompanyListError(
          "The SEC company list took too long to respond.",
          504,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function loadTestFixtureCompanies(): Promise<Company[]> {
  const fixturePath = path.join(
    process.cwd(),
    "src/fixtures/company-tickers.json",
  );
  const contents = await readFile(fixturePath, "utf-8");
  return parseSecCompanyTickers(JSON.parse(contents));
}

export async function loadCompanyList(options?: {
  timeoutMs?: number;
}): Promise<Company[]> {
  const testMode = process.env.ADDS_UP_TEST === "1";

  if (cachedCompanies && cachedInTestMode === testMode) {
    return cachedCompanies;
  }

  if (testMode) {
    if (inFlightLoad && cachedInTestMode === true) {
      return inFlightLoad;
    }

    cachedInTestMode = true;
    const pending = loadTestFixtureCompanies()
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

  const timeoutMs = options?.timeoutMs ?? SEC_COMPANY_LIST_TIMEOUT_MS;

  if (inFlightLoad && cachedInTestMode === false) {
    try {
      return await raceWithTimeout(inFlightLoad, timeoutMs);
    } catch {
      const fallback = await loadFallbackCompanies();
      if (fallback.length > 0) return fallback;
      throw new CompanyListError(
        "Could not load the SEC company list right now. Please try again.",
        502,
      );
    }
  }

  cachedInTestMode = false;
  const pending = fetchCompaniesFromSec(timeoutMs)
    .then((companies) => {
      cachedCompanies = companies;
      return companies;
    })
    .finally(() => {
      if (inFlightLoad === pending) {
        inFlightLoad = null;
      }
    });

  // Avoid unhandled rejection if a waiting caller times out early.
  pending.catch(() => {});

  inFlightLoad = pending;

  try {
    return await raceWithTimeout(pending, timeoutMs);
  } catch (error) {
    const fallback = await loadFallbackCompanies();
    if (fallback.length > 0) {
      return fallback;
    }
    throw error;
  }
}

export async function findCompanyByCik(rawCik: string): Promise<Company | null> {
  const target = normalizeCik(rawCik);
  const companies = await loadCompanyList();
  return companies.find((company) => company.cik === target) ?? null;
}

export function resetCompanyListCache(): void {
  cachedCompanies = null;
  cachedInTestMode = null;
  cachedFallbackCompanies = null;
  inFlightLoad = null;
}
