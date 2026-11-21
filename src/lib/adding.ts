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

export type HideCellTarget = {
  /** 0-based index among number rows */
  rowIndex: number;
  /** 0 for left column, 1 for right column */
  colIndex: 0 | 1;
};

export type ChangeCellTarget = HideCellTarget;

export type CanHideResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export const GROUP_NOT_IN_BOTH_COLUMNS_REASON =
  "This number's group does not exist in both columns, so the page cannot rebuild it.";

export const CHANGE_NOT_CAUGHT_MESSAGE =
  "The page could not catch this change.";

export type ChangedProofOutcome = {
  proof: TwoColumnProof;
  caughtMismatches: MismatchedGroup[];
  caught: boolean;
  uncaughtMessage: string | null;
};

export type RebuildWay = {
  kind: "total_minus_others" | "sum_of_members";
  /** 0-based indices of all member rows in the group from the other column */
  memberIndices: number[];
  /** 0-based index of the total row in the group from the other column */
  totalIndex: number;
  /** Rebuilt value for the hidden cell */
  value: number;
  /** Sum of the visible member rows (all members when total is hidden, other members when a member is hidden) */
  otherMembersSum: number;
  /** Printed total value in this column (null when the total itself is hidden) */
  printedTotal: number | null;
};

export type RebuildResult =
  | {
      status: "rebuilt";
      rowIndex: number;
      colIndex: 0 | 1;
      value: number;
      ways: RebuildWay[];
      agreed: true;
    }
  | {
      status: "cannot_rebuild";
      rowIndex: number;
      colIndex: 0 | 1;
      reason: string;
      ways: [];
      agreed: false;
    }
  | {
      status: "conflict";
      rowIndex: number;
      colIndex: 0 | 1;
      reason: string;
      ways: RebuildWay[];
      agreed: false;
    };

export type ChangedNumberInputResult =
  | { ok: true; number: number; formatted: string }
  | { ok: false; error: string };

const EPSILON = 1e-6;

function roundClean(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function numbersEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
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
  const ownTotalIndices = new Set(ownGroups.map((group) => group.totalIndex));
  const mismatches: MismatchedGroup[] = [];

  for (const group of otherGroups) {
    // Do not mark a group as not adding up if its total row already re-adds
    // as the total of a group of its own in this column (C15).
    if (ownTotalIndices.has(group.totalIndex)) continue;

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

function groupsHaveSameStructure(a: AddingGroup, b: AddingGroup): boolean {
  if (a.totalIndex !== b.totalIndex) return false;
  if (a.memberIndices.length !== b.memberIndices.length) return false;
  for (let i = 0; i < a.memberIndices.length; i += 1) {
    if (a.memberIndices[i] !== b.memberIndices[i]) return false;
  }
  return true;
}

function groupContainsRow(group: AddingGroup, rowIndex: number): boolean {
  return (
    group.totalIndex === rowIndex || group.memberIndices.includes(rowIndex)
  );
}

/**
 * Checks whether a cell can be hidden or changed by the judge.
 * A number outside every total cannot be hidden (Section D, Case D5).
 * A proven number is allowed only when every group of its own column that
 * contains the row (as a member or as the total) also exists in the other
 * column's groups with the same member rows and the same total row (Case D7).
 */
export function canHideCell(
  proof: TwoColumnProof,
  rowIndex: number,
  colIndex: 0 | 1,
): CanHideResult {
  const columnProof = colIndex === 0 ? proof.left : proof.right;
  const otherColumnProof = colIndex === 0 ? proof.right : proof.left;
  const status = columnProof.cellStatuses[rowIndex];

  if (status === "proven") {
    const ownGroupsForRow = columnProof.groups.filter((group) =>
      groupContainsRow(group, rowIndex),
    );
    const everyGroupInBothColumns =
      ownGroupsForRow.length > 0 &&
      ownGroupsForRow.every((ownGroup) =>
        otherColumnProof.groups.some((otherGroup) =>
          groupsHaveSameStructure(ownGroup, otherGroup),
        ),
      );

    if (!everyGroupInBothColumns) {
      return {
        allowed: false,
        reason: GROUP_NOT_IN_BOTH_COLUMNS_REASON,
      };
    }

    return { allowed: true };
  }

  if (status === "empty" || status === undefined) {
    return {
      allowed: false,
      reason: "There is no number in this cell to hide.",
    };
  }

  if (status === "mismatch") {
    return {
      allowed: false,
      reason:
        "This number is in a group that does not add up, so it cannot be hidden and rebuilt.",
    };
  }

  return {
    allowed: false,
    reason:
      "This number sits outside every total, so it cannot be hidden or rebuilt from adding.",
  };
}

/**
 * Rebuilds a hidden cell using only the groups found in the OTHER column
 * (Section D of docs/test-cases.md). Never guesses when no matching group
 * exists or when two groups disagree.
 */
export function rebuildHiddenCell(
  left: ReadonlyArray<number | null>,
  right: ReadonlyArray<number | null>,
  hiddenCell: HideCellTarget,
): RebuildResult {
  const { rowIndex, colIndex } = hiddenCell;
  const targetColumn = colIndex === 0 ? left : right;
  const otherColumn = colIndex === 0 ? right : left;

  const otherGroups = findGroups(otherColumn);
  const ways: RebuildWay[] = [];

  for (const group of otherGroups) {
    if (group.totalIndex === rowIndex) {
      // Hidden cell is the total: rebuild as sum of all member rows in targetColumn.
      let sum = 0;
      let allPresent = true;
      for (const memberIdx of group.memberIndices) {
        const val = targetColumn[memberIdx];
        if (val === null || val === undefined || !Number.isFinite(val)) {
          allPresent = false;
          break;
        }
        sum += val;
      }
      if (!allPresent) continue;

      const cleanSum = roundClean(sum);
      ways.push({
        kind: "sum_of_members",
        memberIndices: [...group.memberIndices],
        totalIndex: group.totalIndex,
        value: cleanSum,
        otherMembersSum: cleanSum,
        printedTotal: null,
      });
      continue;
    }

    if (group.memberIndices.includes(rowIndex)) {
      // Hidden cell is a member: rebuild as printed total minus the other member rows.
      const printedTotal = targetColumn[group.totalIndex];
      if (
        printedTotal === null ||
        printedTotal === undefined ||
        !Number.isFinite(printedTotal)
      ) {
        continue;
      }

      let otherSum = 0;
      let allOtherPresent = true;
      for (const memberIdx of group.memberIndices) {
        if (memberIdx === rowIndex) continue;
        const val = targetColumn[memberIdx];
        if (val === null || val === undefined || !Number.isFinite(val)) {
          allOtherPresent = false;
          break;
        }
        otherSum += val;
      }
      if (!allOtherPresent) continue;

      const cleanOtherSum = roundClean(otherSum);
      const cleanTotal = roundClean(printedTotal);
      const rebuilt = roundClean(cleanTotal - cleanOtherSum);
      ways.push({
        kind: "total_minus_others",
        memberIndices: [...group.memberIndices],
        totalIndex: group.totalIndex,
        value: rebuilt,
        otherMembersSum: cleanOtherSum,
        printedTotal: cleanTotal,
      });
    }
  }

  if (ways.length === 0) {
    return {
      status: "cannot_rebuild",
      rowIndex,
      colIndex,
      reason:
        "Cannot rebuild this number because the other column has no group for these rows. Adds Up never guesses.",
      ways: [],
      agreed: false,
    };
  }

  const firstValue = ways[0].value;
  const allAgree = ways.every((way) => numbersEqual(way.value, firstValue));
  if (!allAgree) {
    return {
      status: "conflict",
      rowIndex,
      colIndex,
      reason:
        "Two groups gave different numbers for the hidden cell, so it cannot be rebuilt. Adds Up never guesses.",
      ways,
      agreed: false,
    };
  }

  return {
    status: "rebuilt",
    rowIndex,
    colIndex,
    value: firstValue,
    ways,
    agreed: true,
  };
}

/**
 * Rebuilds a hidden cell from the other column's groups and computes the
 * resulting two-column proof. When the hidden number is rebuilt, it is
 * plugged back into the column so every total (including parent totals)
 * re-adds cleanly. When it cannot be rebuilt, it stays null (never guessed).
 */
export function proveColumnsWithHidden(
  left: ReadonlyArray<number | null>,
  right: ReadonlyArray<number | null>,
  hiddenCell: HideCellTarget,
  options?: ProveColumnsOptions,
): { proof: TwoColumnProof; rebuild: RebuildResult } {
  const rebuild = rebuildHiddenCell(left, right, hiddenCell);

  if (rebuild.status === "rebuilt") {
    const leftCopy = [...left];
    const rightCopy = [...right];
    if (hiddenCell.colIndex === 0) {
      leftCopy[hiddenCell.rowIndex] = rebuild.value;
    } else {
      rightCopy[hiddenCell.rowIndex] = rebuild.value;
    }

    const updatedMask = options?.unreadMask?.map((pair, idx) => {
      if (idx !== hiddenCell.rowIndex) return pair;
      return hiddenCell.colIndex === 0
        ? ([false, pair[1]] as const)
        : ([pair[0], false] as const);
    });

    const proof = proveColumns(leftCopy, rightCopy, {
      unreadMask: updatedMask,
    });
    return { proof, rebuild };
  }

  const proof = proveColumns(left, right, options);
  return { proof, rebuild };
}

/**
 * Judges a changed cell against the groups that held BEFORE the change:
 * re-adds every earlier group of the changed column that contains the changed
 * row (as a member or as the total) using the new reading.
 *
 * When one or more earlier groups fail, marks only those failed groups with
 * their gaps. Never names a group that does not contain the changed row.
 * When no earlier group fails, returns caught=false with the plain message
 * "The page could not catch this change."
 */
export function proveColumnsWithChange(
  beforeProof: TwoColumnProof,
  afterLeft: ReadonlyArray<number | null>,
  afterRight: ReadonlyArray<number | null>,
  changedCell: ChangeCellTarget,
  options?: ProveColumnsOptions,
): ChangedProofOutcome {
  const { rowIndex, colIndex } = changedCell;
  const beforeOwnGroups =
    colIndex === 0 ? beforeProof.left.groups : beforeProof.right.groups;
  const afterChangedColumn = colIndex === 0 ? afterLeft : afterRight;
  const afterOtherColumn = colIndex === 0 ? afterRight : afterLeft;

  const caughtMismatches: MismatchedGroup[] = [];
  const stillProvenOwnGroups: AddingGroup[] = [];

  for (const group of beforeOwnGroups) {
    if (group.totalIndex >= afterChangedColumn.length) continue;
    const printedTotal = afterChangedColumn[group.totalIndex];
    if (
      printedTotal === null ||
      printedTotal === undefined ||
      !Number.isFinite(printedTotal)
    ) {
      continue;
    }

    let computedSum = 0;
    let allPresent = true;
    for (const memberIndex of group.memberIndices) {
      const memberValue = afterChangedColumn[memberIndex];
      if (
        memberValue === null ||
        memberValue === undefined ||
        !Number.isFinite(memberValue)
      ) {
        allPresent = false;
        break;
      }
      computedSum += memberValue;
    }
    if (!allPresent) continue;

    const cleanSum = roundClean(computedSum);
    const cleanTotal = roundClean(printedTotal);

    if (numbersEqual(cleanSum, cleanTotal)) {
      stillProvenOwnGroups.push({
        memberIndices: [...group.memberIndices],
        totalIndex: group.totalIndex,
        sum: cleanTotal,
      });
    } else if (groupContainsRow(group, rowIndex)) {
      const diff = roundClean(cleanSum - cleanTotal);
      caughtMismatches.push({
        memberIndices: [...group.memberIndices],
        totalIndex: group.totalIndex,
        computedSum: cleanSum,
        printedTotal: cleanTotal,
        gap: roundClean(Math.abs(diff)),
        diff,
      });
    }
  }

  const otherGroups = findGroups(afterOtherColumn);
  const otherMismatches = findCrossColumnMismatches(
    afterOtherColumn,
    otherGroups,
    beforeOwnGroups,
  );

  // Marks that were already on the changed column before the change stay on it.
  // They come from groups of the other column that this column did not add up to,
  // and they are not part of the answer to the change.
  const alreadyMarkedMismatches = findCrossColumnMismatches(
    afterChangedColumn,
    stillProvenOwnGroups,
    otherGroups,
  ).filter(
    (mismatch) =>
      !caughtMismatches.some(
        (caughtMismatch) =>
          caughtMismatch.totalIndex === mismatch.totalIndex &&
          caughtMismatch.memberIndices.length === mismatch.memberIndices.length &&
          caughtMismatch.memberIndices.every(
            (memberIndex, i) => memberIndex === mismatch.memberIndices[i],
          ),
      ),
  );
  const changedColumnMismatches = [
    ...caughtMismatches,
    ...alreadyMarkedMismatches,
  ];

  const leftUnreadFlags = options?.unreadMask?.map((pair) => pair[0]);
  const rightUnreadFlags = options?.unreadMask?.map((pair) => pair[1]);

  const leftProof =
    colIndex === 0
      ? buildColumnProof(
          afterLeft,
          stillProvenOwnGroups,
          changedColumnMismatches,
          leftUnreadFlags,
        )
      : buildColumnProof(
          afterLeft,
          otherGroups,
          otherMismatches,
          leftUnreadFlags,
        );

  const rightProof =
    colIndex === 1
      ? buildColumnProof(
          afterRight,
          stillProvenOwnGroups,
          changedColumnMismatches,
          rightUnreadFlags,
        )
      : buildColumnProof(
          afterRight,
          otherGroups,
          otherMismatches,
          rightUnreadFlags,
        );

  let proven = 0;
  let needYourEye = 0;
  let notProven = 0;

  for (const status of [
    ...leftProof.cellStatuses,
    ...rightProof.cellStatuses,
  ]) {
    if (status === "proven") {
      proven += 1;
    } else if (status === "mismatch" || status === "unread") {
      needYourEye += 1;
    } else if (status === "not_proven") {
      notProven += 1;
    }
  }

  const caught = caughtMismatches.length > 0;
  return {
    proof: {
      left: leftProof,
      right: rightProof,
      counts: {
        proven,
        needYourEye,
        notProven,
        total: proven + needYourEye + notProven,
      },
    },
    caughtMismatches,
    caught,
    uncaughtMessage: caught ? null : CHANGE_NOT_CAUGHT_MESSAGE,
  };
}

/**
 * Validates and formats a judge-typed replacement number for the Change flow.
 * Accepts standard accounting numbers (with optional commas, $, sign, or
 * parentheses for negatives) and refuses anything else with a plain message.
 */
export function parseChangedNumberInput(raw: string): ChangedNumberInputResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "Enter a number." };
  }

  let negative = false;
  let working = trimmed;

  const parenMatch = /^\$?\s*\(\s*\$?\s*(.+?)\s*\)$/.exec(working);
  if (parenMatch) {
    negative = true;
    working = parenMatch[1].trim();
  } else {
    working = working.replace(/^\$\s*/, "");
    if (/^[-−]/.test(working)) {
      negative = true;
      working = working.slice(1).trim();
    } else if (working.startsWith("+")) {
      working = working.slice(1).trim();
    }
  }

  working = working.replace(/^\$\s*/, "").trim();

  // Reject malformed comma groupings (like "1,2,3") while accepting either
  // plain digits ("15541", "15541.5") or standard thousands commas ("15,541").
  const validNumericPattern = /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
  if (!validNumericPattern.test(working)) {
    return {
      ok: false,
      error: "Enter a valid number, such as 15,541.",
    };
  }

  const numericStr = working.replace(/,/g, "");
  const parsed = Number(numericStr);
  if (!Number.isFinite(parsed)) {
    return {
      ok: false,
      error: "Enter a valid number, such as 15,541.",
    };
  }

  const signed = negative && parsed !== 0 ? -parsed : parsed;
  const absFormatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6,
  }).format(Math.abs(signed));
  const formatted = signed < 0 ? `(${absFormatted})` : absFormatted;

  return {
    ok: true,
    number: signed,
    formatted,
  };
}
