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
 */
function replaySavedStatements() {
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
    changed: 0,
    noSecondDigit: 0,
    changeCaught: 0,
    changeNotCaught: [] as string[],
    changeNamedForeignGroup: [] as string[],
    changeMarkedNewForeignGroup: [] as string[],
    changeMovedOtherColumn: [] as string[],
  };

  for (const statement of statements) {
    const rows = statement.rows.filter((row) => row.kind === "number");
    const columns: [Array<number | null>, Array<number | null>] = [
      rows.map((row) => (row.kind === "number" ? row.numbers[0] : null)),
      rows.map((row) => (row.kind === "number" ? row.numbers[1] : null)),
    ];
    const unreadMask = rows.map(() => [false, false] as const);
    const proof = proveColumns(columns[0], columns[1], { unreadMask });

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
          { unreadMask },
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
          JSON.stringify(baseOtherColumn.mismatches)
        ) {
          result.changeMovedOtherColumn.push(where);
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
    const replay = replaySavedStatements();

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
  });

  test("D7 replay: adding 1 to the second digit of every allowed number is caught by an earlier group that holds that number", () => {
    const replay = replaySavedStatements();

    expect(replay.changed).toBeGreaterThan(0);
    expect(replay.changeNotCaught).toEqual([]);
    expect(replay.changeCaught).toBe(replay.changed);
    // A change never names a group that does not hold the changed number.
    expect(replay.changeNamedForeignGroup).toEqual([]);
    // Every mark in the changed column holds the changed number or was there before,
    // and the other column keeps the marks it had.
    expect(replay.changeMarkedNewForeignGroup).toEqual([]);
    expect(replay.changeMovedOtherColumn).toEqual([]);
    // Numbers with a single digit have no second digit, so they are counted apart.
    expect(replay.changed + replay.noSecondDigit).toBe(replay.allowed);
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
