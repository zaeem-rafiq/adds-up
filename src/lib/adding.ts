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

/**
 * A total that adds up within rounding: the filing prints each line rounded to
 * thousands, millions or billions, so the lines miss the printed total by a step
 * or two. It is not an exact proof and it is not a mismatch.
 */
export type RoundingGroup = {
  /** 0-based indices of the component rows. */
  memberIndices: number[];
  /** 0-based index of the total row. */
  totalIndex: number;
  /** Actual sum of the member rows in this column. */
  computedSum: number;
  /** Printed/read value of the total row in this column. */
  printedTotal: number;
  /** Absolute difference between computedSum and printedTotal (never zero). */
  gap: number;
  /** Signed difference (computedSum - printedTotal). */
  diff: number;
  /** The largest gap this group may have and still count as within rounding. */
  allowedGap: number;
};

export type CellProofStatus =
  | "proven"
  | "within_rounding"
  | "mismatch"
  | "unread"
  | "not_proven"
  | "empty";

export type ColumnProof = {
  groups: AddingGroup[];
  mismatches: MismatchedGroup[];
  /** Groups that add up only within rounding. Never part of `mismatches`. */
  roundingGroups: RoundingGroup[];
  cellStatuses: CellProofStatus[];
};

export type ProofCounts = {
  /** Numbers proven by an exact group. Numbers within rounding are not counted here. */
  proven: number;
  withinRounding: number;
  needYourEye: number;
  notProven: number;
  total: number;
};

export type TwoColumnProof = {
  left: ColumnProof;
  right: ColumnProof;
  counts: ProofCounts;
};

export type ProveColumnsOptions = {
  /**
   * Optional per-row [leftUnread, rightUnread] flags.
   * When omitted, any null cell is treated as unread.
   * When provided, a null cell whose flag is false is treated as an empty/dash
   * cell (no number on the statement) rather than an unread number.
   */
  unreadMask?: ReadonlyArray<readonly [boolean, boolean]>;
  /**
   * The statement's unit line. The rounding rule applies only when it holds the word
   * "thousand", "million" or "billion", in any case. Leave it out for a statement
   * in single dollars and for an upload, which has no unit line.
   */
  unitLine?: string | null;
  /**
   * Optional per-row flag: the statement flags this number row as a total row.
   * Only the rounding rule reads it.
   */
  totalFlags?: ReadonlyArray<boolean>;
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

export const ROUNDING_GROUP_REASON =
  "This number's group adds up only within rounding.";

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
  return walkColumn(column, false).groups;
}

type ColumnWalk = {
  groups: AddingGroup[];
  /**
   * For each row, the indices of the open rows as they stood just before the walk
   * reached that row (oldest first). Filled only when asked for.
   */
  openBefore: number[][];
};

/** The adding walk behind findGroups, which can also keep the open rows at each step. */
function walkColumn(
  column: ReadonlyArray<number | null>,
  keepOpenRows: boolean,
): ColumnWalk {
  const open: Array<{ index: number; value: number }> = [];
  const groups: AddingGroup[] = [];
  const openBefore: number[][] = [];

  for (let i = 0; i < column.length; i += 1) {
    const val = column[i];
    if (keepOpenRows) {
      openBefore.push(open.map((entry) => entry.index));
    }

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

  return { groups, openBefore };
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

/** The rounding rule applies only to a statement printed in thousands, millions or billions. */
export function unitLineAllowsRounding(
  unitLine: string | null | undefined,
): boolean {
  return typeof unitLine === "string" && /thousand|million|billion/i.test(unitLine);
}

/** The most steps a group of `memberCount` rows may miss its total by: half the rows, rounded up, at most 3. */
export function roundingAllowedSteps(memberCount: number): number {
  return Math.min(Math.ceil(memberCount / 2), 3);
}

function decimalPlaces(value: number): number {
  for (let places = 0; places < 6; places += 1) {
    const scaled = value * 10 ** places;
    if (Math.abs(scaled - Math.round(scaled)) < EPSILON) return places;
  }
  return 6;
}

/** The smallest unit printed in a column: 1 for whole numbers, 0.1 for one decimal place, and so on. */
function columnStep(column: ReadonlyArray<number | null>): number {
  let places = 0;
  for (const value of column) {
    if (value !== null && Number.isFinite(value)) {
      places = Math.max(places, decimalPlaces(value));
    }
  }
  return 10 ** -places;
}

function groupKey(group: { totalIndex: number; memberIndices: number[] }): string {
  return `${group.totalIndex}:${group.memberIndices.join(",")}`;
}

/**
 * Turns a group whose rows miss the printed total into a rounding group when the
 * gap is one or more steps and no more than the allowed steps. Returns null otherwise.
 */
function toRoundingGroup(
  group: Pick<
    MismatchedGroup,
    "memberIndices" | "totalIndex" | "computedSum" | "printedTotal"
  >,
  step: number,
): RoundingGroup | null {
  const diff = roundClean(group.computedSum - group.printedTotal);
  // Compare in whole steps, so a column of one-decimal numbers carries no float error.
  const gapSteps = Math.round(Math.abs(diff) / step);
  const allowedSteps = roundingAllowedSteps(group.memberIndices.length);
  if (numbersEqual(diff, 0) || gapSteps < 1 || gapSteps > allowedSteps) {
    return null;
  }
  return {
    memberIndices: [...group.memberIndices],
    totalIndex: group.totalIndex,
    computedSum: roundClean(group.computedSum),
    printedTotal: roundClean(group.printedTotal),
    gap: roundClean(Math.abs(diff)),
    diff,
    allowedGap: roundClean(allowedSteps * step),
  };
}

/** Re-adds a rounding group against a column's current values. Null when it no longer adds up within rounding. */
function readdRoundingGroup(
  column: ReadonlyArray<number | null>,
  group: RoundingGroup,
  step: number,
): RoundingGroup | null {
  const printedTotal = column[group.totalIndex];
  if (printedTotal === null || printedTotal === undefined || !Number.isFinite(printedTotal)) {
    return null;
  }
  let computedSum = 0;
  for (const memberIndex of group.memberIndices) {
    const value = column[memberIndex];
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return null;
    }
    computedSum += value;
  }
  return toRoundingGroup(
    {
      memberIndices: group.memberIndices,
      totalIndex: group.totalIndex,
      computedSum,
      printedTotal,
    },
    step,
  );
}

/**
 * Case (a) of the rounding rule: a row the statement flags as a total, that is not the
 * total of an exact group in its column and not the total of an exact group in the other
 * column. Its members are the nearest run of two or more open rows above it whose sum
 * is within the allowed gap of the row's value, shortest run first.
 */
function findFlaggedRoundingGroups(
  column: ReadonlyArray<number | null>,
  ownGroups: ReadonlyArray<AddingGroup>,
  otherGroups: ReadonlyArray<AddingGroup>,
  totalFlags: ReadonlyArray<boolean>,
  openBefore: ReadonlyArray<ReadonlyArray<number>>,
  step: number,
): RoundingGroup[] {
  const ownTotals = new Set(ownGroups.map((group) => group.totalIndex));
  const otherTotals = new Set(otherGroups.map((group) => group.totalIndex));
  const found: RoundingGroup[] = [];

  for (let i = 0; i < column.length; i += 1) {
    if (!totalFlags[i] || ownTotals.has(i) || otherTotals.has(i)) continue;
    const printedTotal = column[i];
    // A zero is never a total, as in the exact rule.
    if (
      printedTotal === null ||
      !Number.isFinite(printedTotal) ||
      numbersEqual(printedTotal, 0)
    ) {
      continue;
    }
    const open = openBefore[i] ?? [];

    let runSum = 0;
    for (let k = open.length - 1; k >= 0; k -= 1) {
      runSum += column[open[k]] as number;
      const count = open.length - k;
      if (count < 2) continue;
      const group = toRoundingGroup(
        {
          memberIndices: open.slice(k),
          totalIndex: i,
          computedSum: runSum,
          printedTotal,
        },
        step,
      );
      if (group) {
        found.push(group);
        break;
      }
    }
  }

  return found;
}

/**
 * Splits what one column does not add up to into marks and rounding groups.
 * Without the rounding rule every gap is a mark, as before.
 */
function judgeColumn(
  column: ReadonlyArray<number | null>,
  walk: ColumnWalk,
  otherGroups: ReadonlyArray<AddingGroup>,
  roundingOn: boolean,
  totalFlags: ReadonlyArray<boolean> | undefined,
): { mismatches: MismatchedGroup[]; roundingGroups: RoundingGroup[] } {
  const crossMismatches = findCrossColumnMismatches(column, walk.groups, otherGroups);
  if (!roundingOn) {
    return { mismatches: crossMismatches, roundingGroups: [] };
  }

  const step = columnStep(column);
  const mismatches: MismatchedGroup[] = [];
  const roundingGroups: RoundingGroup[] = [];
  for (const mismatch of crossMismatches) {
    const rounding = toRoundingGroup(mismatch, step);
    if (rounding) roundingGroups.push(rounding);
    else mismatches.push(mismatch);
  }
  if (totalFlags) {
    roundingGroups.push(
      ...findFlaggedRoundingGroups(
        column,
        walk.groups,
        otherGroups,
        totalFlags,
        walk.openBefore,
        step,
      ),
    );
  }
  roundingGroups.sort((a, b) => a.totalIndex - b.totalIndex);
  return { mismatches, roundingGroups };
}

function countStatuses(statuses: ReadonlyArray<CellProofStatus>): ProofCounts {
  let proven = 0;
  let withinRounding = 0;
  let needYourEye = 0;
  let notProven = 0;

  for (const status of statuses) {
    if (status === "proven") {
      proven += 1;
    } else if (status === "within_rounding") {
      withinRounding += 1;
    } else if (status === "mismatch" || status === "unread") {
      needYourEye += 1;
    } else if (status === "not_proven") {
      notProven += 1;
    }
  }

  return {
    proven,
    withinRounding,
    needYourEye,
    notProven,
    total: proven + withinRounding + needYourEye + notProven,
  };
}

function buildColumnProof(
  column: ReadonlyArray<number | null>,
  groups: AddingGroup[],
  mismatches: MismatchedGroup[],
  roundingGroups: RoundingGroup[],
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

  const roundingIndices = new Set<number>();
  for (const roundingGroup of roundingGroups) {
    for (const idx of roundingGroup.memberIndices) {
      roundingIndices.add(idx);
    }
    roundingIndices.add(roundingGroup.totalIndex);
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
    // A number inside a rounding group gets no tick, even when another group
    // of its own re-adds exactly. The tick promises that the number can be hidden
    // and rebuilt, and a number inside a rounding group cannot.
    if (roundingIndices.has(index)) {
      return "within_rounding";
    }
    if (provenIndices.has(index)) {
      return "proven";
    }
    return "not_proven";
  });

  return {
    groups,
    mismatches,
    roundingGroups,
    cellStatuses,
  };
}

/**
 * Applies the adding rule to both columns and cross-checks groups that re-add
 * in one column against the same rows in the other column.
 *
 * With `options.unitLine` in thousands, millions or billions, a total that misses
 * its lines by no more than the allowed gap is a rounding group instead of a mark
 * (see findFlaggedRoundingGroups and toRoundingGroup). The exact rule runs first and
 * is not changed by it.
 */
export function proveColumns(
  left: ReadonlyArray<number | null>,
  right: ReadonlyArray<number | null>,
  options?: ProveColumnsOptions,
): TwoColumnProof {
  const roundingOn = unitLineAllowsRounding(options?.unitLine);
  const totalFlags = options?.totalFlags;
  const keepOpenRows = roundingOn && totalFlags !== undefined;
  const leftWalk = walkColumn(left, keepOpenRows);
  const rightWalk = walkColumn(right, keepOpenRows);

  const leftJudged = judgeColumn(
    left,
    leftWalk,
    rightWalk.groups,
    roundingOn,
    totalFlags,
  );
  const rightJudged = judgeColumn(
    right,
    rightWalk,
    leftWalk.groups,
    roundingOn,
    totalFlags,
  );

  const leftUnreadFlags = options?.unreadMask?.map((pair) => pair[0]);
  const rightUnreadFlags = options?.unreadMask?.map((pair) => pair[1]);

  const leftProof = buildColumnProof(
    left,
    leftWalk.groups,
    leftJudged.mismatches,
    leftJudged.roundingGroups,
    leftUnreadFlags,
  );
  const rightProof = buildColumnProof(
    right,
    rightWalk.groups,
    rightJudged.mismatches,
    rightJudged.roundingGroups,
    rightUnreadFlags,
  );

  return {
    left: leftProof,
    right: rightProof,
    counts: countStatuses([
      ...leftProof.cellStatuses,
      ...rightProof.cellStatuses,
    ]),
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

  // A number in a rounding group can be neither hidden nor changed. This also
  // covers an exact subtotal that sits inside one: a rebuild would carry the
  // rounding gap into the number.
  if (status === "within_rounding") {
    return {
      allowed: false,
      reason: ROUNDING_GROUP_REASON,
    };
  }

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
      ...options,
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

  // The column that did not change is judged as a whole, as proveColumns judges it.
  const roundingOn = unitLineAllowsRounding(options?.unitLine);
  const totalFlags = options?.totalFlags;
  const otherWalk = walkColumn(
    afterOtherColumn,
    roundingOn && totalFlags !== undefined,
  );
  const otherGroups = otherWalk.groups;
  const otherJudged = judgeColumn(
    afterOtherColumn,
    otherWalk,
    beforeOwnGroups,
    roundingOn,
    totalFlags,
  );

  // A rounding group of the changed column that still adds up within rounding stays
  // within rounding. Nothing new becomes a rounding group here: a change is judged
  // exactly, so a group that failed because of the change stays a mark, however small
  // its gap. A number inside a rounding group cannot be changed (canHideCell refuses it),
  // so these groups do not hold the changed number.
  const beforeChangedRounding =
    colIndex === 0
      ? beforeProof.left.roundingGroups
      : beforeProof.right.roundingGroups;
  const changedStep = columnStep(afterChangedColumn);
  const keptRounding: RoundingGroup[] = [];
  for (const earlier of beforeChangedRounding) {
    const kept = readdRoundingGroup(afterChangedColumn, earlier, changedStep);
    if (kept) keptRounding.push(kept);
  }
  const keptRoundingKeys = new Set(keptRounding.map(groupKey));

  // Marks that were already on the changed column before the change stay on it.
  // They come from groups of the other column that this column did not add up to,
  // and they are not part of the answer to the change.
  const caughtKeys = new Set(caughtMismatches.map(groupKey));
  const alreadyMarkedMismatches = findCrossColumnMismatches(
    afterChangedColumn,
    stillProvenOwnGroups,
    otherGroups,
  ).filter(
    (mismatch) =>
      !caughtKeys.has(groupKey(mismatch)) &&
      !keptRoundingKeys.has(groupKey(mismatch)),
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
          keptRounding,
          leftUnreadFlags,
        )
      : buildColumnProof(
          afterLeft,
          otherGroups,
          otherJudged.mismatches,
          otherJudged.roundingGroups,
          leftUnreadFlags,
        );

  const rightProof =
    colIndex === 1
      ? buildColumnProof(
          afterRight,
          stillProvenOwnGroups,
          changedColumnMismatches,
          keptRounding,
          rightUnreadFlags,
        )
      : buildColumnProof(
          afterRight,
          otherGroups,
          otherJudged.mismatches,
          otherJudged.roundingGroups,
          rightUnreadFlags,
        );

  const caught = caughtMismatches.length > 0;
  return {
    proof: {
      left: leftProof,
      right: rightProof,
      counts: countStatuses([
        ...leftProof.cellStatuses,
        ...rightProof.cellStatuses,
      ]),
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

  // QA: past 15 digits a JavaScript number loses digits, so the page would
  // show a number the judge never typed.
  if (numericStr.split(".")[0].replace(/^0+/, "").length > 15) {
    return {
      ok: false,
      error: "Enter a number with at most 15 digits.",
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
