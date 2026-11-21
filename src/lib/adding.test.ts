import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  CHANGE_NOT_CAUGHT_MESSAGE,
  GROUP_NOT_IN_BOTH_COLUMNS_REASON,
  canHideCell,
  classifyColumn,
  findGroups,
  parseChangedNumberInput,
  proveColumns,
  proveColumnsWithChange,
  proveColumnsWithHidden,
  rebuildHiddenCell,
  roundingAllowedSteps,
  ROUNDING_GROUP_REASON,
  unitLineAllowsRounding,
  type ProveColumnsOptions,
} from "./adding";
import type { Statement } from "./statements";

/** Helper to convert 0-based groups to 1-based row numbers matching docs/test-cases.md. */
function toOneBased(groups: ReturnType<typeof findGroups>) {
  return groups.map((g) => ({
    members: g.memberIndices.map((idx) => idx + 1),
    total: g.totalIndex + 1,
    sum: g.sum,
  }));
}

/** Reads every statement the app saved in data/saved. */
function loadSavedStatements(): Statement[] {
  const dir = path.join(process.cwd(), "data", "saved");
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
}

/**
 * Adds 1 to the second digit from the left of a number (a 9 becomes 0, with no carry),
 * keeping the sign and the decimal point. Returns null when the number has one digit.
 */
function addOneToSecondDigit(value: number): number | null {
  const text = String(Math.abs(value));
  const digitPositions: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] >= "0" && text[i] <= "9") digitPositions.push(i);
  }
  if (digitPositions.length < 2) return null;
  const at = digitPositions[1];
  const bumped = (Number(text[at]) + 1) % 10;
  const changedText = `${text.slice(0, at)}${bumped}${text.slice(at + 1)}`;
  const result = Number(changedText);
  return value < 0 ? -result : result;
}

/**
 * Replays every saved statement with the SEC's own values as a perfect reading.
 * For each number that canHideCell allows, it hides the number and rebuilds it,
 * then changes it and checks that the change is caught.
 *
 * With `withRounding`, the proof also gets each statement's unit line and total flags,
 * as the page and the server give them, so the rounding rule is part of the replay.
 */
function replaySavedStatements(withRounding = false) {
  const statements = loadSavedStatements();
  const result = {
    files: statements.length,
    cells: 0,
    allowed: 0,
    refused: 0,
    rebuiltRight: 0,
    wrongOrNotRebuilt: [] as string[],
    refusedAfterProvenByAdding: 0,
    wrongIfNotRefused: 0,
    withinRoundingCells: 0,
    withinRoundingRefusedWithReason: 0,
    withinRoundingAllowed: [] as string[],
    changed: 0,
    noSecondDigit: 0,
    changeCaught: 0,
    changeNotCaught: [] as string[],
    changeNamedForeignGroup: [] as string[],
    changeMarkedNewForeignGroup: [] as string[],
    changeMovedOtherColumn: [] as string[],
    changeMovedRoundingGroups: [] as string[],
  };

  for (const statement of statements) {
    const rows = statement.rows.filter((row) => row.kind === "number");
    const columns: [Array<number | null>, Array<number | null>] = [
      rows.map((row) => (row.kind === "number" ? row.numbers[0] : null)),
      rows.map((row) => (row.kind === "number" ? row.numbers[1] : null)),
    ];
    const unreadMask = rows.map(() => [false, false] as const);
    const proveOptions: ProveColumnsOptions = {
      unreadMask,
      ...(withRounding
        ? {
            unitLine: statement.unitLine,
            totalFlags: rows.map((row) => row.kind === "number" && row.isTotal),
          }
        : {}),
    };
    const proof = proveColumns(columns[0], columns[1], proveOptions);

    for (const colIndex of [0, 1] as const) {
      const proofColumn = colIndex === 0 ? proof.left : proof.right;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const trueValue = columns[colIndex][rowIndex];
        if (trueValue === null) continue;
        result.cells += 1;
        const where = `${statement.companyName} row ${rowIndex + 1} ${colIndex === 0 ? "left" : "right"}`;

        const hidden: [Array<number | null>, Array<number | null>] = [
          [...columns[0]],
          [...columns[1]],
        ];
        hidden[colIndex][rowIndex] = null;
        const rebuild = rebuildHiddenCell(hidden[0], hidden[1], {
          rowIndex,
          colIndex,
        });
        const decision = canHideCell(proof, rowIndex, colIndex);

        if (proofColumn.cellStatuses[rowIndex] === "within_rounding") {
          result.withinRoundingCells += 1;
          if (decision.allowed) {
            result.withinRoundingAllowed.push(where);
          } else if (decision.reason === ROUNDING_GROUP_REASON) {
            result.withinRoundingRefusedWithReason += 1;
          }
        }

        if (!decision.allowed) {
          result.refused += 1;
          if (proofColumn.cellStatuses[rowIndex] === "proven") {
            result.refusedAfterProvenByAdding += 1;
            if (rebuild.status === "rebuilt" && rebuild.value !== trueValue) {
              result.wrongIfNotRefused += 1;
            }
          }
          continue;
        }

        result.allowed += 1;
        if (rebuild.status === "rebuilt" && rebuild.value === trueValue) {
          result.rebuiltRight += 1;
        } else {
          result.wrongOrNotRebuilt.push(
            `${where}: ${rebuild.status} ${rebuild.status === "rebuilt" ? rebuild.value : ""} instead of ${trueValue}`,
          );
        }

        const changedValue = addOneToSecondDigit(trueValue);
        if (changedValue === null) {
          result.noSecondDigit += 1;
          continue;
        }
        result.changed += 1;
        const changedColumns: [Array<number | null>, Array<number | null>] = [
          [...columns[0]],
          [...columns[1]],
        ];
        changedColumns[colIndex][rowIndex] = changedValue;
        const outcome = proveColumnsWithChange(
          proof,
          changedColumns[0],
          changedColumns[1],
          { rowIndex, colIndex },
          proveOptions,
        );
        if (outcome.caught) {
          result.changeCaught += 1;
        } else {
          result.changeNotCaught.push(`${where}: ${trueValue} -> ${changedValue}`);
        }
        for (const mismatch of outcome.caughtMismatches) {
          if (
            mismatch.totalIndex !== rowIndex &&
            !mismatch.memberIndices.includes(rowIndex)
          ) {
            result.changeNamedForeignGroup.push(where);
          }
        }

        // Every mark in the changed column holds the changed number or was there before the change.
        const changedProofColumn = colIndex === 0 ? outcome.proof.left : outcome.proof.right;
        const baseProofColumn = colIndex === 0 ? proof.left : proof.right;
        for (const mismatch of changedProofColumn.mismatches) {
          const holdsChangedNumber =
            mismatch.totalIndex === rowIndex ||
            mismatch.memberIndices.includes(rowIndex);
          const wasMarkedBefore = baseProofColumn.mismatches.some(
            (earlier) =>
              earlier.totalIndex === mismatch.totalIndex &&
              earlier.memberIndices.join() === mismatch.memberIndices.join(),
          );
          if (!holdsChangedNumber && !wasMarkedBefore) {
            result.changeMarkedNewForeignGroup.push(where);
          }
        }

        // The other column is not touched by the change.
        const otherProofColumn = colIndex === 0 ? outcome.proof.right : outcome.proof.left;
        const baseOtherColumn = colIndex === 0 ? proof.right : proof.left;
        if (
          JSON.stringify(otherProofColumn.mismatches) !==
            JSON.stringify(baseOtherColumn.mismatches) ||
          JSON.stringify(otherProofColumn.roundingGroups) !==
            JSON.stringify(baseOtherColumn.roundingGroups)
        ) {
          result.changeMovedOtherColumn.push(where);
        }

        // A change to an allowed number leaves the changed column's rounding groups as they were:
        // none of them holds the changed number, and none becomes a mark.
        if (
          JSON.stringify(changedProofColumn.roundingGroups) !==
          JSON.stringify(baseProofColumn.roundingGroups)
        ) {
          result.changeMovedRoundingGroups.push(where);
        }
      }
    }
  }

  return result;
}

describe("The adding rule (Section C of docs/test-cases.md)", () => {
  test("C1: 10, 25, 40, 75 -> row 4 is the total of rows 1 to 3", () => {
    const groups = findGroups([10, 25, 40, 75]);
    expect(toOneBased(groups)).toEqual([
      { members: [1, 2, 3], total: 4, sum: 75 },
    ]);
  });

  test("C2: 10, 20, 30, 5, 6, 11, 41 -> nested groups and grand total", () => {
    const groups = findGroups([10, 20, 30, 5, 6, 11, 41]);
    expect(toOneBased(groups)).toEqual([
      { members: [1, 2], total: 3, sum: 30 },
      { members: [4, 5], total: 6, sum: 11 },
      { members: [3, 6], total: 7, sum: 41 },
    ]);
  });

  test("C3: 10, 0, 20, 30 -> row 4 totals rows 1 to 3 with a zero inside the group", () => {
    const groups = findGroups([10, 0, 20, 30]);
    expect(toOneBased(groups)).toEqual([
      { members: [1, 2, 3], total: 4, sum: 30 },
    ]);
  });

  test("C4: 0, 0, 0 -> no group because a zero is never a total", () => {
    const groups = findGroups([0, 0, 0]);
    expect(groups).toEqual([]);
  });

  test("C5: 10, None, 20, 30 -> no group because an unreadable row stops the search", () => {
    const groups = findGroups([10, null, 20, 30]);
    expect(groups).toEqual([]);
  });

  test("C6: 10, 20, 31, 5 -> no group and all 4 numbers are not proven", () => {
    const values = [10, 20, 31, 5];
    const groups = findGroups(values);
    expect(groups).toEqual([]);
    expect(classifyColumn(values, groups)).toEqual([
      "not_proven",
      "not_proven",
      "not_proven",
      "not_proven",
    ]);
  });

  test("C7: 20, 10, 10, 20 -> row 4 totals rows 2 and 3 (nearest rows win) and row 1 stays open", () => {
    const groups = findGroups([20, 10, 10, 20]);
    expect(toOneBased(groups)).toEqual([
      { members: [2, 3], total: 4, sum: 20 },
    ]);
    expect(classifyColumn([20, 10, 10, 20], groups)).toEqual([
      "not_proven",
      "proven",
      "proven",
      "proven",
    ]);
  });

  test("C8: 100, -30, 70 -> row 3 totals rows 1 and 2 with a negative member", () => {
    const groups = findGroups([100, -30, 70]);
    expect(toOneBased(groups)).toEqual([
      { members: [1, 2], total: 3, sum: 70 },
    ]);
  });

  test("C9: 5, 5, 10, 10 -> row 3 totals rows 1 and 2, and row 4 is no total (one open row is not a group)", () => {
    const groups = findGroups([5, 5, 10, 10]);
    expect(toOneBased(groups)).toEqual([
      { members: [1, 2], total: 3, sum: 10 },
    ]);
  });

  test("C10: 10, 20, 30, 60 -> row 3 totals rows 1 and 2, and row 4 is no total", () => {
    const groups = findGroups([10, 20, 30, 60]);
    expect(toOneBased(groups)).toEqual([
      { members: [1, 2], total: 3, sum: 30 },
    ]);
  });

  test("C11: Apple 2026 current assets -> row 7 totals rows 1 to 6", () => {
    const values = [36305, 20417, 43817, 39896, 14541, 18881, 173857];
    const groups = findGroups(values);
    expect(toOneBased(groups)).toEqual([
      { members: [1, 2, 3, 4, 5, 6], total: 7, sum: 173857 },
    ]);
  });

  test("C12: nested Apple current assets + second group + grand total -> all 11 numbers are proven", () => {
    const values = [
      36305, 20417, 43817, 39896, 14541, 18881, 173857, 100, 200, 300, 174157,
    ];
    const groups = findGroups(values);
    expect(toOneBased(groups)).toEqual([
      { members: [1, 2, 3, 4, 5, 6], total: 7, sum: 173857 },
      { members: [8, 9], total: 10, sum: 300 },
      { members: [7, 10], total: 11, sum: 174157 },
    ]);
    expect(classifyColumn(values, groups)).toEqual(
      new Array(11).fill("proven"),
    );
  });

  test("C13: changed row 5 breaks the total -> no group", () => {
    const values = [36305, 20417, 43817, 39896, 15541, 18881, 173857];
    const groups = findGroups(values);
    expect(groups).toEqual([]);
  });

  test("C14: two-column rule proves left rows 1 to 7 and marks right rows 1 to 7 as not adding up (147,962 vs 147,957, gap 5)", () => {
    const left = [36305, 20417, 43817, 39896, 14541, 18881, 173857];
    const right = [35934, 18768, 39777, 33180, 5718, 14585, 147957];

    const proof = proveColumns(left, right);

    expect(toOneBased(proof.left.groups)).toEqual([
      { members: [1, 2, 3, 4, 5, 6], total: 7, sum: 173857 },
    ]);
    expect(proof.left.mismatches).toEqual([]);
    expect(proof.left.cellStatuses).toEqual(new Array(7).fill("proven"));

    expect(proof.right.groups).toEqual([]);
    expect(proof.right.mismatches).toEqual([
      {
        memberIndices: [0, 1, 2, 3, 4, 5],
        totalIndex: 6,
        computedSum: 147962,
        printedTotal: 147957,
        gap: 5,
        diff: 5,
      },
    ]);
    expect(proof.right.cellStatuses).toEqual(new Array(7).fill("mismatch"));
    expect(proof.counts).toEqual({
      proven: 7,
      withinRounding: 0,
      needYourEye: 7,
      notProven: 0,
      total: 14,
    });
  });

  test("C15: Luxfer Holdings current liabilities -> no group marked as not adding up, left 6 numbers and right 7 numbers are all proven", () => {
    const left: Array<number | null> = [null, 22, 34.6, 5.8, 0, 14.9, 77.3];
    const right: Array<number | null> = [25, 24.6, 27.2, 2.6, 2.8, 16, 98.2];

    const proof = proveColumns(left, right, {
      unreadMask: left.map(() => [false, false] as const),
    });

    expect(toOneBased(proof.left.groups)).toEqual([
      { members: [2, 3, 4, 5, 6], total: 7, sum: 77.3 },
    ]);
    expect(toOneBased(proof.right.groups)).toEqual([
      { members: [1, 2, 3, 4, 5, 6], total: 7, sum: 98.2 },
    ]);
    expect(proof.left.mismatches).toEqual([]);
    expect(proof.right.mismatches).toEqual([]);
    expect(proof.left.cellStatuses).toEqual([
      "empty",
      "proven",
      "proven",
      "proven",
      "proven",
      "proven",
      "proven",
    ]);
    expect(proof.right.cellStatuses).toEqual(new Array(7).fill("proven"));
    expect(proof.counts).toEqual({
      proven: 13,
      withinRounding: 0,
      needYourEye: 0,
      notProven: 0,
      total: 13,
    });

    const proofWithoutMask = proveColumns(left, right);
    expect(proofWithoutMask.left.mismatches).toEqual([]);
    expect(proofWithoutMask.right.mismatches).toEqual([]);
    expect(proofWithoutMask.left.cellStatuses.slice(1)).toEqual(
      new Array(6).fill("proven"),
    );
    expect(proofWithoutMask.right.cellStatuses).toEqual(
      new Array(7).fill("proven"),
    );
  });

  // The numbers come from Leef Brands' equity lines, with one invented line above them that has a
  // value on the left only. The real filing has no such line: its left column does not add up.
  test("a line with a value in the left column only does not mark the left column as not adding up, and every number is proven", () => {
    const left: Array<number | null> = [
      7989928, 138010289, -336879, -141451648, 4211690,
    ];
    const right: Array<number | null> = [
      null,
      131445688,
      -336879,
      -139377110,
      -8268301,
    ];

    const proof = proveColumns(left, right, {
      unreadMask: left.map(() => [false, false] as const),
    });

    expect(toOneBased(proof.left.groups)).toEqual([
      { members: [1, 2, 3, 4], total: 5, sum: 4211690 },
    ]);
    expect(toOneBased(proof.right.groups)).toEqual([
      { members: [2, 3, 4], total: 5, sum: -8268301 },
    ]);
    expect(proof.left.mismatches).toEqual([]);
    expect(proof.right.mismatches).toEqual([]);
    expect(proof.left.cellStatuses).toEqual(new Array(5).fill("proven"));
    expect(proof.right.cellStatuses).toEqual([
      "empty",
      "proven",
      "proven",
      "proven",
      "proven",
    ]);
    expect(proof.counts).toEqual({
      proven: 9,
      withinRounding: 0,
      needYourEye: 0,
      notProven: 0,
      total: 9,
    });

    const proofWithoutMask = proveColumns(left, right);
    expect(proofWithoutMask.left.mismatches).toEqual([]);
    expect(proofWithoutMask.right.mismatches).toEqual([]);
    expect(proofWithoutMask.left.cellStatuses).toEqual(
      new Array(5).fill("proven"),
    );
    expect(proofWithoutMask.right.cellStatuses.slice(1)).toEqual(
      new Array(4).fill("proven"),
    );
  });

  test("two-column rule with nested Apple balance sheet when one left current asset is off by 5,000", () => {
    const left = [
      36305, 20417, 48817, 39896, 14541, 18881, 173857, 80213, 52084, 20278,
      78116, 230691, 404548,
    ];
    const right = [
      35934, 18763, 39777, 33180, 5718, 14585, 147957, 77723, 49834, 11093,
      72634, 211284, 359241,
    ];

    const proof = proveColumns(left, right);

    expect(proof.right.cellStatuses).toEqual(new Array(13).fill("proven"));
    expect(proof.left.mismatches).toEqual([
      {
        memberIndices: [0, 1, 2, 3, 4, 5],
        totalIndex: 6,
        computedSum: 178857,
        printedTotal: 173857,
        gap: 5000,
        diff: 5000,
      },
    ]);
    // Rows 1..7 on the left are in the broken group (7 need your eye);
    // rows 8..13 on the left (6) + all 13 on the right = 19 proven.
    expect(proof.counts).toEqual({
      proven: 19,
      withinRounding: 0,
      needYourEye: 7,
      notProven: 0,
      total: 26,
    });
  });

  test("unreadMask distinguishes unread numbers from legitimately empty/dash cells", () => {
    const left = [100, null, 50];
    const right = [90, 10, 100];

    const proof = proveColumns(left, right, {
      unreadMask: [
        [false, false],
        [false, false], // left row 2 is a dash, not unread
        [false, false],
      ],
    });

    expect(proof.left.cellStatuses[1]).toBe("empty");
    expect(proof.counts).toEqual({
      proven: 3, // right column [90, 10] -> 100
      withinRounding: 0,
      needYourEye: 0,
      notProven: 2, // left 100 and 50
      total: 5,
    });
  });

  test("Section C property test: random column of 2-to-6 positive-number groups followed by their sums finds every total", () => {
    const groupArb = fc.array(fc.integer({ min: 1, max: 10_000 }), {
      minLength: 2,
      maxLength: 6,
    });
    const groupsArb = fc.array(groupArb, { minLength: 1, maxLength: 5 });

    fc.assert(
      fc.property(groupsArb, (rawGroups) => {
        const column: number[] = [];
        const expectedTotals: Array<{
          memberIndices: number[];
          totalIndex: number;
          sum: number;
        }> = [];
        const simulatedOpen: number[] = [];
        let hasAccidentalMatch = false;

        for (const members of rawGroups) {
          const memberIndices: number[] = [];
          let groupSum = 0;

          for (const value of members) {
            // Check whether this non-total member accidentally equals the sum
            // of the last 2+ open rows above it (as in C10).
            if (simulatedOpen.length >= 2) {
              let suffixSum = 0;
              for (let k = simulatedOpen.length - 1; k >= 0; k -= 1) {
                suffixSum += simulatedOpen[k];
                const count = simulatedOpen.length - k;
                if (count >= 2 && suffixSum === value) {
                  hasAccidentalMatch = true;
                  break;
                }
              }
            }
            if (hasAccidentalMatch) break;

            memberIndices.push(column.length);
            column.push(value);
            simulatedOpen.push(value);
            groupSum += value;
          }

          if (hasAccidentalMatch) break;

          // Also ensure the total matches this exact group and not a shorter
          // accidental suffix inside the group (impossible for strictly positive
          // numbers since all prefixes of the suffix are strictly smaller than
          // groupSum, so only member-level accidental matches can occur).
          const totalIndex = column.length;
          column.push(groupSum);
          expectedTotals.push({ memberIndices, totalIndex, sum: groupSum });

          // Replace the group's members in simulatedOpen with its total.
          simulatedOpen.length -= members.length;
          simulatedOpen.push(groupSum);
        }

        // Skip columns with an accidental match like C10.
        fc.pre(!hasAccidentalMatch);

        const found = findGroups(column);
        for (const expected of expectedTotals) {
          expect(found).toContainEqual(expected);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("Hide and change (Section D of docs/test-cases.md)", () => {
  const LEFT_C11 = [36305, 20417, 43817, 39896, 14541, 18881, 173857];
  const RIGHT_C11 = [35934, 18763, 39777, 33180, 5718, 14585, 147957];
  const C12 = [
    36305, 20417, 43817, 39896, 14541, 18881, 173857, 100, 200, 300, 174157,
  ];

  test("D1: hides row 5 on the left (14,541) -> rebuilds 14,541 as 173,857 minus 159,316", () => {
    const leftHidden: Array<number | null> = [...LEFT_C11];
    leftHidden[4] = null; // Row 5 (1-based) = index 4

    const { proof, rebuild } = proveColumnsWithHidden(leftHidden, RIGHT_C11, {
      rowIndex: 4,
      colIndex: 0,
    });

    expect(rebuild.status).toBe("rebuilt");
    if (rebuild.status === "rebuilt") {
      expect(rebuild.value).toBe(14541);
      expect(rebuild.agreed).toBe(true);
      expect(rebuild.ways).toHaveLength(1);
      expect(rebuild.ways[0]).toEqual({
        kind: "total_minus_others",
        memberIndices: [0, 1, 2, 3, 4, 5],
        totalIndex: 6,
        value: 14541,
        otherMembersSum: 159316,
        printedTotal: 173857,
      });
    }
    expect(proof.counts).toEqual({
      proven: 14,
      withinRounding: 0,
      needYourEye: 0,
      notProven: 0,
      total: 14,
    });
  });

  test("D2: hides row 7 on the left (the total) -> rebuilds 173,857 as sum of rows 1 to 6", () => {
    const leftHidden: Array<number | null> = [...LEFT_C11];
    leftHidden[6] = null; // Row 7 (1-based) = index 6

    const { proof, rebuild } = proveColumnsWithHidden(leftHidden, RIGHT_C11, {
      rowIndex: 6,
      colIndex: 0,
    });

    expect(rebuild.status).toBe("rebuilt");
    if (rebuild.status === "rebuilt") {
      expect(rebuild.value).toBe(173857);
      expect(rebuild.agreed).toBe(true);
      expect(rebuild.ways).toHaveLength(1);
      expect(rebuild.ways[0]).toEqual({
        kind: "sum_of_members",
        memberIndices: [0, 1, 2, 3, 4, 5],
        totalIndex: 6,
        value: 173857,
        otherMembersSum: 173857,
        printedTotal: null,
      });
    }
    expect(proof.left.cellStatuses).toEqual(new Array(7).fill("proven"));
  });

  test("D3: uses C12 on both sides and hides row 7 on the left -> rebuilds 173,857 two ways and both agree", () => {
    const leftHidden: Array<number | null> = [...C12];
    leftHidden[6] = null; // Row 7 (1-based) = index 6

    const rebuild = rebuildHiddenCell(leftHidden, C12, {
      rowIndex: 6,
      colIndex: 0,
    });

    expect(rebuild.status).toBe("rebuilt");
    if (rebuild.status === "rebuilt") {
      expect(rebuild.value).toBe(173857);
      expect(rebuild.agreed).toBe(true);
      expect(rebuild.ways).toHaveLength(2);
      expect(rebuild.ways).toContainEqual({
        kind: "sum_of_members",
        memberIndices: [0, 1, 2, 3, 4, 5],
        totalIndex: 6,
        value: 173857,
        otherMembersSum: 173857,
        printedTotal: null,
      });
      expect(rebuild.ways).toContainEqual({
        kind: "total_minus_others",
        memberIndices: [6, 9],
        totalIndex: 10,
        value: 173857,
        otherMembersSum: 300,
        printedTotal: 174157,
      });
    }
  });

  test("D4: changes row 5 on the left to 15,541 -> marks rows 1 to 7 on the left as not adding up (174,857 vs 173,857, gap 1,000) while right keeps ticks", () => {
    const leftChanged = [...LEFT_C11];
    leftChanged[4] = 15541;

    const proof = proveColumns(leftChanged, RIGHT_C11);

    expect(proof.left.groups).toEqual([]);
    expect(proof.left.mismatches).toEqual([
      {
        memberIndices: [0, 1, 2, 3, 4, 5],
        totalIndex: 6,
        computedSum: 174857,
        printedTotal: 173857,
        gap: 1000,
        diff: 1000,
      },
    ]);
    expect(proof.left.cellStatuses).toEqual(new Array(7).fill("mismatch"));
    expect(proof.right.mismatches).toEqual([]);
    expect(proof.right.cellStatuses).toEqual(new Array(7).fill("proven"));
  });

  test("D5: trying to hide a number outside every total is refused with a plain reason", () => {
    const left = [10, 20, 31, 5];
    const right = [10, 20, 31, 5];
    const proof = proveColumns(left, right);

    const decision = canHideCell(proof, 0, 0);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toMatch(/outside every total/i);
    }

    // Also verify a proven cell IS allowed.
    const provenProof = proveColumns(LEFT_C11, RIGHT_C11);
    expect(canHideCell(provenProof, 4, 0)).toEqual({ allowed: true });
  });

  test("D6: hides a number while the other column has no group for those rows -> cannot rebuild and never guesses", () => {
    const leftHidden: Array<number | null> = [...LEFT_C11];
    leftHidden[4] = null;
    // Other column has no group for rows 1..7 (e.g., broken total).
    const rightNoGroup = [35934, 18763, 39777, 33180, 5718, 14585, 999999];

    const { proof, rebuild } = proveColumnsWithHidden(leftHidden, rightNoGroup, {
      rowIndex: 4,
      colIndex: 0,
    });

    expect(rebuild.status).toBe("cannot_rebuild");
    if (rebuild.status === "cannot_rebuild") {
      expect(rebuild.reason).toMatch(/cannot rebuild/i);
      expect(rebuild.reason).toMatch(/never guesses/i);
    }
    expect(proof.left.cellStatuses[4]).toBe("unread");
  });

  test("D7: left 7, 5, 20, 32 and right no value, 5, 20, 25 -> hiding or changing the 20 on the left is refused with the group reason, and so is every other number", () => {
    const left: Array<number | null> = [7, 5, 20, 32];
    const right: Array<number | null> = [null, 5, 20, 25];
    const proof = proveColumns(left, right, {
      unreadMask: left.map(() => [false, false] as const),
    });

    // The left group is rows 1 to 3 -> row 4. The right group is rows 2 and 3 -> row 4.
    expect(toOneBased(proof.left.groups)).toEqual([
      { members: [1, 2, 3], total: 4, sum: 32 },
    ]);
    expect(toOneBased(proof.right.groups)).toEqual([
      { members: [2, 3], total: 4, sum: 25 },
    ]);

    // Hide and change both ask canHideCell, so both get the same answer.
    expect(canHideCell(proof, 2, 0)).toEqual({
      allowed: false,
      reason:
        "This number's group does not exist in both columns, so the page cannot rebuild it.",
    });
    expect(GROUP_NOT_IN_BOTH_COLUMNS_REASON).toBe(
      "This number's group does not exist in both columns, so the page cannot rebuild it.",
    );

    for (let row = 0; row < 4; row += 1) {
      expect(canHideCell(proof, row, 0).allowed).toBe(false);
      expect(canHideCell(proof, row, 1).allowed).toBe(false);
    }
    for (const row of [1, 2, 3]) {
      expect(canHideCell(proof, row, 0)).toEqual({
        allowed: false,
        reason: GROUP_NOT_IN_BOTH_COLUMNS_REASON,
      });
      expect(canHideCell(proof, row, 1)).toEqual({
        allowed: false,
        reason: GROUP_NOT_IN_BOTH_COLUMNS_REASON,
      });
    }
  });

  test("canHideCell allows a number only when every group of its column that holds the row exists in both columns with the same members and total", () => {
    // Same groups in both columns: allowed for members and for the total.
    const same = proveColumns([7, 5, 20, 32], [8, 6, 18, 32]);
    for (let row = 0; row < 4; row += 1) {
      expect(canHideCell(same, row, 0)).toEqual({ allowed: true });
      expect(canHideCell(same, row, 1)).toEqual({ allowed: true });
    }

    // Nested groups: a total that is also a member needs both of its groups in both columns.
    // Left: rows 1-2 -> 3, rows 4-5 -> 6, rows 3 and 6 -> 7.
    // Right: the same two small groups, but no grand total group (row 7 is not 3 + 6).
    const nestedLeft = [10, 20, 30, 5, 6, 11, 41];
    const nestedRightFull = [1, 2, 3, 4, 5, 9, 12];
    const nestedRightBroken = [1, 2, 3, 4, 5, 9, 99];
    const full = proveColumns(nestedLeft, nestedRightFull);
    const shape = (groups: ReturnType<typeof findGroups>) =>
      toOneBased(groups).map(({ members, total }) => ({ members, total }));
    expect(shape(full.right.groups)).toEqual(shape(full.left.groups));
    for (let row = 0; row < 7; row += 1) {
      expect(canHideCell(full, row, 0)).toEqual({ allowed: true });
      expect(canHideCell(full, row, 1)).toEqual({ allowed: true });
    }

    const broken = proveColumns(nestedLeft, nestedRightBroken);
    // Row 3 on the left is a member of the grand total group, which the right column lacks.
    expect(canHideCell(broken, 2, 0)).toEqual({
      allowed: false,
      reason: GROUP_NOT_IN_BOTH_COLUMNS_REASON,
    });
    // Row 1 on the left sits only in the small group, and both columns have that group.
    expect(canHideCell(broken, 0, 0)).toEqual({ allowed: true });
    expect(canHideCell(broken, 0, 1)).toEqual({ allowed: true });
  });

  test("D7 replay: with the SEC's own values as a perfect reading, every number canHideCell allows is rebuilt to its true value", () => {
    // Once without the rounding rule, as H1 built it, and once with it, as the page runs.
    for (const withRounding of [false, true]) {
      const replay = replaySavedStatements(withRounding);

      expect(replay.files).toBeGreaterThan(0);
      expect(replay.allowed).toBeGreaterThan(0);
      // Every allowed number is rebuilt, and rebuilt to the SEC's value.
      expect(replay.wrongOrNotRebuilt).toEqual([]);
      expect(replay.rebuiltRight).toBe(replay.allowed);
      expect(replay.allowed + replay.refused).toBe(replay.cells);
      // The guard is not idle: some numbers that proved by adding alone are now refused,
      // and without the refusal at least one of them would be rebuilt to a wrong value.
      expect(replay.refusedAfterProvenByAdding).toBeGreaterThan(0);
      expect(replay.wrongIfNotRefused).toBeGreaterThan(0);
    }
  });

  test("H3 replay: no number in a rounding group can be hidden or changed, and each is refused with the rounding reason", () => {
    const withoutRounding = replaySavedStatements(false);
    expect(withoutRounding.withinRoundingCells).toBe(0);

    const replay = replaySavedStatements(true);
    expect(replay.withinRoundingCells).toBeGreaterThan(0);
    expect(replay.withinRoundingAllowed).toEqual([]);
    expect(replay.withinRoundingRefusedWithReason).toBe(replay.withinRoundingCells);
  });

  test("D7 replay: adding 1 to the second digit of every allowed number is caught by an earlier group that holds that number", () => {
    for (const withRounding of [false, true]) {
      const replay = replaySavedStatements(withRounding);

      expect(replay.changed).toBeGreaterThan(0);
      expect(replay.changeNotCaught).toEqual([]);
      expect(replay.changeCaught).toBe(replay.changed);
      // A change never names a group that does not hold the changed number.
      expect(replay.changeNamedForeignGroup).toEqual([]);
      // Every mark in the changed column holds the changed number or was there before,
      // and the other column keeps the marks it had.
      expect(replay.changeMarkedNewForeignGroup).toEqual([]);
      expect(replay.changeMovedOtherColumn).toEqual([]);
      // The rounding groups of the changed column stay as they were.
      expect(replay.changeMovedRoundingGroups).toEqual([]);
      // Numbers with a single digit have no second digit, so they are counted apart.
      expect(replay.changed + replay.noSecondDigit).toBe(replay.allowed);
    }
  });

  test("a change is judged with the groups that held before it: only an earlier group that holds the changed number and now fails is named, with its gap", () => {
    const before = proveColumns(LEFT_C11, RIGHT_C11);
    const afterLeft = [...LEFT_C11];
    afterLeft[4] = 15541;

    const outcome = proveColumnsWithChange(before, afterLeft, RIGHT_C11, {
      rowIndex: 4,
      colIndex: 0,
    });

    expect(outcome.caught).toBe(true);
    expect(outcome.uncaughtMessage).toBeNull();
    expect(outcome.caughtMismatches).toEqual([
      {
        memberIndices: [0, 1, 2, 3, 4, 5],
        totalIndex: 6,
        computedSum: 174857,
        printedTotal: 173857,
        gap: 1000,
        diff: 1000,
      },
    ]);
    expect(outcome.proof.left.cellStatuses).toEqual(
      new Array(7).fill("mismatch"),
    );
    expect(outcome.proof.right.mismatches).toEqual([]);
    expect(outcome.proof.right.cellStatuses).toEqual(
      new Array(7).fill("proven"),
    );
  });

  test("a change to a line in one small group names only that group, and not the grand total group that does not hold the line", () => {
    // Left: rows 1-2 -> 3, rows 4-5 -> 6, rows 3 and 6 -> 7. Same shape on the right.
    const left = [10, 20, 30, 5, 6, 11, 41];
    const right = [1, 2, 3, 4, 5, 9, 12];
    const before = proveColumns(left, right);
    const afterLeft = [...left];
    afterLeft[0] = 11;

    const outcome = proveColumnsWithChange(before, afterLeft, right, {
      rowIndex: 0,
      colIndex: 0,
    });

    // Row 1 sits in rows 1-2 -> 3 only. The grand total group holds rows 3 and 6, so it is not named.
    expect(outcome.caught).toBe(true);
    expect(outcome.caughtMismatches).toHaveLength(1);
    expect(outcome.caughtMismatches[0]).toMatchObject({
      memberIndices: [0, 1],
      totalIndex: 2,
      computedSum: 31,
      printedTotal: 30,
      gap: 1,
    });
  });

  test("a change to a number that is the total of one group and a line of another names both groups", () => {
    const left = [10, 20, 30, 5, 6, 11, 41];
    const right = [1, 2, 3, 4, 5, 9, 12];
    const before = proveColumns(left, right);
    const afterLeft = [...left];
    afterLeft[2] = 40;

    const outcome = proveColumnsWithChange(before, afterLeft, right, {
      rowIndex: 2,
      colIndex: 0,
    });

    // Row 3 is the total of rows 1-2 and a line of the grand total group (rows 3 and 6 -> 7).
    expect(outcome.caughtMismatches.map((m) => m.totalIndex).sort()).toEqual([
      2, 6,
    ]);
    expect(outcome.caughtMismatches.find((m) => m.totalIndex === 6)).toMatchObject({
      computedSum: 51,
      printedTotal: 41,
      gap: 10,
    });
    // The small group on rows 4-5 does not hold row 3, so it is not named.
    expect(outcome.caughtMismatches.some((m) => m.totalIndex === 5)).toBe(false);
  });

  test("a change that leaves every earlier group adding up says the page could not catch it and names no group", () => {
    // Row 1 (20) sits outside every total in C7, so changing it breaks no group.
    const column = [20, 10, 10, 20];
    const before = proveColumns(column, column);
    const afterLeft = [21, 10, 10, 20];

    const outcome = proveColumnsWithChange(before, afterLeft, column, {
      rowIndex: 0,
      colIndex: 0,
    });

    expect(outcome.caught).toBe(false);
    expect(outcome.caughtMismatches).toEqual([]);
    expect(outcome.uncaughtMessage).toBe("The page could not catch this change.");
    expect(CHANGE_NOT_CAUGHT_MESSAGE).toBe(
      "The page could not catch this change.",
    );
  });

  test("a mark that was on the changed column before the change stays after it, and is not named as the answer", () => {
    // Left rows 4 to 6 do not add up (5 + 6 is not 12) while the right column has that group.
    const left = [10, 20, 30, 5, 6, 12];
    const right = [10, 20, 30, 5, 6, 11];
    const before = proveColumns(left, right);
    expect(before.left.cellStatuses.slice(3)).toEqual([
      "mismatch",
      "mismatch",
      "mismatch",
    ]);
    const afterLeft = [11, 20, 30, 5, 6, 12];

    const outcome = proveColumnsWithChange(before, afterLeft, right, {
      rowIndex: 0,
      colIndex: 0,
    });

    expect(outcome.caughtMismatches.map((m) => m.totalIndex)).toEqual([2]);
    expect(outcome.proof.left.cellStatuses).toEqual(
      new Array(6).fill("mismatch"),
    );
  });

  test("a group that does not hold the changed number is never named, even when the new reading breaks it", () => {
    // Rows 1-2 -> 3 and rows 4-5 -> 6 are two separate groups in the left column.
    const left = [10, 20, 30, 5, 6, 11];
    const right = [1, 2, 3, 4, 5, 9];
    const before = proveColumns(left, right);
    // The judge changes row 1. The new reading also misreads row 4, which breaks the other group.
    const afterLeft = [11, 20, 30, 7, 6, 11];

    const outcome = proveColumnsWithChange(before, afterLeft, right, {
      rowIndex: 0,
      colIndex: 0,
    });

    expect(outcome.caughtMismatches.map((m) => m.totalIndex)).toEqual([2]);
    for (const mismatch of outcome.caughtMismatches) {
      expect(
        mismatch.totalIndex === 0 || mismatch.memberIndices.includes(0),
      ).toBe(true);
    }
  });

  test("parseChangedNumberInput refuses more than 15 digits so no digit is silently lost (QA)", () => {
    expect(parseChangedNumberInput("1".repeat(40))).toEqual({
      ok: false,
      error: "Enter a number with at most 15 digits.",
    });
    expect(parseChangedNumberInput("1234567890123456")).toEqual({
      ok: false,
      error: "Enter a number with at most 15 digits.",
    });
    const fifteen = parseChangedNumberInput("123,456,789,012,345");
    expect(fifteen.ok).toBe(true);
    if (fifteen.ok) expect(fifteen.number).toBe(123456789012345);
  });

  test("parseChangedNumberInput accepts valid numbers and refuses non-numbers with a plain message", () => {
    expect(parseChangedNumberInput("15541")).toEqual({
      ok: true,
      number: 15541,
      formatted: "15,541",
    });
    expect(parseChangedNumberInput("15,541")).toEqual({
      ok: true,
      number: 15541,
      formatted: "15,541",
    });
    expect(parseChangedNumberInput("(1,234)")).toEqual({
      ok: true,
      number: -1234,
      formatted: "(1,234)",
    });
    expect(parseChangedNumberInput("-500")).toEqual({
      ok: true,
      number: -500,
      formatted: "(500)",
    });
    expect(parseChangedNumberInput("0")).toEqual({
      ok: true,
      number: 0,
      formatted: "0",
    });

    for (const bad of ["", "   ", "abc", "15,541abc", "--", "NaN", "1,2,3"]) {
      const res = parseChangedNumberInput(bad);
      expect(res.ok).toBe(false);
    }
  });
});

describe("Within rounding (cases C16 to C18 of docs/test-cases.md)", () => {
  const MILLIONS: ProveColumnsOptions = { unitLine: "USD ($) $ in Millions" };
  /** A right column with no group, so only the left column's flagged total can be judged. */
  const NO_GROUP = [1, 5, 9, 99];
  const FLAGGED_LAST = [false, false, false, true];
  /** C11's column, and C14's right column, in which row 2 was misread. */
  const LEFT_C11_VALUES = [36305, 20417, 43817, 39896, 14541, 18881, 173857];
  const RIGHT_C14_VALUES = [35934, 18768, 39777, 33180, 5718, 14585, 147957];

  test("unitLineAllowsRounding needs the word thousand, million or billion, in any case", () => {
    for (const unitLine of [
      "USD ($) $ in Millions",
      "In Thousands, unless otherwise specified",
      "$ in billions",
      "shares in Millions, $ in Millions",
      "MILLION",
    ]) {
      expect(unitLineAllowsRounding(unitLine)).toBe(true);
    }
    for (const unitLine of ["USD ($)", "", "   ", "statement-apple.png", null, undefined]) {
      expect(unitLineAllowsRounding(unitLine)).toBe(false);
    }
  });

  test("the allowed gap is half the rows, rounded up, at most 3", () => {
    expect([2, 3, 4, 5, 6, 7, 8, 20].map(roundingAllowedSteps)).toEqual([
      1, 2, 2, 3, 3, 3, 3, 3,
    ]);
  });

  test("C16: 100, 200, 301 and a flagged total of 600 in millions give a rounding group, off by 1", () => {
    const proof = proveColumns([100, 200, 301, 600], NO_GROUP, {
      ...MILLIONS,
      totalFlags: FLAGGED_LAST,
    });

    // The exact rule found nothing, and nothing is marked as not adding up.
    expect(proof.left.groups).toEqual([]);
    expect(proof.left.mismatches).toEqual([]);
    expect(proof.left.roundingGroups).toEqual([
      {
        memberIndices: [0, 1, 2],
        totalIndex: 3,
        computedSum: 601,
        printedTotal: 600,
        gap: 1,
        diff: 1,
        allowedGap: 2,
      },
    ]);
    // All four numbers are "within rounding": no tick, nothing red.
    expect(proof.left.cellStatuses).toEqual(new Array(4).fill("within_rounding"));
    expect(proof.right.cellStatuses).toEqual(new Array(4).fill("not_proven"));
    expect(proof.counts).toEqual({
      proven: 0,
      withinRounding: 4,
      needYourEye: 0,
      notProven: 4,
      total: 8,
    });
  });

  test("C16: the same lines under a total that adds up exactly in the other column are within rounding too, with no flag needed", () => {
    const proof = proveColumns([100, 200, 301, 600], [10, 25, 40, 75], MILLIONS);

    expect(proof.right.groups).toHaveLength(1);
    expect(proof.left.mismatches).toEqual([]);
    expect(proof.left.roundingGroups).toHaveLength(1);
    expect(proof.left.roundingGroups[0]).toMatchObject({
      memberIndices: [0, 1, 2],
      totalIndex: 3,
      computedSum: 601,
      printedTotal: 600,
      gap: 1,
    });
    expect(proof.left.cellStatuses).toEqual(new Array(4).fill("within_rounding"));
    expect(proof.right.cellStatuses).toEqual(new Array(4).fill("proven"));
    expect(proof.counts.proven).toBe(4);
    expect(proof.counts.withinRounding).toBe(4);
  });

  test("C17: the same values in single dollars, or with no unit line, give no rounding group", () => {
    for (const unitLine of ["USD ($)", "", null, undefined]) {
      const flagged = proveColumns([100, 200, 301, 600], NO_GROUP, {
        unitLine,
        totalFlags: FLAGGED_LAST,
      });
      expect(flagged.left.roundingGroups).toEqual([]);
      expect(flagged.left.cellStatuses).toEqual(new Array(4).fill("not_proven"));
      expect(flagged.counts.withinRounding).toBe(0);

      // Where the other column adds up exactly, the gap is marked as before.
      const marked = proveColumns([100, 200, 301, 600], [10, 25, 40, 75], { unitLine });
      expect(marked.left.roundingGroups).toEqual([]);
      expect(marked.left.mismatches).toHaveLength(1);
      expect(marked.left.mismatches[0]).toMatchObject({ gap: 1, totalIndex: 3 });
      expect(marked.left.cellStatuses).toEqual(new Array(4).fill("mismatch"));
    }
  });

  test("C18: a gap of 4 on three rows, or of 2,518 on two rows, gives no rounding group and is marked as today", () => {
    // A gap of 4 on three rows: more than the allowed 2.
    const four = proveColumns([100, 200, 304, 600], [10, 25, 40, 75], MILLIONS);
    expect(four.left.roundingGroups).toEqual([]);
    expect(four.left.mismatches).toHaveLength(1);
    expect(four.left.mismatches[0]).toMatchObject({ gap: 4, memberIndices: [0, 1, 2] });
    expect(four.left.cellStatuses).toEqual(new Array(4).fill("mismatch"));

    // Flagged, but with no group in the other column: no rounding group and no mark.
    const flaggedFour = proveColumns([100, 200, 304, 600], NO_GROUP, {
      ...MILLIONS,
      totalFlags: FLAGGED_LAST,
    });
    expect(flaggedFour.left.roundingGroups).toEqual([]);
    expect(flaggedFour.left.mismatches).toEqual([]);
    expect(flaggedFour.left.cellStatuses).toEqual(new Array(4).fill("not_proven"));

    // Qualcomm's kind of gap: 2,518 on two rows.
    const qualcomm = proveColumns([3000, 9000, 14518], [10, 20, 30], MILLIONS);
    expect(qualcomm.left.roundingGroups).toEqual([]);
    expect(qualcomm.left.mismatches).toHaveLength(1);
    expect(qualcomm.left.mismatches[0]).toMatchObject({ gap: 2518, totalIndex: 2 });

    // Seven rows allow at most 3: a gap of 3 is within rounding, a gap of 4 is not.
    const seven = (miss: number) =>
      proveColumns([1, 1, 1, 1, 1, 1, 1, 7 + miss], [2, 2, 2, 2, 2, 2, 2, 14], MILLIONS);
    expect(seven(3).left.roundingGroups).toHaveLength(1);
    expect(seven(3).left.roundingGroups[0]).toMatchObject({ gap: 3, allowedGap: 3 });
    expect(seven(4).left.roundingGroups).toEqual([]);
    expect(seven(4).left.mismatches[0]).toMatchObject({ gap: 4 });
  });

  test("the gap counts in steps of the smallest unit printed in the column", () => {
    // One decimal place: a step is 0.1, so 0.1 is one step and the three rows allow two.
    const oneStep = proveColumns([22, 34.6, 5.8, 62.5], NO_GROUP, {
      ...MILLIONS,
      totalFlags: FLAGGED_LAST,
    });
    expect(oneStep.left.roundingGroups).toHaveLength(1);
    expect(oneStep.left.roundingGroups[0]).toMatchObject({
      gap: 0.1,
      allowedGap: 0.2,
      computedSum: 62.4,
      printedTotal: 62.5,
    });

    // The same miss of 1 is ten steps in a column with a decimal place.
    const tenSteps = proveColumns([22, 34.6, 5.8, 63.4], NO_GROUP, {
      ...MILLIONS,
      totalFlags: FLAGGED_LAST,
    });
    expect(tenSteps.left.roundingGroups).toEqual([]);

    // Whole numbers: a step is 1.
    const whole = proveColumns([22, 35, 6, 64], NO_GROUP, {
      ...MILLIONS,
      totalFlags: FLAGGED_LAST,
    });
    expect(whole.left.roundingGroups[0]).toMatchObject({ gap: 1, allowedGap: 2 });
  });

  test("the exact rule runs first and is not changed: an exact group is never a rounding group", () => {
    const withUnit = proveColumns(LEFT_C11_VALUES, RIGHT_C14_VALUES, {
      ...MILLIONS,
      totalFlags: [false, false, false, false, false, false, true],
    });
    const without = proveColumns(LEFT_C11_VALUES, RIGHT_C14_VALUES);

    expect(withUnit.left.groups).toEqual(without.left.groups);
    expect(withUnit.right.groups).toEqual(without.right.groups);
    expect(withUnit.left.roundingGroups).toEqual([]);
    expect(withUnit.left.cellStatuses).toEqual(without.left.cellStatuses);
    // C14's right column misses by 5 on six rows, which is more than the allowed 3, so it stays marked.
    expect(withUnit.right.mismatches).toEqual(without.right.mismatches);
    expect(withUnit.right.roundingGroups).toEqual([]);
  });

  test("a number in a rounding group cannot be hidden or changed, even an exact subtotal that sits inside one", () => {
    // Left: rows 1 and 2 add exactly to row 3. Row 3 and row 4 add to 130, and row 5 says 131.
    // Right: only rows 1 to 3 add up.
    const left = [10, 20, 30, 100, 131];
    const right = [1, 2, 3, 4, 50];
    const proof = proveColumns(left, right, {
      ...MILLIONS,
      totalFlags: [false, false, false, false, true],
    });

    expect(toOneBased(proof.left.groups)).toEqual([{ members: [1, 2], total: 3, sum: 30 }]);
    expect(proof.left.roundingGroups).toHaveLength(1);
    expect(proof.left.roundingGroups[0]).toMatchObject({
      memberIndices: [2, 3],
      totalIndex: 4,
      gap: 1,
    });
    // Row 3 re-adds exactly, but it sits inside the rounding group: no tick.
    expect(proof.left.cellStatuses).toEqual([
      "proven",
      "proven",
      "within_rounding",
      "within_rounding",
      "within_rounding",
    ]);

    for (const row of [2, 3, 4]) {
      expect(canHideCell(proof, row, 0)).toEqual({
        allowed: false,
        reason: ROUNDING_GROUP_REASON,
      });
    }
    // The lines of the exact group that sit in no rounding group are still allowed,
    // and a hidden one is rebuilt to its true value.
    expect(canHideCell(proof, 0, 0)).toEqual({ allowed: true });
    const rebuilt = rebuildHiddenCell(
      left.map((value, row) => (row === 0 ? null : value)),
      right,
      { rowIndex: 0, colIndex: 0 },
    );
    expect(rebuilt.status).toBe("rebuilt");
    if (rebuilt.status === "rebuilt") expect(rebuilt.value).toBe(10);
  });

  test("a change is still judged exactly: a miss of 1 stays a mark, and the rounding groups stay within rounding", () => {
    // Rows 1 and 2 add to row 3, rows 3 and 4 add to 130 against a printed 131 (within rounding),
    // and rows 6 and 7 add to row 8.
    const left = [10, 20, 30, 100, 131, 5, 6, 11];
    const right = [10, 20, 30, 100, 130, 5, 6, 11];
    const options: ProveColumnsOptions = {
      ...MILLIONS,
      totalFlags: [false, false, false, false, true, false, false, true],
    };
    const before = proveColumns(left, right, options);
    expect(before.left.mismatches).toEqual([]);
    expect(before.left.roundingGroups).toHaveLength(1);
    expect(before.counts.withinRounding).toBe(3);

    // Row 6 goes from 5 to 6: the group of rows 6 to 8 misses by 1, and that is a mark, not rounding.
    expect(canHideCell(before, 5, 0)).toEqual({ allowed: true });
    const changedLines = [...left];
    changedLines[5] = 6;
    const outcome = proveColumnsWithChange(
      before,
      changedLines,
      right,
      { rowIndex: 5, colIndex: 0 },
      options,
    );
    expect(outcome.caught).toBe(true);
    expect(outcome.caughtMismatches).toHaveLength(1);
    expect(outcome.caughtMismatches[0]).toMatchObject({
      memberIndices: [5, 6],
      totalIndex: 7,
      gap: 1,
    });
    expect(outcome.proof.left.mismatches).toHaveLength(1);
    expect(outcome.proof.left.roundingGroups).toEqual(before.left.roundingGroups);
    expect(outcome.proof.left.cellStatuses.slice(5)).toEqual(["mismatch", "mismatch", "mismatch"]);
    expect(outcome.proof.left.cellStatuses.slice(2, 5)).toEqual(new Array(3).fill("within_rounding"));
    expect(outcome.proof.right).toEqual(before.right);

    // Row 1 goes from 10 to 11 in the first exact group, which misses by 1 as well: still a mark.
    const changedFirst = [...left];
    changedFirst[0] = 11;
    const firstOutcome = proveColumnsWithChange(
      before,
      changedFirst,
      right,
      { rowIndex: 0, colIndex: 0 },
      options,
    );
    expect(firstOutcome.caught).toBe(true);
    expect(firstOutcome.caughtMismatches[0]).toMatchObject({ memberIndices: [0, 1], totalIndex: 2, gap: 1 });
    expect(firstOutcome.proof.left.roundingGroups).toHaveLength(1);
    expect(firstOutcome.proof.left.roundingGroups[0]).toMatchObject({ totalIndex: 4 });

    // A change in the other column leaves this column's rounding group untouched.
    const changedRight = [...right];
    changedRight[5] = 6;
    const rightOutcome = proveColumnsWithChange(
      before,
      left,
      changedRight,
      { rowIndex: 5, colIndex: 1 },
      options,
    );
    expect(rightOutcome.proof.left.roundingGroups).toEqual(before.left.roundingGroups);
    expect(rightOutcome.proof.left.mismatches).toEqual([]);
  });

  test("a hidden number that is rebuilt leaves the rounding groups within rounding", () => {
    const left = [10, 20, 30, 100, 131, 5, 6, 11];
    const right = [10, 20, 30, 100, 130, 5, 6, 11];
    const options: ProveColumnsOptions = {
      ...MILLIONS,
      totalFlags: [false, false, false, false, true, false, false, true],
    };
    const hidden = left.map((value, row): number | null => (row === 5 ? null : value));
    const outcome = proveColumnsWithHidden(hidden, right, { rowIndex: 5, colIndex: 0 }, options);

    expect(outcome.rebuild.status).toBe("rebuilt");
    expect(outcome.proof.left.mismatches).toEqual([]);
    expect(outcome.proof.left.roundingGroups).toHaveLength(1);
    expect(outcome.proof.left.cellStatuses.slice(2, 5)).toEqual(new Array(3).fill("within_rounding"));
  });

  test("H3 replay: with the SEC's values as a perfect reading, only a statement whose gap is larger than its allowed gap still shows a group that does not add up", () => {
    const statements = loadSavedStatements();
    const stepOf = (column: ReadonlyArray<number | null>): number => {
      let places = 0;
      for (const value of column) {
        if (value === null) continue;
        while (places < 6 && Math.abs(value * 10 ** places - Math.round(value * 10 ** places)) > 1e-6) {
          places += 1;
        }
      }
      return 10 ** -places;
    };

    const stillMarked: string[] = [];
    const markedWithoutRounding = new Set<string>();
    const withinRoundingByCompany = new Map<string, number>();
    let withinRoundingTotal = 0;

    for (const statement of statements) {
      const rows = statement.rows.filter((row) => row.kind === "number");
      const columns: [Array<number | null>, Array<number | null>] = [
        rows.map((row) => (row.kind === "number" ? row.numbers[0] : null)),
        rows.map((row) => (row.kind === "number" ? row.numbers[1] : null)),
      ];
      const unreadMask = rows.map(() => [false, false] as const);
      const plain = proveColumns(columns[0], columns[1], { unreadMask });
      const proof = proveColumns(columns[0], columns[1], {
        unreadMask,
        unitLine: statement.unitLine,
        totalFlags: rows.map((row) => row.kind === "number" && row.isTotal),
      });

      if (plain.left.mismatches.length + plain.right.mismatches.length > 0) {
        markedWithoutRounding.add(statement.companyName);
      }

      // The exact rule is not changed by the rounding rule.
      expect(proof.left.groups).toEqual(plain.left.groups);
      expect(proof.right.groups).toEqual(plain.right.groups);

      for (const [column, columnProof] of [
        [columns[0], proof.left],
        [columns[1], proof.right],
      ] as const) {
        const step = stepOf(column);
        const exactTotals = new Set(columnProof.groups.map((group) => group.totalIndex));
        const markedTotals = new Set(columnProof.mismatches.map((mark) => mark.totalIndex));

        for (const mark of columnProof.mismatches) {
          // What is still marked misses by more than its allowed gap.
          expect(mark.gap).toBeGreaterThan(
            roundingAllowedSteps(mark.memberIndices.length) * step + 1e-6,
          );
          stillMarked.push(`${statement.companyName}: ${rows[mark.totalIndex].label}, off by ${mark.gap}`);
        }
        for (const group of columnProof.roundingGroups) {
          const steps = Math.round(group.gap / step);
          expect(steps).toBeGreaterThanOrEqual(1);
          expect(steps).toBeLessThanOrEqual(roundingAllowedSteps(group.memberIndices.length));
          // A rounding group is never an exact group and never a mark.
          expect(exactTotals.has(group.totalIndex)).toBe(false);
          expect(markedTotals.has(group.totalIndex)).toBe(false);
        }
      }

      if (proof.counts.withinRounding > 0) {
        withinRoundingByCompany.set(statement.companyName, proof.counts.withinRounding);
        withinRoundingTotal += proof.counts.withinRounding;
      }
    }

    const companiesWithinRounding = [...withinRoundingByCompany.keys()].sort();
    console.info(
      [
        `H3 replay over ${statements.length} saved statements:`,
        `statements that still show a group marked "does not add up": ${new Set(stillMarked.map((line) => line.split(":")[0])).size} (${stillMarked.join("; ")})`,
        `numbers within rounding: ${withinRoundingTotal} in ${companiesWithinRounding.length} companies`,
        ...companiesWithinRounding.map(
          (name) => `  ${name}: ${withinRoundingByCompany.get(name)}`,
        ),
      ].join("\n"),
    );

    // Qualcomm's total stockholders' equity misses by 2,518 on two rows: not rounding.
    expect(stillMarked).toHaveLength(1);
    expect(stillMarked[0]).toMatch(/^QUALCOMM INC\/DE: .*off by 2518$/);

    // The eight companies that showed a red mark for a rounded total now show none of it as red.
    const clearedByRounding = [
      "GE Vernova Inc.",
      "GENERAL ELECTRIC CO",
      "INTERNATIONAL BUSINESS MACHINES CORP",
      "MCDONALDS CORP",
      "PFIZER INC",
      "PROCTER & GAMBLE Co",
      "GILEAD SCIENCES, INC.",
      "THERMO FISHER SCIENTIFIC INC.",
    ];
    for (const name of clearedByRounding) {
      expect(markedWithoutRounding.has(name)).toBe(true);
      expect(withinRoundingByCompany.has(name)).toBe(true);
    }
    expect(markedWithoutRounding.has("QUALCOMM INC/DE")).toBe(true);

    // Every company with a rounding group, as observed on this data.
    expect(companiesWithinRounding).toEqual(
      [
        ...clearedByRounding,
        "CARVANA CO.",
        "NEXTERA ENERGY INC",
      ].sort(),
    );
    expect(withinRoundingTotal).toBeGreaterThan(0);
  });
});
