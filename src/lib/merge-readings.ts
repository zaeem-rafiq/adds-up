import type { ReadCell, ReadRow } from "@/lib/reading";

/** How many rows past the next unmatched one the pairing may look for a label. */
export const MAX_PAIRING_LOOKAHEAD = 3;

/** A label reduced to lowercase letters and digits, so "Total  assets:" equals "total assets". */
export function normalizeReadLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Pairs each row of the first reading with a row of the second reading, by label and in
 * order. The search for a row starts at the first second-reading row not yet used and looks
 * at most 3 rows past it. A first row with no match gets null and does not move the search.
 */
export function pairReadingsByLabel(
  first: readonly ReadRow[],
  second: readonly ReadRow[],
): (ReadRow | null)[] {
  const paired: (ReadRow | null)[] = [];
  let cursor = 0;
  for (const row of first) {
    const wanted = normalizeReadLabel(row.label);
    let found = -1;
    const last = Math.min(second.length - 1, cursor + MAX_PAIRING_LOOKAHEAD);
    for (let index = cursor; index <= last; index += 1) {
      if (normalizeReadLabel(second[index].label) === wanted) {
        found = index;
        break;
      }
    }
    if (found === -1) {
      paired.push(null);
    } else {
      paired.push(second[found]);
      cursor = found + 1;
    }
  }
  return paired;
}

/** A cell that holds no number: blank, a dash, or other text. Only number cells can be disputed. */
function holdsNoNumber(cell: ReadCell): boolean {
  return cell.number === null && !cell.hidden;
}

/** True when both readers wrote the same number, or both covered the cell, or neither wrote a number. */
export function cellsAgree(a: ReadCell, b: ReadCell): boolean {
  if (a.hidden || b.hidden) return a.hidden && b.hidden;
  if (a.number === null && b.number === null) return true;
  return a.number !== null && b.number !== null && a.number === b.number;
}

/**
 * Merges two readings of one picture. A cell kept by both readers stays as the first reader
 * read it. Where they differ, or the second reading has no such row or no value, the cell
 * becomes NOT READ (number null) and carries both raw texts in `disputed`. A cell that is
 * empty in both readings stays empty.
 */
export function mergeReadings(
  first: readonly ReadRow[],
  second: readonly ReadRow[],
): { rows: ReadRow[]; disputedCount: number } {
  const paired = pairReadingsByLabel(first, second);
  let disputedCount = 0;

  const rows = first.map((row, rowIndex): ReadRow => {
    const other = paired[rowIndex];
    const merge = (colIndex: 0 | 1): ReadCell => {
      const a = row.cells[colIndex];
      const b = other?.cells[colIndex];
      if (b ? cellsAgree(a, b) : holdsNoNumber(a)) return a;
      disputedCount += 1;
      return {
        raw: "",
        number: null,
        hidden: false,
        disputed: { first: a.raw, second: b?.raw ?? "" },
      };
    };
    return { label: row.label, cells: [merge(0), merge(1)] };
  });

  return { rows, disputedCount };
}

export function countDisputedCells(rows: readonly ReadRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.cells[0].disputed) total += 1;
    if (row.cells[1].disputed) total += 1;
  }
  return total;
}
