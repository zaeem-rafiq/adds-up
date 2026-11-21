#!/usr/bin/env node
/**
 * Step E of the 50-filing test: the second reader, Gemini Decision 1.
 * The rules were fixed before the event in docs/eval-spec.md.
 *
 * It runs after scripts/run-eval.mjs, on the same filings in the same order. For each filing it
 * takes the first 20 cells in the fixed hash order. The ten with the smallest hashes keep their
 * true value, and the other ten get a changed value. It asks Decision 1 one yes-or-no question
 * per cell, 20 in one request, on the whole statement picture at the top picture detail.
 *
 * It then sets the two cut-offs from the first 20 filings, builds the table "How sure is the
 * re-check?" from the other filings, and writes both into data/scores.json and data/cutoffs.json.
 *
 *   EVAL_APP=http://localhost:3230 node scripts/run-eval-recheck.mjs
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { GoogleGenAI } from "@google/genai";

const APP = process.env.EVAL_APP ?? "http://localhost:3230";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const OUT = arg("--out") ?? "data/scores.json";
const LOG = OUT.replace(/\.json$/, "") + ".log.jsonl";
const CUTOFFS_OUT = arg("--cutoffs") ?? "data/cutoffs.json";
const SET_ON = 20; // the cut-offs are set on the first 20 filings

if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
const ai = new GoogleGenAI({ apiVersion: "v1beta" });
const sha = (text) => createHash("sha256").update(text).digest("hex");

/** The changed value of docs/eval-spec.md: 1 added to the second digit from the left. */
function changedValue(n) {
  const text = String(Math.abs(n));
  const places = [...text].map((ch, i) => (/\d/.test(ch) ? i : -1)).filter((i) => i >= 0);
  const at = places.length > 1 ? places[1] : places[0];
  const digits = [...text];
  digits[at] = String((Number(digits[at]) + 1) % 10);
  return Number(digits.join("")) * (n < 0 ? -1 : 1);
}

const printed = (n) => {
  const body = Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return n < 0 ? `(${body})` : body;
};

async function readRows(cik) {
  const res = await fetch(`${APP}/api/company/${cik}/read`, {
    method: "POST",
    headers: { Cookie: `adds_up_browser=eval-${randomUUID()}` },
    signal: AbortSignal.timeout(120_000),
  });
  const events = (await res.text()).split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));
  const done = events.find((e) => e.type === "done");
  if (!done) throw new Error("The app gave no reading.");
  return done.result.comparison.rows;
}

async function main() {
  const scores = JSON.parse(await readFile(OUT, "utf8"));
  const filings = (await readFile(LOG, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const answers = []; // { filing, truthful, probability }
  let requests = 0;

  for (const [index, filing] of filings.entries()) {
    try {
      const rows = await readRows(filing.cik);
      const cells = [];
      rows.forEach((row, r) =>
        [0, 1].forEach((c) => {
          if (row.cells[c].expected === null) return;
          cells.push({ row: r, column: c, label: row.label, truth: row.cells[c].expected, hash: sha(`${filing.accession}:${r + 1}:${c + 1}`) });
        }),
      );
      cells.sort((x, y) => (x.hash < y.hash ? -1 : 1));
      const chosen = cells.slice(0, 20).map((cell, i) => ({ ...cell, truthful: i < 10 }));
      // The questions go out in page order.
      chosen.sort((x, y) => x.row - y.row || x.column - y.column);
      const questions = {};
      chosen.forEach((cell, i) => {
        const value = cell.truthful ? cell.truth : changedValue(cell.truth);
        const side = cell.column === 0 ? "left" : "right";
        questions[`q${String(i + 1).padStart(2, "0")}`] = {
          type: "noul",
          instructions: `Is the value ${printed(value)} printed for the row '${cell.label}' in the ${side} column?`,
        };
      });
      const png = Buffer.from(await (await fetch(`${APP}/api/company/${filing.cik}/picture`, { signal: AbortSignal.timeout(60_000) })).arrayBuffer());
      const d = await ai.decisions.create({
        model: "gemini-decision-1",
        input: [{ type: "image", data: png.toString("base64"), mime_type: "image/png", resolution: "ultra_high" }],
        questions,
      });
      requests += 1;
      chosen.forEach((cell, i) => {
        const p = d.answers?.[`q${String(i + 1).padStart(2, "0")}`]?.noul;
        if (typeof p === "number") answers.push({ filing: index, truthful: cell.truthful, probability: p });
      });
      const mine = answers.filter((x) => x.filing === index);
      const mean = (list) => (list.length ? (list.reduce((s, x) => s + x.probability, 0) / list.length).toFixed(2) : "none");
      console.log(`[${index + 1}/${filings.length}] ${filing.company}: true values average ${mean(mine.filter((x) => x.truthful))}, changed values average ${mean(mine.filter((x) => !x.truthful))}`);
    } catch (error) {
      console.log(`[${index + 1}/${filings.length}] ${filing.company}: step E failed: ${String(error.message ?? error).slice(0, 140)}`);
    }
  }

  const setOn = answers.filter((x) => x.filing < SET_ON);
  const rest = answers.filter((x) => x.filing >= SET_ON);
  const topChanged = Math.max(0, ...setOn.filter((x) => !x.truthful).map((x) => x.probability));
  const lowTrue = Math.min(1, ...setOn.filter((x) => x.truthful).map((x) => x.probability));
  // The upper cut-off is the lowest of these that no changed value reached.
  const upper = [0.9, 0.95, 0.98, 0.99].find((t) => topChanged < t) ?? null;
  // The lower cut-off is the highest of these that no true value fell under.
  const lower = [0.3, 0.2, 0.1, 0.05].find((t) => lowTrue >= t) ?? null;

  const bins = [
    ["90% or more", (p) => p >= 0.9],
    ["70% to 90%", (p) => p >= 0.7 && p < 0.9],
    ["30% to 70%", (p) => p >= 0.3 && p < 0.7],
    ["Under 30%", (p) => p < 0.3],
  ];
  scores.recheck = bins.map(([said, inBin]) => {
    const group = rest.filter((x) => inBin(x.probability));
    return { said, answers: group.length, trulyThere: group.filter((x) => x.truthful).length };
  });
  scores.cutoffs = { upper, lower, setOnFilings: SET_ON };
  scores.stepsRun.E = true;
  await writeFile(OUT, JSON.stringify(scores, null, 2) + "\n");
  if (upper !== null && lower !== null) await writeFile(CUTOFFS_OUT, JSON.stringify({ upper, lower }, null, 2) + "\n");

  console.log(`Done. ${requests} requests, ${answers.length} answers.`);
  console.log(`On the first ${SET_ON} filings: the highest probability for a changed value was ${topChanged.toFixed(3)}, and the lowest for a true value was ${lowTrue.toFixed(3)}.`);
  console.log(`Cut-offs: upper ${upper}, lower ${lower}.`);
  console.log("How sure is the re-check, on the other filings:", JSON.stringify(scores.recheck));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
