import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { classifyColumn, findGroups, proveColumns } from "./adding";

/** Helper to convert 0-based groups to 1-based row numbers matching docs/test-cases.md. */
function toOneBased(groups: ReturnType<typeof findGroups>) {
  return groups.map((g) => ({
    members: g.memberIndices.map((idx) => idx + 1),
    total: g.totalIndex + 1,
    sum: g.sum,
  }));
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
