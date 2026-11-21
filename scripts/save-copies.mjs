#!/usr/bin/env node
/**
 * Saves the latest balance sheet of the first 100 companies on the SEC list
 * (in the SEC list's own order) as JSON files under data/saved/<cik>.json.
 *
 * Requires Node.js only and SEC_USER_AGENT in the environment.
 * Sends at most 5 requests per second to sec.gov.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SEC_COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const MAX_COMPANIES = 100;
const MIN_REQUEST_INTERVAL_MS = 220; // <= 5 requests per second
const REQUEST_TIMEOUT_MS = 12_000;
const SAVED_DIR = path.join(process.cwd(), "data/saved");

const NAMED_ENTITIES = {
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

let lastRequestAt = 0;

async function rateLimitedFetch(url, userAgent, accept) {
  const now = Date.now();
  const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestAt = Date.now();

  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: accept,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.text();
}

function normalizeCik(value) {
  const digits = String(value).trim().replace(/^0+/, "");
  return digits.length > 0 ? digits : "0";
}

function decodeHtmlEntities(input) {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "");
}

function getAttr(attrs, name) {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = pattern.exec(attrs);
  if (!match) return "";
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function getClassTokens(attrs) {
  return new Set(
    getAttr(attrs, "class")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
}

function cleanLabel(rawHtml) {
  const withoutSup = rawHtml.replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "");
  const decoded = decodeHtmlEntities(stripTags(withoutSup)).replace(/\u00a0/g, " ");
  const withoutFootnotes = decoded.replace(/\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "");
  return withoutFootnotes.replace(/\s+/g, " ").trim();
}

function parseNumberCell(rawHtml) {
  const decoded = decodeHtmlEntities(stripTags(rawHtml));
  const cleaned = decoded.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || /^(?:\$\s*)?[-–—−]+$/.test(cleaned)) {
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
  return { value: cleaned, number: signed };
}

function findTableHtmlByClass(html, targetClass) {
  const tokenRegex = /<(\/)?table\b([^>]*)>/gi;
  let match;
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

function extractCells(rowInnerHtml) {
  const cellRegex = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const cells = [];
  let match;

  while ((match = cellRegex.exec(rowInnerHtml)) !== null) {
    const attrs = match[2] ?? "";
    cells.push({
      tag: match[1].toLowerCase(),
      attrs,
      classes: getClassTokens(attrs),
      innerHtml: match[3] ?? "",
    });
  }

  return cells;
}

function extractTopLevelRows(tableHtml) {
  const openEnd = tableHtml.indexOf(">");
  const closeStart = tableHtml.toLowerCase().lastIndexOf("</table>");
  if (openEnd === -1 || closeStart <= openEnd) return [];
  const inner = tableHtml.slice(openEnd + 1, closeStart);

  const tokenRegex = /<(\/)?(table|tr)\b([^>]*)>/gi;
  const rows = [];
  let match;
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

function splitTitleAndUnitLine(rawCellHtml) {
  const withBreaks = rawCellHtml
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|strong|h[1-6])>/gi, "\n");
  const decoded = decodeHtmlEntities(stripTags(withBreaks)).replace(/\u00a0/g, " ");
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

  return {
    title: lines[0],
    unitLine: lines
      .slice(1)
      .join(" ")
      .replace(/^[-–—]\s*/, "")
      .trim(),
  };
}

function cleanHeaderText(rawCellHtml) {
  return decodeHtmlEntities(stripTags(rawCellHtml.replace(/<br\s*\/?>/gi, " ")))
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferIndent(labelCellAttrs, labelCellHtml, isTotal, seenHeading) {
  const style = getAttr(labelCellAttrs, "style");
  const padMatch = /padding-left\s*:\s*([\d.]+)\s*(px|em|rem)/i.exec(style);
  if (padMatch) {
    const amount = Number.parseFloat(padMatch[1]);
    const unit = padMatch[2].toLowerCase();
    const px = unit === "px" ? amount : amount * 16;
    return px >= 10 ? Math.min(3, Math.max(1, Math.round(px / 16))) : 0;
  }

  const leadingNbsp = /^(?:\s|&nbsp;|&#160;|\u00a0)+/i.exec(stripTags(labelCellHtml));
  if (leadingNbsp) {
    const count = (leadingNbsp[0].match(/&nbsp;|&#160;|\u00a0/gi) ?? []).length;
    if (count >= 2) return Math.min(3, Math.floor(count / 2));
  }

  if (isTotal) return 0;
  return seenHeading ? 1 : 0;
}

function extractXmlTag(block, tagName) {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = regex.exec(block);
  if (!match) return "";
  return decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
}

function parseLatestFiling(submissions) {
  const recent = submissions?.filings?.recent;
  if (!recent) throw new Error("No recent filings found");

  const forms = Array.isArray(recent.form) ? recent.form : [];
  const dates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const accessions = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];

  let best = null;
  const count = Math.min(forms.length, dates.length, accessions.length);
  for (let i = 0; i < count; i += 1) {
    const form = forms[i];
    const filingDate = dates[i];
    const accessionNumber = accessions[i];
    if (
      (form !== "10-K" && form !== "10-Q") ||
      typeof filingDate !== "string" ||
      typeof accessionNumber !== "string"
    ) {
      continue;
    }
    if (!best || filingDate > best.filingDate) {
      best = {
        form,
        filingDate: filingDate.trim(),
        accessionNumber: accessionNumber.trim(),
      };
    }
  }

  if (!best) throw new Error("No 10-K or 10-Q filing found");
  return best;
}

function parseBalanceSheetRef(xml) {
  const reportRegex = /<Report\b[^>]*>([\s\S]*?)<\/Report>/gi;
  let match;
  while ((match = reportRegex.exec(xml)) !== null) {
    const block = match[1];
    if (extractXmlTag(block, "MenuCategory").toLowerCase() !== "statements") continue;
    const shortName = extractXmlTag(block, "ShortName");
    const upper = shortName.toUpperCase();
    if (upper.includes("PARENTHETICAL")) continue;
    if (
      upper.includes("BALANCE SHEET") ||
      upper.includes("FINANCIAL POSITION") ||
      upper.includes("FINANCIAL CONDITION") ||
      upper.includes("STATEMENTS OF CONDITION") ||
      upper.includes("STATEMENT OF CONDITION")
    ) {
      const htmlFileName = extractXmlTag(block, "HtmlFileName");
      if (htmlFileName) return { shortName, htmlFileName };
    }
  }
  throw new Error("No balance sheet report found in FilingSummary.xml");
}

function parseReportHtml(html, meta) {
  const reportTableHtml = findTableHtmlByClass(html, "report");
  if (!reportTableHtml) {
    throw new Error("No report table found in HTML");
  }

  const parsedRows = extractTopLevelRows(reportTableHtml);
  if (parsedRows.length === 0) {
    throw new Error("Empty report table");
  }

  const headerRow = parsedRows[0];
  const { title, unitLine } = headerRow.cells[0]
    ? splitTitleAndUnitLine(headerRow.cells[0].innerHtml)
    : { title: "BALANCE SHEET", unitLine: "" };

  let col0 = headerRow.cells[1] ? cleanHeaderText(headerRow.cells[1].innerHtml) : "";
  let col1 = headerRow.cells[2] ? cleanHeaderText(headerRow.cells[2].innerHtml) : "";
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

  const rows = [];
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
        rows.push({ kind: "heading", label, indent: 0 });
      }
      continue;
    }

    rows.push({
      kind: "number",
      label,
      indent: inferIndent(labelCell.attrs, labelCell.innerHtml, isTotal, seenHeading),
      isTotal,
      values: [left.value, right.value],
      numbers: [left.number, right.number],
    });
  }

  return {
    cik: meta.cik,
    companyName: meta.companyName,
    form: meta.form,
    filingDate: meta.filingDate,
    title,
    columns: [col0, col1],
    unitLine,
    rows,
  };
}

async function main() {
  const userAgent = process.env.SEC_USER_AGENT?.trim();
  if (!userAgent) {
    console.error("Error: SEC_USER_AGENT environment variable is required.");
    process.exit(1);
  }

  await mkdir(SAVED_DIR, { recursive: true });

  console.log("Fetching SEC company list...");
  const tickersText = await rateLimitedFetch(
    SEC_COMPANY_TICKERS_URL,
    userAgent,
    "application/json",
  );
  const rawTickers = JSON.parse(tickersText);

  const companies = [];
  const seenCiks = new Set();
  for (const entry of Object.values(rawTickers)) {
    if (!entry || typeof entry !== "object") continue;
    const cik = normalizeCik(entry.cik_str);
    if (seenCiks.has(cik)) continue;
    seenCiks.add(cik);
    companies.push({
      cik,
      ticker: String(entry.ticker ?? "").trim(),
      name: String(entry.title ?? "").trim(),
    });
    if (companies.length === MAX_COMPANIES) break;
  }

  let savedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < companies.length; i += 1) {
    const company = companies[i];
    const prefix = `[${i + 1}/${companies.length}] ${company.ticker} (CIK ${company.cik})`;

    try {
      const paddedCik = company.cik.padStart(10, "0");
      const submissionsText = await rateLimitedFetch(
        `https://data.sec.gov/submissions/CIK${paddedCik}.json`,
        userAgent,
        "application/json",
      );
      const latest = parseLatestFiling(JSON.parse(submissionsText));
      const accessionNoDashes = latest.accessionNumber.replace(/-/g, "");
      const baseUrl = `https://www.sec.gov/Archives/edgar/data/${company.cik}/${accessionNoDashes}`;

      const summaryXml = await rateLimitedFetch(
        `${baseUrl}/FilingSummary.xml`,
        userAgent,
        "application/xml, text/xml",
      );
      const reportRef = parseBalanceSheetRef(summaryXml);

      const reportHtml = await rateLimitedFetch(
        `${baseUrl}/${reportRef.htmlFileName}`,
        userAgent,
        "text/html",
      );
      const statement = parseReportHtml(reportHtml, {
        cik: company.cik,
        companyName: company.name,
        form: latest.form,
        filingDate: latest.filingDate,
      });

      const outPath = path.join(SAVED_DIR, `${company.cik}.json`);
      await writeFile(outPath, `${JSON.stringify(statement, null, 2)}\n`, "utf-8");
      savedCount += 1;
      console.log(`${prefix} -> saved (${statement.form}, ${statement.filingDate})`);
    } catch (error) {
      failedCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`${prefix} -> skipped: ${message}`);
    }
  }

  console.log(`Done. Saved ${savedCount} statements, skipped ${failedCount}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
