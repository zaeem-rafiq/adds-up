import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildComparisonRows,
  buildRecheckRows,
  formatCutoffPercent,
  formatWrongShownAsRight,
  getOutsideTotalsSummary,
  loadScores,
  parseScoresText,
  RECHECK_LABELS,
  resolveScoresPath,
} from "./scores";

describe("scores loader and formatting", () => {
  test("loads the full fixture with 50 internally consistent filings, 2 failures, and all 6 steps run", async () => {
    const result = await loadScores({ fixtureQuery: "full", isTestMode: true });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;

    const { scores } = result;
    expect(scores.status).toBe("done");
    expect(scores.filingsPlanned).toBe(50);
    expect(scores.filingsScored).toBe(50);
    expect(scores.filings).toHaveLength(50);
    expect(scores.failures).toHaveLength(2);
    expect(scores.stepsRun).toEqual({
      A: true,
      B: true,
      C: true,
      D: true,
      E: true,
      F: true,
    });

    // Every total in the fixture matches the sum of its 50 filings.
    const sumNumbers = scores.filings.reduce((acc, f) => acc + f.numbers, 0);
    const sumReadRight = scores.filings.reduce((acc, f) => acc + f.readRight, 0);
    const sumWrongTicked = scores.filings.reduce((acc, f) => acc + f.wrongTicked, 0);
    const sumFlagged = scores.filings.filter((f) => f.flagged).length;
    const sumHiddenRebuilt = scores.filings.filter((f) => f.hiddenRebuilt === true).length;
    const sumChangedCaught = scores.filings.filter((f) => f.changedCaught === true).length;

    expect(scores.totals.addsUp.numbers).toBe(sumNumbers);
    expect(scores.totals.addsUp.readRight).toBe(sumReadRight);
    expect(scores.totals.addsUp.wrongShownAsRight).toBe(sumWrongTicked);
    expect(scores.totals.addsUp.cleanPagesFlagged).toBe(sumFlagged);
    expect(scores.totals.addsUp.hiddenRebuilt).toBe(sumHiddenRebuilt);
    expect(scores.totals.addsUp.changedCaught).toBe(sumChangedCaught);
  });

  test("loads the running fixture with 32 of 50 filings scored and steps E and F not run", async () => {
    const result = await loadScores({
      fixtureQuery: "running",
      isTestMode: true,
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;

    const { scores } = result;
    expect(scores.status).toBe("running");
    expect(scores.finishedAt).toBeNull();
    expect(scores.filingsPlanned).toBe(50);
    expect(scores.filingsScored).toBe(32);
    expect(scores.filings).toHaveLength(32);
    expect(scores.stepsRun.E).toBe(false);
    expect(scores.stepsRun.F).toBe(false);

    const sumNumbers = scores.filings.reduce((acc, f) => acc + f.numbers, 0);
    const sumReadRight = scores.filings.reduce((acc, f) => acc + f.readRight, 0);
    const sumWrongTicked = scores.filings.reduce((acc, f) => acc + f.wrongTicked, 0);
    const sumFlagged = scores.filings.filter((f) => f.flagged).length;
    const sumHiddenRebuilt = scores.filings.filter((f) => f.hiddenRebuilt === true).length;
    const sumChangedCaught = scores.filings.filter((f) => f.changedCaught === true).length;

    expect(scores.totals.addsUp.numbers).toBe(sumNumbers);
    expect(scores.totals.addsUp.readRight).toBe(sumReadRight);
    expect(scores.totals.addsUp.wrongShownAsRight).toBe(sumWrongTicked);
    expect(scores.totals.addsUp.cleanPagesFlagged).toBe(sumFlagged);
    expect(scores.totals.addsUp.hiddenRebuilt).toBe(sumHiddenRebuilt);
    expect(scores.totals.addsUp.changedCaught).toBe(sumChangedCaught);
  });

  test("loads the empty fixture as empty state", async () => {
    const result = await loadScores({
      fixtureQuery: "empty",
      isTestMode: true,
    });
    expect(result).toEqual({ kind: "empty" });
  });

  test("returns empty state when data/scores.json is missing", async () => {
    const missingPath = path.join(
      process.cwd(),
      "src",
      "fixtures",
      "scores",
      "does-not-exist.json",
    );
    const result = await loadScores({
      isTestMode: false,
      scoresPath: missingPath,
    });
    expect(result).toEqual({ kind: "empty" });
  });

  test("ignores ?scores query outside test mode", () => {
    const prodPath = resolveScoresPath({
      fixtureQuery: "full",
      isTestMode: false,
    });
    expect(prodPath.endsWith(path.join("data", "scores.json"))).toBe(true);

    const testPath = resolveScoresPath({
      fixtureQuery: "full",
      isTestMode: true,
    });
    expect(
      testPath.endsWith(path.join("src", "fixtures", "scores", "full.json")),
    ).toBe(true);

    const unknownQueryPath = resolveScoresPath({
      fixtureQuery: "../evil",
      isTestMode: true,
    });
    expect(unknownQueryPath.endsWith(path.join("data", "scores.json"))).toBe(
      true,
    );
  });

  test("formats wrong numbers shown as right as 0 of N when zero and 2 decimals when non-zero", () => {
    expect(formatWrongShownAsRight(0, 2048, true)).toBe("0 of 2,048");
    expect(formatWrongShownAsRight(1, 3200, true)).toBe("0.03%");
    expect(formatWrongShownAsRight(288, 3200, true)).toBe("9.00%");
    expect(formatWrongShownAsRight(0, 3200, false)).toBe("not run");
  });

  test("formats comparison rows and marks unrun steps as 'not run'", async () => {
    const running = await loadScores({
      fixtureQuery: "running",
      isTestMode: true,
    });
    expect(running.kind).toBe("ready");
    if (running.kind !== "ready") return;

    const rows = buildComparisonRows(running.scores);
    expect(rows).toHaveLength(6);
    expect(rows[1].addsUp).toBe("0 of 2,048");
    expect(rows[2].oneCall).toBe("Does not apply");
    expect(rows[5].oneCall).toBe("not run");
    expect(rows[5].addsUp).toBe("not run");
  });

  test("builds all four re-check rows in fixed order, and shows not run when step E did not run", async () => {
    const full = await loadScores({ fixtureQuery: "full", isTestMode: true });
    expect(full.kind).toBe("ready");
    if (full.kind !== "ready") return;

    const fullRows = buildRecheckRows(full.scores);
    expect(fullRows.map((r) => r.said)).toEqual([...RECHECK_LABELS]);
    expect(fullRows[0]).toEqual({
      said: "90% or more",
      answers: "284",
      trulyThere: "98.9% (281)",
    });
    expect(fullRows[2]).toEqual({
      said: "30% to 70%",
      answers: "18",
      trulyThere: "5.6% (1)",
    });

    const running = await loadScores({
      fixtureQuery: "running",
      isTestMode: true,
    });
    expect(running.kind).toBe("ready");
    if (running.kind !== "ready") return;

    const runningRows = buildRecheckRows(running.scores);
    expect(runningRows.map((r) => r.said)).toEqual([...RECHECK_LABELS]);
    for (const row of runningRows) {
      expect(row.answers).toBe("not run");
      expect(row.trulyThere).toBe("not run");
    }
  });

  test("formats cutoff percentages and outside-totals summary", async () => {
    expect(formatCutoffPercent(0.95)).toBe("95%");
    expect(formatCutoffPercent(0.2)).toBe("20%");
    expect(formatCutoffPercent(null)).toBeNull();

    const full = await loadScores({ fixtureQuery: "full", isTestMode: true });
    expect(full.kind).toBe("ready");
    if (full.kind !== "ready") return;

    expect(getOutsideTotalsSummary(full.scores)).toBe("4.0% (128 of 3,200 numbers)");
  });

  test("returns error state for invalid JSON or incomplete score data", () => {
    expect(parseScoresText("{bad json").kind).toBe("error");
    expect(parseScoresText('{"status":"done"}').kind).toBe("error");
    expect(parseScoresText("{}").kind).toBe("empty");
    expect(parseScoresText("null").kind).toBe("empty");
  });
});
