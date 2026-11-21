#!/usr/bin/env node
/**
 * The 50-filing test of Adds Up. The rules were fixed before the event in docs/eval-spec.md.
 * It picks filings by a hash rule, runs the product's own reading through the running app,
 * runs one plain model call as the baseline, and writes data/scores.json for the results page.
 *
 * Run it from the repository root, with the app running and both settings in the environment:
 *   EVAL_APP=http://localhost:3220 node scripts/run-eval.mjs --limit 5
 *   EVAL_APP=http://localhost:3220 node scripts/run-eval.mjs --limit 50
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { GoogleGenAI } from "@google/genai";
import { proveColumns, rebuildHiddenCell } from "../src/lib/adding.ts";

const APP = process.env.EVAL_APP ?? "http://localhost:3220";
const SEC_UA = process.env.SEC_USER_AGENT?.trim();
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const LIMIT = Number(arg("--limit") ?? 50);
const OUT = arg("--out") ?? "data/scores.json";
const STEPS = new Set((arg("--steps") ?? "A,B,C,D").split(","));
// Every step of every filing is also written to a log beside the scores file, one line each.
const LOG = OUT.replace(/\.json$/, "") + ".log.jsonl";
const usage = { calls: 0, input: 0, output: 0 };
const note = (line) => appendFile(LOG, JSON.stringify(line) + "\n");

const SALT = "adds-up-2026-11-21:";
const OLDEST_FILING = "2025-11-21";
// Apple is the page's example. The other ten were in Friday's one-hour test.
const EXCLUDED_TICKERS = new Set(["AAPL", "PMTR", "PSX", "DXC", "BOH", "QSR", "HGAS", "PNW", "ENSC", "KNTK", "KSCP"]);
const HYDROGEN = "gemini-4-hydrogen";
// The same reading question as src/lib/gemini.ts sends for each picture.
const READING_PROMPT = [
  "Read every printed row in this balance sheet picture that has a number, a dash, or a black covered box.",
  "Output one line per row in the exact printed order, using this format:",
  "label | left value | right value",
  "",
  "Rules:",
  "- Write each number exactly as printed, including dollar signs, commas, and brackets or parentheses.",
  "- Leave a cell empty where the page shows nothing.",
  "- If a cell is covered by a black box, write HIDDEN for that cell.",
  "- Do not include section headings that have no numbers or dashes.",
  "- Output only the row lines, with no extra text.",
].join("\n");

if (!SEC_UA) throw new Error("SEC_USER_AGENT is not set.");
if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
const ai = new GoogleGenAI({ apiVersion: "v1beta" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function countUsage(r) {
  const u = r.usage ?? {};
  usage.calls += 1;
  usage.input += u.total_input_tokens ?? u.input_tokens ?? 0;
  usage.output += (u.total_output_tokens ?? u.output_tokens ?? 0) + (u.total_thought_tokens ?? u.thinking_tokens ?? 0);
}
const sha = (text) => createHash("sha256").update(text).digest("hex");

let lastSec = 0;
async function sec(url) {
  const wait = lastSec + 230 - Date.now(); // at most 5 requests a second
  if (wait > 0) await sleep(wait);
  lastSec = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA, Accept: "*/*" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
  return res.text();
}

const decode = (s) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();

/** A printed value as a number. A dash or an empty cell is null. Brackets are negative. */
function toNumber(raw) {
  const t = (raw ?? "").replace(/[$,\s]/g, "");
  if (!t || /^[-–—]+$/.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const n = Number(t.replace(/[()\-]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

/** The eligibility rules of docs/eval-spec.md, checked against the SEC's own pages. */
async function checkEligible(company) {
  const no = (reason) => ({ reason });
  if (company.tickers.some((t) => EXCLUDED_TICKERS.has(t))) return no("It is the page's example or one of Friday's ten test companies.");
  let sub;
  try {
    sub = JSON.parse(await sec(`https://data.sec.gov/submissions/CIK${company.cik.padStart(10, "0")}.json`));
  } catch {
    return no("The SEC gave no filing list.");
  }
  const r = sub.filings?.recent ?? {};
  const i = (r.form ?? []).findIndex((f) => f === "10-K" || f === "10-Q");
  if (i < 0) return no("It has no 10-K or 10-Q.");
  if (r.filingDate[i] < OLDEST_FILING) return no(`Its newest 10-K or 10-Q is older than ${OLDEST_FILING}.`);
  const folder = `https://www.sec.gov/Archives/edgar/data/${company.cik}/${r.accessionNumber[i].replaceAll("-", "")}`;
  let report = null;
  try {
    const summary = await sec(`${folder}/FilingSummary.xml`);
    for (const m of summary.matchAll(/<Report\b[^>]*>([\s\S]*?)<\/Report>/gi)) {
      const tag = (t) => decode((new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i").exec(m[1]) ?? [])[1] ?? "");
      const name = tag("ShortName").toUpperCase();
      if (tag("MenuCategory").toLowerCase() !== "statements" || name.includes("PARENTHETICAL")) continue;
      if (/BALANCE SHEET|FINANCIAL POSITION|FINANCIAL CONDITION|STATEMENTS? OF CONDITION/.test(name)) {
        report = tag("HtmlFileName");
        break;
      }
    }
  } catch {
    return no("The filing has no report list.");
  }
  if (!report) return no("The filing has no balance sheet report.");
  let table;
  try {
    table = /<table[^>]*class="report"[^>]*>([\s\S]*?)<\/table>/i.exec(await sec(`${folder}/${report}`))?.[1];
  } catch {
    return no("The balance sheet page did not load.");
  }
  if (!table) return no("The balance sheet page has no table.");
  let numberRows = 0;
  const widths = new Map();
  for (const row of table.matchAll(/<tr[^>]*class="(?:re|ro|reu|rou)"[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi)];
    const values = cells.filter((c) => !/\bpl\b/.test(c[1]));
    if (values.some((c) => /\bnump?\b/.test(c[1]))) {
      numberRows += 1;
      widths.set(values.length, (widths.get(values.length) ?? 0) + 1);
    }
  }
  const columns = [...widths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  if (columns !== 2) return no(`The table has ${columns} number columns, not two.`);
  if (numberRows < 15 || numberRows > 80) return no(`The table has ${numberRows} number rows, outside 15 to 80.`);
  return { reason: null, accession: r.accessionNumber[i], form: r.form[i], filed: r.filingDate[i] };
}

/** Step A: the product's own reading, through the running app. */
async function stepA(cik) {
  const t0 = Date.now();
  const res = await fetch(`${APP}/api/company/${cik}/read`, {
    method: "POST",
    headers: { Cookie: `adds_up_browser=eval-${randomUUID()}` },
    signal: AbortSignal.timeout(120_000),
  });
  const events = (await res.text()).split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  const done = events.find((e) => e.type === "done");
  if (!done) throw new Error(`The app gave no reading: ${JSON.stringify(events.at(-1) ?? res.status).slice(0, 200)}`);
  const rows = done.result.comparison.rows;
  const column = (c) => rows.map((row) => (row.cells[c].read ?? null));
  const unreadMask = rows.map((row) => [0, 1].map((c) => row.cells[c].expected !== null && row.cells[c].read === null));
  const proof = proveColumns(column(0), column(1), { unreadMask });
  const cells = [];
  rows.forEach((row, i) =>
    [0, 1].forEach((c) => {
      const cell = row.cells[c];
      if (cell.expected === null) return;
      const status = (c === 0 ? proof.left : proof.right).cellStatuses[i];
      cells.push({ row: i, column: c, label: row.label, truth: cell.expected, read: cell.read ?? null, right: Boolean(cell.matches), status });
    }),
  );
  return {
    rows,
    readRows: done.result.rows,
    cells,
    proof,
    flagged: proof.left.mismatches.length + proof.right.mismatches.length > 0,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    modelCalls: done.result.modelCalls,
  };
}

const labelKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Step B: one plain Hydrogen call on the whole picture, with the same reading question. */
async function stepB(cik, truthRows) {
  const png = Buffer.from(await (await fetch(`${APP}/api/company/${cik}/picture`, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  const r = await ai.interactions.create({
    model: HYDROGEN,
    input: [
      { type: "image", data: png.toString("base64"), mime_type: "image/png", resolution: "high" },
      { type: "text", text: READING_PROMPT },
    ],
    generation_config: { thinking_level: "low" },
  });
  countUsage(r);
  const lines = (r.output_text ?? "").split("\n").map((l) => l.split("|").map((p) => p.trim())).filter((p) => p.length >= 3);
  const replies = lines.map((p) => ({ key: labelKey(p.slice(0, -2).join("|")), values: [toNumber(p.at(-2)), toNumber(p.at(-1))] }));
  let pointer = 0;
  const cells = [];
  for (const row of truthRows) {
    let found = -1;
    for (let j = pointer; j < Math.min(replies.length, pointer + 4); j++) {
      if (replies[j].key === labelKey(row.label)) {
        found = j;
        break;
      }
    }
    if (found >= 0) pointer = found + 1;
    [0, 1].forEach((c) => {
      if (row.cells[c].expected === null) return;
      const read = found >= 0 ? replies[found].values[c] : null;
      cells.push({ label: row.label, column: c, truth: row.cells[c].expected, read, right: read !== null && Math.abs(read - row.cells[c].expected) < 1e-6 });
    });
  }
  return { cells };
}

/** Posts a hide or a change to the app and returns the new reading. */
async function modify(cik, body) {
  const res = await fetch(`${APP}/api/company/${cik}/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `adds_up_browser=eval-${randomUUID()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const events = text.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  const done = events.find((e) => e.type === "done");
  if (!done) throw new Error(`The app gave no new reading: ${text.slice(0, 200)}`);
  return done.result.comparison.rows;
}

async function askHydrogenAboutPicture(url, question) {
  const png = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
  const r = await ai.interactions.create({
    model: HYDROGEN,
    input: [
      { type: "image", data: png.toString("base64"), mime_type: "image/png", resolution: "high" },
      { type: "text", text: question },
    ],
    generation_config: { thinking_level: "low" },
  });
  countUsage(r);
  return (r.output_text ?? "").trim();
}

/**
 * The cells of one filing in the fixed order of docs/eval-spec.md: by the SHA-256 hash of
 * "filing number:row:column", with rows and columns counted from 1. Only cells inside a
 * group that exists in both columns of the SEC's own values can be hidden or changed.
 */
function orderedCells(accession, rows) {
  const truth = (c) => rows.map((row) => row.cells[c].expected);
  const proof = proveColumns(truth(0), truth(1));
  const key = (g) => `${g.memberIndices.join(",")}>${g.totalIndex}`;
  const rightKeys = new Set(proof.right.groups.map(key));
  const shared = proof.left.groups.filter((g) => rightKeys.has(key(g)));
  const inShared = (r) => shared.some((g) => g.totalIndex === r || g.memberIndices.includes(r));
  const cells = [];
  rows.forEach((row, r) =>
    [0, 1].forEach((c) => {
      if (row.cells[c].expected === null) return;
      cells.push({ row: r, column: c, label: row.label, truth: row.cells[c].expected, hash: sha(`${accession}:${r + 1}:${c + 1}`), usable: inShared(r), shared });
    }),
  );
  return cells.sort((x, y) => (x.hash < y.hash ? -1 : 1));
}

const readColumns = (rows) => [0, 1].map((c) => rows.map((row) => row.cells[c].read ?? null));
const sameNumber = (x, y) => x !== null && y !== null && Number.isFinite(x) && Math.abs(x - y) < 1e-6;

/** Step C: hide one number. The product must rebuild it, and one plain call must name it. */
async function stepC(company, a, cell) {
  const rows = await modify(company.cik, { action: "hide", numberRowIndex: cell.row, colIndex: cell.column, previousRows: a.readRows });
  const [left, right] = readColumns(rows);
  (cell.column === 0 ? left : right)[cell.row] = null;
  const rebuilt = rebuildHiddenCell(left, right, { rowIndex: cell.row, colIndex: cell.column });
  const addsUp = rebuilt.status === "rebuilt" && sameNumber(rebuilt.value, cell.truth);
  const reply = await askHydrogenAboutPicture(
    `${APP}/api/company/${company.cik}/picture?hideRow=${cell.row}&hideCol=${cell.column}`,
    "What number is under the box? Reply with the number only.",
  );
  return {
    label: `${cell.label}, column ${cell.column + 1}`,
    truth: `${cell.truth}`,
    addsUp,
    shown: rebuilt.status === "rebuilt" ? `rebuilt ${rebuilt.value}` : `not rebuilt: ${rebuilt.reason ?? rebuilt.status}`,
    oneCall: sameNumber(toNumber(reply), cell.truth),
    oneCallReply: reply.slice(0, 60),
  };
}

/** The changed value of docs/eval-spec.md: 1 added to the second digit from the left. */
function changedValue(n) {
  // Work on the printed digits, so a value with a decimal point keeps it.
  const text = String(Math.abs(n));
  const places = [...text].map((ch, i) => (/\d/.test(ch) ? i : -1)).filter((i) => i >= 0);
  const at = places.length > 1 ? places[1] : places[0];
  const digits = [...text];
  digits[at] = String((Number(digits[at]) + 1) % 10);
  return Number(digits.join("")) * (n < 0 ? -1 : 1);
}

/** Step D: change one number. The product must mark its group, and one plain call must name the row. */
async function stepD(company, a, cell) {
  const value = changedValue(cell.truth);
  const printed = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
  const newValue = value < 0 ? `(${printed})` : printed;
  const rows = await modify(company.cik, { action: "change", numberRowIndex: cell.row, colIndex: cell.column, newValue, previousRows: a.readRows });
  const [left, right] = readColumns(rows);
  const unreadMask = rows.map((row) => [0, 1].map((c) => row.cells[c].expected !== null && row.cells[c].read === null));
  const proof = proveColumns(left, right, { unreadMask });
  const mismatches = (cell.column === 0 ? proof.left : proof.right).mismatches;
  const addsUp = mismatches.some((g) => g.totalIndex === cell.row || g.memberIndices.includes(cell.row));
  const reply = await askHydrogenAboutPicture(
    `${APP}/api/company/${company.cik}/picture?changeRow=${cell.row}&changeCol=${cell.column}&changeValue=${encodeURIComponent(newValue)}`,
    "Does any total on this page fail to add up? Reply with one row label copied from the page, or NONE.",
  );
  const totals = cell.shared.filter((g) => g.memberIndices.includes(cell.row)).map((g) => a.rows[g.totalIndex].label);
  const accepted = new Set([cell.label, ...totals].map((l) => l.trim().toLowerCase()));
  return {
    label: `${cell.label}, column ${cell.column + 1}`,
    truth: `changed from ${cell.truth} to ${value}`,
    addsUp,
    shown: addsUp ? "group marked" : `no group marked; the reading gave ${(cell.column === 0 ? left : right)[cell.row]}`,
    oneCall: accepted.has(reply.trim().toLowerCase()),
    oneCallReply: reply.slice(0, 60),
  };
}

function emptyTotals(withFlags) {
  const t = { numbers: 0, readRight: 0, wrongShownAsRight: 0, hiddenTried: 0, hiddenRebuilt: 0, changedTried: 0, changedCaught: 0, hard: null };
  if (withFlags) t.cleanPagesFlagged = 0;
  return t;
}

function passMarks(t, stepsRun, finished) {
  const a = t.addsUp;
  const b = t.oneCall;
  const share = (x) => (x.numbers ? x.wrongShownAsRight / x.numbers : 0);
  return [
    { measure: "Adds Up, wrong numbers shown as right", mark: "Zero, or at most one tenth of the one-call figure", value: `${a.wrongShownAsRight} of ${a.numbers}`, met: finished && stepsRun.A && stepsRun.B ? a.wrongShownAsRight === 0 || share(a) <= share(b) / 10 : null },
    { measure: "Clean pages flagged by mistake", mark: "At most 2 of 50", value: `${a.cleanPagesFlagged}`, met: finished && stepsRun.A ? a.cleanPagesFlagged <= 2 : null },
    { measure: "Hidden numbers rebuilt", mark: "At least 45 of 50", value: `${a.hiddenRebuilt} of ${a.hiddenTried}`, met: finished && stepsRun.C ? a.hiddenRebuilt >= 45 : null },
    { measure: "Changed numbers caught", mark: "At least 48 of 50", value: `${a.changedCaught} of ${a.changedTried}`, met: finished && stepsRun.D ? a.changedCaught >= 48 : null },
  ];
}

async function main() {
  const startedAt = new Date().toISOString();
  const list = JSON.parse(await sec("https://www.sec.gov/files/company_tickers.json"));
  const byCik = new Map();
  for (const entry of Object.values(list)) {
    const cik = String(entry.cik_str);
    if (!byCik.has(cik)) byCik.set(cik, { cik, name: entry.title, tickers: [] });
    byCik.get(cik).tickers.push(entry.ticker);
  }
  const ordered = [...byCik.values()].sort((x, y) => (sha(SALT + x.cik) < sha(SALT + y.cik) ? -1 : 1));
  console.log(`${ordered.length} companies in the SEC's list. First in order: ${ordered[0].name}.`);

  const stepsRun = { A: STEPS.has("A"), B: STEPS.has("B"), C: false, D: false, E: false, F: false };
  const scores = {
    status: "running", startedAt, finishedAt: null, filingsPlanned: LIMIT, filingsScored: 0, stepsRun,
    totals: { addsUp: emptyTotals(true), oneCall: emptyTotals(false) }, outsideTotals: 0,
    passMarks: [], cutoffs: null, recheck: null, causes: [], failures: [], filings: [], skipped: [],
  };
  const save = async () => {
    // A pass mark is judged only when all planned filings are scored.
    scores.passMarks = passMarks(scores.totals, stepsRun, scores.status === "done" && scores.filingsScored >= scores.filingsPlanned && scores.filingsPlanned >= 50);
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(scores, null, 2) + "\n");
  };
  await save();
  await writeFile(LOG, "");

  for (const company of ordered) {
    if (scores.filingsScored >= LIMIT) break;
    const filing = await checkEligible(company);
    if (filing.reason) {
      scores.skipped.push({ company: company.name, reason: filing.reason });
      continue;
    }
    try {
      const a = await stepA(company.cik);
      const b = STEPS.has("B") ? await stepB(company.cik, a.rows) : null;
      const usable = orderedCells(filing.accession, a.rows).filter((x) => x.usable);
      const c = STEPS.has("C") && usable[0] ? await stepC(company, a, usable[0]) : null;
      const d = STEPS.has("D") && usable[1] ? await stepD(company, a, usable[1]) : null;
      const t = scores.totals;
      const wrongTicked = a.cells.filter((x) => !x.right && x.status === "proven");
      t.addsUp.numbers += a.cells.length;
      t.addsUp.readRight += a.cells.filter((x) => x.right).length;
      t.addsUp.wrongShownAsRight += wrongTicked.length;
      t.addsUp.cleanPagesFlagged += a.flagged ? 1 : 0;
      scores.outsideTotals += a.cells.filter((x) => x.status === "not_proven").length;
      for (const x of wrongTicked) scores.failures.push({ company: company.name, step: "A", number: `${x.label}, column ${x.column + 1}`, shown: `${x.read} with a tick`, truth: `${x.truth}` });
      if (a.flagged) scores.failures.push({ company: company.name, step: "A", number: "a whole group", shown: "marked as not adding up on a clean page", truth: "the page was not changed" });
      if (b) {
        t.oneCall.numbers += b.cells.length;
        t.oneCall.readRight += b.cells.filter((x) => x.right).length;
        t.oneCall.wrongShownAsRight += b.cells.filter((x) => x.read !== null && !x.right).length;
      }
      if (c) {
        stepsRun.C = true;
        t.addsUp.hiddenTried += 1; t.addsUp.hiddenRebuilt += c.addsUp ? 1 : 0;
        t.oneCall.hiddenTried += 1; t.oneCall.hiddenRebuilt += c.oneCall ? 1 : 0;
        if (!c.addsUp) scores.failures.push({ company: company.name, step: "C", number: c.label, shown: c.shown, truth: c.truth });
      }
      if (d) {
        stepsRun.D = true;
        t.addsUp.changedTried += 1; t.addsUp.changedCaught += d.addsUp ? 1 : 0;
        t.oneCall.changedTried += 1; t.oneCall.changedCaught += d.oneCall ? 1 : 0;
        if (!d.addsUp) scores.failures.push({ company: company.name, step: "D", number: d.label, shown: d.shown, truth: d.truth });
      }
      scores.filings.push({
        company: company.name, cik: company.cik, form: filing.form, filed: filing.filed, numbers: a.cells.length,
        readRight: a.cells.filter((x) => x.right).length, wrongTicked: wrongTicked.length, flagged: a.flagged,
        hiddenRebuilt: c ? c.addsUp : null, changedCaught: d ? d.addsUp : null, seconds: a.seconds,
      });
      scores.filingsScored += 1;
      await note({ company: company.name, cik: company.cik, accession: filing.accession, appModelCalls: a.modelCalls, numbers: a.cells.length,
        wrong: a.cells.filter((x) => !x.right).map((x) => ({ label: x.label, column: x.column + 1, truth: x.truth, read: x.read, status: x.status })),
        oneCallWrong: b ? b.cells.filter((x) => !x.right).map((x) => ({ label: x.label, column: x.column + 1, truth: x.truth, read: x.read })) : null,
        hide: c, change: d, scriptUsage: { ...usage } });
      console.log(`[${scores.filingsScored}/${LIMIT}] ${company.name}: ${a.cells.length} numbers, ${a.cells.filter((x) => x.right).length} right, ${wrongTicked.length} wrong with a tick, ${a.seconds}s` + (b ? `; one call ${b.cells.filter((x) => x.right).length} right` : "") + (c ? `; hide ${c.addsUp ? "rebuilt" : "MISSED"} (one call ${c.oneCall ? "right" : "wrong: " + c.oneCallReply})` : "") + (d ? `; change ${d.addsUp ? "caught" : "MISSED"} (one call ${d.oneCall ? "right" : "wrong: " + d.oneCallReply})` : ""));
    } catch (error) {
      scores.skipped.push({ company: company.name, reason: `The run failed: ${String(error.message ?? error).slice(0, 160)}` });
      console.log(`skipped ${company.name}: ${String(error.message ?? error).slice(0, 160)}`);
    }
    await save();
  }
  scores.status = "done";
  scores.finishedAt = new Date().toISOString();
  await save();
  console.log(`Done. ${scores.filingsScored} filings scored, ${scores.skipped.length} skipped. Wrote ${OUT}.`);
  console.log(`The script's own model calls: ${usage.calls}, with ${usage.input} input and ${usage.output} output tokens. The app's calls are not counted here.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
