import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeCik } from "@/lib/companies";

export type StatementHeadingRow = {
  kind: "heading";
  label: string;
  indent: number;
};

export type StatementNumberRow = {
  kind: "number";
  label: string;
  indent: number;
  isTotal: boolean;
  values: [string | null, string | null];
  numbers: [number | null, number | null];
};

export type StatementRow = StatementHeadingRow | StatementNumberRow;

export type Statement = {
  cik: string;
  companyName: string;
  form: "10-K" | "10-Q";
  filingDate: string;
  title: string;
  columns: [string, string];
  unitLine: string;
  rows: StatementRow[];
};

export type StatementSource = "sec" | "saved" | "fixture";

export type StatementLoadResult = {
  statement: Statement;
  source: StatementSource;
  fallbackReason?: string;
};

export class StatementError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "StatementError";
    this.status = status;
  }
}

export type LatestFiling = {
  form: "10-K" | "10-Q";
  filingDate: string;
  accessionNumber: string;
  companyName?: string;
};

export type BalanceSheetReportRef = {
  shortName: string;
  htmlFileName: string;
};

export type LoadStatementOptions = {
  companyName?: string;
  savedDir?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  rateLimitMs?: number;
};

const SEC_TIMEOUT_MS = 8_000;
const SEC_MIN_INTERVAL_MS = 220; // <= 5 requests/second
const DEFAULT_SAVED_DIR = path.join(process.cwd(), "data/saved");
const APPLE_FIXTURE_PATH = path.join(process.cwd(), "src/fixtures/apple-statement.json");

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: "\u00a0",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "\u2014",
  ndash: "\u2013",
  minus: "\u2212",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
};

let lastSecRequestAt = 0;

async function waitForSecRateLimit(intervalMs: number): Promise<void> {
  if (intervalMs <= 0) return;
  const now = Date.now();
  const waitMs = lastSecRequestAt + intervalMs - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastSecRequestAt = Date.now();
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function getAttr(attrs: string, name: string): string {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = pattern.exec(attrs);
  if (!match) return "";
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function getClassTokens(attrs: string): Set<string> {
  const value = getAttr(attrs, "class");
  const tokens = value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return new Set(tokens);
}

export function cleanLabel(rawHtml: string): string {
  const withoutSup = rawHtml.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "");
  const decoded = decodeHtmlEntities(stripTags(withoutSup)).replace(
    /\u00a0/g,
    " ",
  );
  // Remove bracketed footnote markers such as [1] or [1, 2].
  const withoutFootnotes = decoded.replace(
    /\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g,
    "",
  );
  return withoutFootnotes.replace(/\s+/g, " ").trim();
}

export function parseNumberCell(rawHtml: string): {
  value: string | null;
  number: number | null;
} {
  const decoded = decodeHtmlEntities(stripTags(rawHtml));
  const cleaned = decoded.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return { value: null, number: null };
  }

  // A dash (or dollar sign + dash) means no value.
  if (/^(?:\$\s*)?[-–—−]+$/.test(cleaned)) {
    return { value: null, number: null };
  }

  let negative = false;
  let working = cleaned;

  const parenMatch = /^\$?\s*\(\s*\$?\s*(.+?)\s*\)$/.exec(working);
  if (parenMatch) {
    negative = true;
    working = parenMatch[1];
  } else {
    working = working.replace(/^\$\s*/, "");
    if (/^[-−]/.test(working)) {
      negative = true;
      working = working.slice(1).trim();
    } else if (working.startsWith("+")) {
      working = working.slice(1).trim();
    }
  }

  working = working.replace(/^\$\s*/, "").replace(/,/g, "").replace(/\s+/g, "");

  if (!/^\d+(?:\.\d+)?$/.test(working)) {
    return { value: null, number: null };
  }

  const parsed = Number(working);
  if (!Number.isFinite(parsed)) {
    return { value: null, number: null };
  }

  const signed = negative && parsed !== 0 ? -parsed : parsed;
  return {
    value: cleaned,
    number: signed,
  };
}

function findTableHtmlByClass(html: string, targetClass: string): string | null {
  const tokenRegex = /<(\/)?table\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  let capturing = false;
  let depth = 0;
  let startIndex = -1;

  while ((match = tokenRegex.exec(html)) !== null) {
    const isClose = Boolean(match[1]);
    const attrs = match[2] ?? "";

    if (!capturing) {
      if (!isClose && getClassTokens(attrs).has(targetClass.toLowerCase())) {
        capturing = true;
        depth = 1;
        startIndex = match.index;
      }
      continue;
    }

    if (isClose) {
      depth -= 1;
      if (depth === 0) {
        return html.slice(startIndex, match.index + match[0].length);
      }
    } else {
      depth += 1;
    }
  }

  return null;
}

type ParsedRow = {
  attrs: string;
  classes: Set<string>;
  cells: Array<{
    tag: "th" | "td";
    attrs: string;
    classes: Set<string>;
    innerHtml: string;
  }>;
};

function extractTopLevelRows(tableHtml: string): ParsedRow[] {
  // Strip outer <table>...</table> wrapper so nested table depth starts at 0.
  const openEnd = tableHtml.indexOf(">");
  const closeStart = tableHtml.toLowerCase().lastIndexOf("</table>");
  if (openEnd === -1 || closeStart <= openEnd) return [];
  const inner = tableHtml.slice(openEnd + 1, closeStart);

  const tokenRegex = /<(\/)?(table|tr)\b([^>]*)>/gi;
  const rows: ParsedRow[] = [];
  let match: RegExpExecArray | null;
  let nestedTableDepth = 0;
  let currentRowStart = -1;
  let currentRowAttrs = "";

  while ((match = tokenRegex.exec(inner)) !== null) {
    const isClose = Boolean(match[1]);
    const tag = match[2].toLowerCase();
    const attrs = match[3] ?? "";

    if (tag === "table") {
      nestedTableDepth += isClose ? -1 : 1;
      continue;
    }

    if (nestedTableDepth > 0) continue;

    if (!isClose) {
      currentRowStart = match.index + match[0].length;
      currentRowAttrs = attrs;
    } else if (currentRowStart !== -1) {
      const rowInner = inner.slice(currentRowStart, match.index);
      rows.push({
        attrs: currentRowAttrs,
        classes: getClassTokens(currentRowAttrs),
        cells: extractCells(rowInner),
      });
      currentRowStart = -1;
      currentRowAttrs = "";
    }
  }

  return rows;
}

function extractCells(rowInnerHtml: string): ParsedRow["cells"] {
  const cellRegex = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const cells: ParsedRow["cells"] = [];
  let match: RegExpExecArray | null;

  while ((match = cellRegex.exec(rowInnerHtml)) !== null) {
    const tag = match[1].toLowerCase() as "th" | "td";
    const attrs = match[2] ?? "";
    cells.push({
      tag,
      attrs,
      classes: getClassTokens(attrs),
      innerHtml: match[3] ?? "",
    });
  }

  return cells;
}

function splitTitleAndUnitLine(rawCellHtml: string): {
  title: string;
  unitLine: string;
} {
  const withBreaks = rawCellHtml
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|strong|h[1-6])>/gi, "\n");
  const decoded = decodeHtmlEntities(stripTags(withBreaks)).replace(
    /\u00a0/g,
    " ",
  );
  const lines = decoded
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { title: "BALANCE SHEET", unitLine: "" };
  }

  if (lines.length === 1) {
    const separator = /\s+[-–—]\s+/.exec(lines[0]);
    if (separator && separator.index > 0) {
      return {
        title: lines[0].slice(0, separator.index).trim(),
        unitLine: lines[0].slice(separator.index + separator[0].length).trim(),
      };
    }
    return { title: lines[0], unitLine: "" };
  }

  const first = lines[0];
  const rest = lines
    .slice(1)
    .join(" ")
    .replace(/^[-–—]\s*/, "")
    .trim();
  return { title: first, unitLine: rest };
}

function cleanHeaderText(rawCellHtml: string): string {
  const withSpaces = rawCellHtml.replace(/<br\s*\/?>/gi, " ");
  return decodeHtmlEntities(stripTags(withSpaces))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferIndent(
  labelCellAttrs: string,
  labelCellHtml: string,
  isTotal: boolean,
  seenHeading: boolean,
): number {
  const style = getAttr(labelCellAttrs, "style");
  const padMatch = /padding-left\s*:\s*([\d.]+)\s*(px|em|rem)/i.exec(style);
  if (padMatch) {
    const amount = Number.parseFloat(padMatch[1]);
    const unit = padMatch[2].toLowerCase();
    const px = unit === "px" ? amount : amount * 16;
    if (px >= 10) {
      return Math.min(3, Math.max(1, Math.round(px / 16)));
    }
    return 0;
  }

  const leadingNbsp = /^(?:\s|&nbsp;|&#160;|\u00a0)+/i.exec(
    stripTags(labelCellHtml),
  );
  if (leadingNbsp) {
    const count = (leadingNbsp[0].match(/&nbsp;|&#160;|\u00a0/gi) ?? []).length;
    if (count >= 2) {
      return Math.min(3, Math.floor(count / 2));
    }
  }

  if (isTotal) return 0;
  return seenHeading ? 1 : 0;
}

export function parseSecSubmissions(raw: unknown): LatestFiling {
  if (!raw || typeof raw !== "object") {
    throw new StatementError(
      "The SEC submissions file had an unexpected format.",
      502,
    );
  }

  const record = raw as Record<string, unknown>;
  const companyName =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : undefined;

  const filings = record.filings as Record<string, unknown> | undefined;
  const recent = filings?.recent as Record<string, unknown> | undefined;
  if (!recent || typeof recent !== "object") {
    throw new StatementError("No recent SEC filings were found for this company.", 404);
  }

  const forms = Array.isArray(recent.form) ? recent.form : [];
  const dates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const accessions = Array.isArray(recent.accessionNumber)
    ? recent.accessionNumber
    : [];

  let best: LatestFiling | null = null;
  const count = Math.min(forms.length, dates.length, accessions.length);
  for (let i = 0; i < count; i += 1) {
    const form = forms[i];
    const filingDate = dates[i];
    const accessionNumber = accessions[i];
    if (
      (form !== "10-K" && form !== "10-Q") ||
      typeof filingDate !== "string" ||
      typeof accessionNumber !== "string" ||
      !filingDate.trim() ||
      !accessionNumber.trim()
    ) {
      continue;
    }

    if (!best || filingDate > best.filingDate) {
      best = {
        form,
        filingDate: filingDate.trim(),
        accessionNumber: accessionNumber.trim(),
        companyName,
      };
    }
  }

  if (!best) {
    throw new StatementError(
      "No 10-K or 10-Q filing was found for this company.",
      404,
    );
  }

  return best;
}

function extractXmlTag(block: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = regex.exec(block);
  if (!match) return "";
  return decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
}

export function parseFilingSummaryXml(xml: string): BalanceSheetReportRef {
  const reportRegex = /<Report\b[^>]*>([\s\S]*?)<\/Report>/gi;
  let match: RegExpExecArray | null;

  while ((match = reportRegex.exec(xml)) !== null) {
    const block = match[1];
    const menuCategory = extractXmlTag(block, "MenuCategory");
    if (menuCategory.toLowerCase() !== "statements") continue;

    const shortName = extractXmlTag(block, "ShortName");
    const upper = shortName.toUpperCase();
    if (upper.includes("PARENTHETICAL")) continue;

    const isBalanceSheet =
      upper.includes("BALANCE SHEET") ||
      upper.includes("FINANCIAL POSITION") ||
      upper.includes("FINANCIAL CONDITION") ||
      // Banks often name the balance sheet "Statements of Condition".
      upper.includes("STATEMENTS OF CONDITION") ||
      upper.includes("STATEMENT OF CONDITION");
    if (!isBalanceSheet) continue;

    const htmlFileName = extractXmlTag(block, "HtmlFileName");
    if (!htmlFileName) continue;

    return { shortName, htmlFileName };
  }

  throw new StatementError(
    "Could not find a balance sheet in this filing's summary.",
    404,
  );
}

export function parseSecReportHtml(
  html: string,
  meta: {
    cik: string;
    companyName: string;
    form: "10-K" | "10-Q";
    filingDate: string;
  },
): Statement {
  const reportTableHtml = findTableHtmlByClass(html, "report");
  if (!reportTableHtml) {
    throw new StatementError(
      "The SEC filing page did not contain a balance sheet report table.",
      502,
    );
  }

  const parsedRows = extractTopLevelRows(reportTableHtml);
  if (parsedRows.length === 0) {
    throw new StatementError(
      "The SEC balance sheet report table was empty.",
      502,
    );
  }

  const headerRow = parsedRows[0];
  const titleCell = headerRow.cells[0];
  const { title, unitLine } = titleCell
    ? splitTitleAndUnitLine(titleCell.innerHtml)
    : { title: "BALANCE SHEET", unitLine: "" };

  let col0 = headerRow.cells[1] ? cleanHeaderText(headerRow.cells[1].innerHtml) : "";
  let col1 = headerRow.cells[2] ? cleanHeaderText(headerRow.cells[2].innerHtml) : "";

  // Handle two-row table headers where date columns sit on row 2.
  let bodyStartIndex = 1;
  if ((!col0 || !col1) && parsedRows.length > 1) {
    const secondRow = parsedRows[1];
    const isDataRow =
      secondRow.classes.has("re") ||
      secondRow.classes.has("ro") ||
      secondRow.classes.has("reu") ||
      secondRow.classes.has("rou");
    if (!isDataRow && secondRow.cells.length >= 2) {
      col0 = cleanHeaderText(secondRow.cells[0].innerHtml);
      col1 = cleanHeaderText(secondRow.cells[1].innerHtml);
      bodyStartIndex = 2;
    }
  }

  const rows: StatementRow[] = [];
  let seenHeading = false;

  for (let i = bodyStartIndex; i < parsedRows.length; i += 1) {
    const tr = parsedRows[i];
    const isPlain = tr.classes.has("re") || tr.classes.has("ro");
    const isTotal = tr.classes.has("reu") || tr.classes.has("rou");
    if (!isPlain && !isTotal) continue;

    const labelCellIndex = tr.cells.findIndex((cell) => cell.classes.has("pl"));
    if (labelCellIndex === -1) continue;

    const labelCell = tr.cells[labelCellIndex];
    const label = cleanLabel(labelCell.innerHtml);
    if (!label) continue;

    const numCells = tr.cells.filter(
      (cell) => cell.classes.has("nump") || cell.classes.has("num"),
    );
    const valueCells =
      numCells.length >= 2 ? numCells : tr.cells.slice(labelCellIndex + 1);

    const left = valueCells[0]
      ? parseNumberCell(valueCells[0].innerHtml)
      : { value: null, number: null };
    const right = valueCells[1]
      ? parseNumberCell(valueCells[1].innerHtml)
      : { value: null, number: null };

    if (left.number === null && right.number === null) {
      if (!isTotal) {
        seenHeading = true;
        rows.push({
          kind: "heading",
          label,
          indent: 0,
        });
      }
      continue;
    }

    rows.push({
      kind: "number",
      label,
      indent: inferIndent(
        labelCell.attrs,
        labelCell.innerHtml,
        isTotal,
        seenHeading,
      ),
      isTotal,
      values: [left.value, right.value],
      numbers: [left.number, right.number],
    });
  }

  return {
    cik: normalizeCik(meta.cik),
    companyName: meta.companyName,
    form: meta.form,
    filingDate: meta.filingDate,
    title,
    columns: [col0, col1],
    unitLine,
    rows,
  };
}

export function formatFilingDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return isoDate;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function isValidStatement(value: unknown): value is Statement {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.cik === "string" &&
    typeof record.companyName === "string" &&
    (record.form === "10-K" || record.form === "10-Q") &&
    typeof record.filingDate === "string" &&
    typeof record.title === "string" &&
    Array.isArray(record.columns) &&
    record.columns.length === 2 &&
    typeof record.unitLine === "string" &&
    Array.isArray(record.rows)
  );
}

export async function loadSavedStatement(
  rawCik: string,
  savedDir = DEFAULT_SAVED_DIR,
): Promise<Statement | null> {
  const cik = normalizeCik(rawCik);
  const filePath = path.join(savedDir, `${cik}.json`);
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isValidStatement(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchSecText(
  url: string,
  userAgent: string,
  accept: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  rateLimitMs: number,
): Promise<string> {
  await waitForSecRateLimit(rateLimitMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "User-Agent": userAgent,
        Accept: accept,
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new StatementError(
        "The SEC took too long to answer (over 8 seconds).",
        504,
      );
    }
    throw new StatementError(
      error instanceof Error
        ? `Could not reach the SEC: ${error.message}`
        : "Could not reach the SEC right now.",
      502,
    );
  }

  if (!response.ok) {
    throw new StatementError(
      `The SEC returned status ${response.status} for this filing.`,
      502,
    );
  }

  return response.text();
}

export async function fetchSecStatement(
  rawCik: string,
  companyName: string,
  options?: {
    userAgent?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    rateLimitMs?: number;
  },
): Promise<Statement> {
  const cik = normalizeCik(rawCik);
  const paddedCik = cik.padStart(10, "0");
  const userAgent = options?.userAgent ?? process.env.SEC_USER_AGENT?.trim();
  if (!userAgent) {
    throw new StatementError(
      "Cannot fetch from the SEC because SEC_USER_AGENT is not set on the server.",
      503,
    );
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? SEC_TIMEOUT_MS;
  const rateLimitMs = options?.rateLimitMs ?? SEC_MIN_INTERVAL_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error("SEC request timed out"));
  }, timeoutMs);

  try {
    // Step 2: submissions JSON
    const submissionsUrl = `https://data.sec.gov/submissions/CIK${paddedCik}.json`;
    const submissionsText = await fetchSecText(
      submissionsUrl,
      userAgent,
      "application/json",
      controller.signal,
      fetchImpl,
      rateLimitMs,
    );
    let submissionsJson: unknown;
    try {
      submissionsJson = JSON.parse(submissionsText);
    } catch {
      throw new StatementError("Could not read the SEC submissions JSON.", 502);
    }

    const latest = parseSecSubmissions(submissionsJson);
    const accessionNoDashes = latest.accessionNumber.replace(/-/g, "");
    const filingBaseUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionNoDashes}`;

    // Step 3: FilingSummary.xml
    const summaryXml = await fetchSecText(
      `${filingBaseUrl}/FilingSummary.xml`,
      userAgent,
      "application/xml, text/xml",
      controller.signal,
      fetchImpl,
      rateLimitMs,
    );
    const reportRef = parseFilingSummaryXml(summaryXml);

    // Step 4: balance sheet report HTML
    const reportHtml = await fetchSecText(
      `${filingBaseUrl}/${reportRef.htmlFileName}`,
      userAgent,
      "text/html",
      controller.signal,
      fetchImpl,
      rateLimitMs,
    );

    return parseSecReportHtml(reportHtml, {
      cik,
      companyName: companyName || latest.companyName || `CIK ${cik}`,
      form: latest.form,
      filingDate: latest.filingDate,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function loadStatement(
  rawCik: string,
  options?: LoadStatementOptions,
): Promise<StatementLoadResult> {
  const cik = normalizeCik(rawCik);
  const savedDir = options?.savedDir ?? DEFAULT_SAVED_DIR;
  const testMode = process.env.ADDS_UP_TEST === "1";

  if (testMode) {
    if (cik === "320193") {
      const raw = await readFile(APPLE_FIXTURE_PATH, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (isValidStatement(parsed)) {
        return { statement: parsed, source: "fixture" };
      }
    }

    const saved = await loadSavedStatement(cik, savedDir);
    if (saved) {
      return { statement: saved, source: "saved" };
    }

    throw new StatementError(
      "No fixture balance sheet is available for this company in test mode.",
      404,
    );
  }

  const userAgent = process.env.SEC_USER_AGENT?.trim();
  if (!userAgent) {
    const saved = await loadSavedStatement(cik, savedDir);
    if (saved) {
      return {
        statement: saved,
        source: "saved",
        fallbackReason: "SEC_USER_AGENT is not set on the server.",
      };
    }

    throw new StatementError(
      "Could not load the balance sheet because SEC_USER_AGENT is not set on the server and no saved copy exists.",
      503,
    );
  }

  try {
    const statement = await fetchSecStatement(
      cik,
      options?.companyName ?? "",
      {
        userAgent,
        fetchImpl: options?.fetchImpl,
        timeoutMs: options?.timeoutMs,
        rateLimitMs: options?.rateLimitMs,
      },
    );
    return { statement, source: "sec" };
  } catch (error) {
    const saved = await loadSavedStatement(cik, savedDir);
    if (saved) {
      return {
        statement: saved,
        source: "saved",
        fallbackReason:
          error instanceof Error
            ? error.message
            : "The SEC request failed.",
      };
    }

    if (error instanceof StatementError) {
      throw error;
    }

    throw new StatementError(
      "Could not load this company's balance sheet from the SEC right now.",
      502,
    );
  }
}
