import { expect, test } from "vitest";
import {
  countDisputedCells,
  mergeReadings,
  normalizeReadLabel,
  pairReadingsByLabel,
} from "@/lib/merge-readings";
import { parseReadingReply } from "@/lib/reading";

const read = (text: string) => parseReadingReply(text);

test("normalizes a label to lowercase letters and digits", () => {
  expect(normalizeReadLabel("  Total Assets:  ")).toBe("totalassets");
  expect(normalizeReadLabel("Notes (Note 4)")).toBe("notesnote4");
});

test("pairs rows by label in order and looks at most 3 rows ahead", () => {
  const first = read("Cash | 1 | 2\nTotal assets | 3 | 4\nDebt | 5 | 6");
  const near = read(
    "cash: | 1 | 2\nExtra a | 0 | 0\nExtra b | 0 | 0\nExtra c | 0 | 0\nTOTAL ASSETS | 3 | 4\nDebt | 5 | 6",
  );
  expect(pairReadingsByLabel(first, near).map((r) => r?.label)).toEqual([
    "cash:",
    "TOTAL ASSETS",
    "Debt",
  ]);

  const far = read(
    "Cash | 1 | 2\nExtra a | 0 | 0\nExtra b | 0 | 0\nExtra c | 0 | 0\nExtra d | 0 | 0\nTotal assets | 3 | 4",
  );
  // "Total assets" is 5 rows past the next unused row: out of reach.
  expect(pairReadingsByLabel(first, far).map((r) => r?.label ?? null)).toEqual([
    "Cash",
    null,
    null,
  ]);
});

test("a number both readers agree on is kept", () => {
  const first = read("Cash | $ 1,250 | 900\nTotal | 1,250 | 900");
  const second = read("Cash | 1250 | 900\nTotal | $1,250 | 900");
  const merged = mergeReadings(first, second);
  expect(merged.disputedCount).toBe(0);
  expect(merged.rows).toEqual(first);
});

test("numbers that differ become NOT READ and keep both raw texts", () => {
  const first = read("Cash | 3,810 | 900\nTotal | 3,810 | 900");
  const second = read("Cash | 3,816 | 900\nTotal | 3,810 | 900");
  const merged = mergeReadings(first, second);
  expect(merged.disputedCount).toBe(1);
  expect(merged.rows[0].cells[0]).toEqual({
    raw: "",
    number: null,
    hidden: false,
    disputed: { first: "3,810", second: "3,816" },
  });
  expect(merged.rows[0].cells[1].number).toBe(900);
  expect(merged.rows[1].cells[0].number).toBe(3810);
  expect(countDisputedCells(merged.rows)).toBe(1);
});

test("a number with no matching row or no value in the second reading is NOT READ", () => {
  const first = read("Cash | 10 | 20\nDebt | 30 | 40\nTotal | 40 | 60");
  const second = read("Cash | 10 |\nTotal | 40 | 60");
  const merged = mergeReadings(first, second);
  // Cash right column: the second reader wrote no value.
  expect(merged.rows[0].cells[1].disputed).toEqual({ first: "20", second: "" });
  // Debt: the second reader has no such row, so both numbers are disputed.
  expect(merged.rows[1].cells[0].disputed).toEqual({ first: "30", second: "" });
  expect(merged.rows[1].cells[1].disputed).toEqual({ first: "40", second: "" });
  expect(merged.rows[1].cells[0].number).toBeNull();
  expect(merged.disputedCount).toBe(3);
  expect(merged.rows[2].cells[0].number).toBe(40);
});

test("a cell that is empty in both readings stays empty", () => {
  const first = read("Cash | 10 |\nTotal | 10 |");
  const second = read("Cash | 10 |\nTotal | 10 |");
  const merged = mergeReadings(first, second);
  expect(merged.disputedCount).toBe(0);
  expect(merged.rows[0].cells[1]).toEqual({ raw: "", number: null, hidden: false });

  // An empty cell where the second reader has no row at all also stays empty.
  const lone = mergeReadings(read("Cash | 10 |"), []);
  expect(lone.rows[0].cells[1].disputed).toBeUndefined();
  expect(lone.rows[0].cells[0].disputed).toEqual({ first: "10", second: "" });
});

test("a cell one reader left empty and the other read is disputed", () => {
  const merged = mergeReadings(read("Cash | 10 |"), read("Cash | 10 | 7"));
  expect(merged.rows[0].cells[1].disputed).toEqual({ first: "", second: "7" });
});

test("a dash against a blank, or two different dashes, is not a dispute", () => {
  const merged = mergeReadings(
    read("Cash | 10 | —\nDebt | 5 | $ -\nTotal | 15 |"),
    read("Cash | 10 |\nDebt | 5 | –\nTotal | 15 |"),
  );
  expect(merged.disputedCount).toBe(0);
  // A dash row with no pair in the second reading is also kept.
  expect(mergeReadings(read("Cash | 10 | —"), []).rows[0].cells[1].disputed).toBeUndefined();
});
