export type AddingGroup = {
  /** 0-based indices of the component rows that add up to the total. */
  memberIndices: number[];
  /** 0-based index of the total row. */
  totalIndex: number;
  /** Sum of the member rows (equal to the total row's value). */
  sum: number;
};

export type MismatchedGroup = {
  /** 0-based indices of the component rows from the matching group in the other column. */
  memberIndices: number[];
  /** 0-based index of the total row. */
  totalIndex: number;
  /** Actual sum of the member rows in this column. */
  computedSum: number;
  /** Printed/read value of the total row in this column. */
  printedTotal: number;
  /** Absolute difference between computedSum and printedTotal. */
  gap: number;
  /** Signed difference (computedSum - printedTotal). */
  diff: number;
};

export type CellProofStatus =
  | "proven"
  | "mismatch"
  | "unread"
  | "not_proven"
  | "empty";

export type ColumnProof = {
  groups: AddingGroup[];
  mismatches: MismatchedGroup[];
  cellStatuses: CellProofStatus[];
};

export type TwoColumnProof = {
  left: ColumnProof;
  right: ColumnProof;
  counts: {
    proven: number;
    needYourEye: number;
    notProven: number;
    total: number;
  };
};

export type ProveColumnsOptions = {
  /**
   * Optional per-row [leftUnread, rightUnread] flags.
   * When omitted, any null cell is treated as unread.
   * When provided, a null cell whose flag is false is treated as an empty/dash
   * cell (no number on the statement) rather than an unread number.
   */
  unreadMask?: ReadonlyArray<readonly [boolean, boolean]>;
};

const EPSILON = 1e-6;

function roundClean(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

function groupKey(memberIndices: readonly number[], totalIndex: number): string {
  return `${memberIndices.join(",")}->${totalIndex}`;
}

/**
 * Pure single-column adding rule from docs/plan.md.
 *
 * Walk top to bottom keeping a list of open rows. A row is a total when its
 * value is not zero and equals the sum of the last two or more open rows
 * (nearest rows win). Those rows leave the open list, and the total joins it.
 * An unreadable cell (`null`) stops the search across it.
 */
export function findGroups(column: ReadonlyArray<number | null>): AddingGroup[] {
  const open: Array<{ index: number; value: number }> = [];
  const groups: AddingGroup[] = [];

  for (let i = 0; i < column.length; i += 1) {
    const val = column[i];

    if (val === null || !Number.isFinite(val)) {
      // An unreadable cell stops any backward search from crossing it (C5).
      open.length = 0;
      continue;
    }

    if (!numbersEqual(val, 0) && open.length >= 2) {
      let runningSum = 0;
      let matchedStart = -1;

      for (let k = open.length - 1; k >= 0; k -= 1) {
        runningSum += open[k].value;
        const count = open.length - k;
        if (count >= 2 && numbersEqual(runningSum, val)) {
          matchedStart = k;
          break;
        }
      }

      if (matchedStart !== -1) {
        const memberIndices = open.slice(matchedStart).map((entry) => entry.index);
        groups.push({
          memberIndices,
          totalIndex: i,
          sum: roundClean(val),
        });
        open.length = matchedStart;
        open.push({ index: i, value: val });
        continue;
      }
    }

    open.push({ index: i, value: val });
  }

  return groups;
}

/**
 * Classifies each cell in a single column using the adding rule alone.
 * Numbers inside any group that re-adds are "proven", numbers outside every
 * total are "not_proven", and null cells are "unread".
 */
export function classifyColumn(
  column: ReadonlyArray<number | null>,
  groups: ReadonlyArray<AddingGroup> = findGroups(column),
): CellProofStatus[] {
  const provenSet = new Set<number>();
  for (const group of groups) {
    for (const memberIndex of group.memberIndices) {
      provenSet.add(memberIndex);
    }
    provenSet.add(group.totalIndex);
  }

  return column.map((val, index) => {
    if (val === null || !Number.isFinite(val)) {
      return "unread";
    }
    return provenSet.has(index) ? "proven" : "not_proven";
  });
}

function findCrossColumnMismatches(
  targetColumn: ReadonlyArray<number | null>,
  ownGroups: ReadonlyArray<AddingGroup>,
  otherGroups: ReadonlyArray<AddingGroup>,
): MismatchedGroup[] {
  const ownKeys = new Set(
    ownGroups.map((group) => groupKey(group.memberIndices, group.totalIndex)),
  );
  const mismatches: MismatchedGroup[] = [];

  for (const group of otherGroups) {
    const key = groupKey(group.memberIndices, group.totalIndex);
    if (ownKeys.has(key)) continue;

    if (group.totalIndex >= targetColumn.length) continue;
    const printedTotal = targetColumn[group.totalIndex];
    if (printedTotal === null || printedTotal === undefined || !Number.isFinite(printedTotal)) {
      continue;
    }

    let computedSum = 0;
    let allPresent = true;
    for (const memberIndex of group.memberIndices) {
      const memberValue = targetColumn[memberIndex];
      if (memberValue === null || memberValue === undefined || !Number.isFinite(memberValue)) {
        allPresent = false;
        break;
      }
      computedSum += memberValue;
    }

    if (!allPresent) continue;

    const cleanSum = roundClean(computedSum);
    const cleanTotal = roundClean(printedTotal);
    if (numbersEqual(cleanSum, cleanTotal)) continue;

    const diff = roundClean(cleanSum - cleanTotal);
    mismatches.push({
      memberIndices: [...group.memberIndices],
      totalIndex: group.totalIndex,
      computedSum: cleanSum,
      printedTotal: cleanTotal,
      gap: roundClean(Math.abs(diff)),
      diff,
    });
  }

  return mismatches;
}

function buildColumnProof(
  column: ReadonlyArray<number | null>,
  groups: AddingGroup[],
  mismatches: MismatchedGroup[],
  unreadFlags?: ReadonlyArray<boolean>,
): ColumnProof {
  const provenIndices = new Set<number>();
  for (const group of groups) {
    for (const idx of group.memberIndices) {
      provenIndices.add(idx);
    }
    provenIndices.add(group.totalIndex);
  }

  const mismatchIndices = new Set<number>();
  for (const mismatch of mismatches) {
    for (const idx of mismatch.memberIndices) {
      mismatchIndices.add(idx);
    }
    mismatchIndices.add(mismatch.totalIndex);
  }

  const cellStatuses: CellProofStatus[] = column.map((val, index) => {
    if (val === null || !Number.isFinite(val)) {
      if (unreadFlags && !unreadFlags[index]) {
        return "empty";
      }
      return "unread";
    }
    if (mismatchIndices.has(index)) {
      return "mismatch";
    }
    if (provenIndices.has(index)) {
      return "proven";
    }
    return "not_proven";
  });

  return {
    groups,
    mismatches,
    cellStatuses,
  };
}

/**
 * Applies the adding rule to both columns and cross-checks groups that re-add
 * in one column against the same rows in the other column.
 */
export function proveColumns(
  left: ReadonlyArray<number | null>,
  right: ReadonlyArray<number | null>,
  options?: ProveColumnsOptions,
): TwoColumnProof {
  const leftGroups = findGroups(left);
  const rightGroups = findGroups(right);

  const leftMismatches = findCrossColumnMismatches(left, leftGroups, rightGroups);
  const rightMismatches = findCrossColumnMismatches(right, rightGroups, leftGroups);

  const leftUnreadFlags = options?.unreadMask?.map((pair) => pair[0]);
  const rightUnreadFlags = options?.unreadMask?.map((pair) => pair[1]);

  const leftProof = buildColumnProof(
    left,
    leftGroups,
    leftMismatches,
    leftUnreadFlags,
  );
  const rightProof = buildColumnProof(
    right,
    rightGroups,
    rightMismatches,
    rightUnreadFlags,
  );

  let proven = 0;
  let needYourEye = 0;
  let notProven = 0;

  for (const status of [...leftProof.cellStatuses, ...rightProof.cellStatuses]) {
    if (status === "proven") {
      proven += 1;
    } else if (status === "mismatch" || status === "unread") {
      needYourEye += 1;
    } else if (status === "not_proven") {
      notProven += 1;
    }
  }

  return {
    left: leftProof,
    right: rightProof,
    counts: {
      proven,
      needYourEye,
      notProven,
      total: proven + needYourEye + notProven,
    },
  };
}
