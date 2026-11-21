"use client";

import type {
  AddingGroup,
  CellProofStatus,
  MismatchedGroup,
  RebuildResult,
  RoundingGroup,
  TwoColumnProof,
} from "@/lib/adding";
import type {
  ReadDispute,
  RowComparison,
  StatementReadingResult,
} from "@/lib/reading";
import {
  secondReaderCellKey,
  type SecondReaderCellResult,
  type SecondReaderVerdict,
} from "@/lib/second-reader-types";
import type { Statement } from "@/lib/statements";

export type ResultHeadingRow = {
  kind: "heading";
  label: string;
  indent: number;
};

export type ResultNumberRow = {
  kind: "number";
  numberRowIndex: number;
  label: string;
  indent: number;
  isTotal: boolean;
  rawValues: [string, string];
  numbers: [number | null, number | null];
  unread: [boolean, boolean];
  hidden: [boolean, boolean];
  /** Set for a cell the two readers of an upload read differently. Such a cell is not read. */
  disputed?: [ReadDispute | null, ReadDispute | null];
};

export type ResultDisplayRow = ResultHeadingRow | ResultNumberRow;

export type SelectedCellRef = {
  rowIndex: number;
  colIndex: 0 | 1;
};

export type TableMode = "normal" | "rehide" | "hidden" | "rechange" | "changed";

export function formatProofNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Builds the ordered display rows for the result table from the reading.
 * Headings come from the statement structure (they have no numbers and get no
 * mark); all displayed numbers come strictly from the model's reading.
 */
export function buildResultDisplayRows(
  statement: Statement,
  result: StatementReadingResult,
): ResultDisplayRow[] {
  if (result.comparison.rows.length > 0) {
    const compByStmtIdx = new Map<number, RowComparison>();
    for (const rowComp of result.comparison.rows) {
      compByStmtIdx.set(rowComp.statementRowIndex, rowComp);
    }

    const displayRows: ResultDisplayRow[] = [];
    let numberRowIndex = 0;

    for (let i = 0; i < statement.rows.length; i += 1) {
      const stmtRow = statement.rows[i];
      if (stmtRow.kind === "heading") {
        displayRows.push({
          kind: "heading",
          label: stmtRow.label,
          indent: stmtRow.indent,
        });
        continue;
      }

      const comp = compByStmtIdx.get(i);
      const leftCell = comp?.cells[0];
      const rightCell = comp?.cells[1];
      const leftReadCell = comp?.readRow?.cells[0];
      const rightReadCell = comp?.readRow?.cells[1];

      const leftNumber = leftCell ? leftCell.read : null;
      const rightNumber = rightCell ? rightCell.read : null;
      const leftHidden = leftCell ? leftCell.hidden : false;
      const rightHidden = rightCell ? rightCell.hidden : false;
      const leftUnread = leftCell ? leftCell.unread || leftCell.hidden : false;
      const rightUnread = rightCell
        ? rightCell.unread || rightCell.hidden
        : false;

      const leftRaw =
        leftReadCell?.raw ||
        (leftNumber !== null ? formatProofNumber(leftNumber) : "");
      const rightRaw =
        rightReadCell?.raw ||
        (rightNumber !== null ? formatProofNumber(rightNumber) : "");

      displayRows.push({
        kind: "number",
        numberRowIndex,
        label: stmtRow.label,
        indent: stmtRow.indent,
        isTotal: stmtRow.isTotal,
        rawValues: [leftRaw, rightRaw],
        numbers: [leftNumber, rightNumber],
        unread: [leftUnread, rightUnread],
        hidden: [leftHidden, rightHidden],
      });
      numberRowIndex += 1;
    }

    return displayRows;
  }

  // Fallback when no SEC comparison rows exist (e.g., upload or minimal reading):
  // build directly from the rows returned by the model.
  return result.rows.map((readRow, idx) => ({
    kind: "number",
    numberRowIndex: idx,
    label: readRow.label,
    indent: 0,
    isTotal: false,
    rawValues: [readRow.cells[0].raw, readRow.cells[1].raw],
    numbers: [readRow.cells[0].number, readRow.cells[1].number],
    // A disputed cell has no number, and counts as not read: it never gets a tick.
    unread: [
      readRow.cells[0].hidden || Boolean(readRow.cells[0].disputed),
      readRow.cells[1].hidden || Boolean(readRow.cells[1].disputed),
    ],
    hidden: [readRow.cells[0].hidden, readRow.cells[1].hidden],
    disputed: [
      readRow.cells[0].disputed ?? null,
      readRow.cells[1].disputed ?? null,
    ],
  }));
}

type GroupAnnotation =
  | {
      kind: "proven";
      totalIndex: number;
      memberIndices: number[];
      sum: number;
      unitWord: "lines" | "totals";
      column: 0 | 1;
    }
  | {
      kind: "mismatch";
      totalIndex: number;
      memberIndices: number[];
      computedSum: number;
      printedTotal: number;
      gap: number;
      unitWord: "lines" | "totals";
      brokenCols: [boolean, boolean];
    }
  | {
      kind: "rounding";
      totalIndex: number;
      memberIndices: number[];
      computedSum: number;
      printedTotal: number;
      gap: number;
      unitWord: "lines" | "totals";
      roundingCols: [boolean, boolean];
    };

type BracketSegment = {
  kind: "proven" | "mismatch" | "rounding";
  position: "start" | "middle" | "end";
  sideNote?: string;
};

function buildAnnotations(
  displayRows: ResultDisplayRow[],
  proof: TwoColumnProof,
): {
  totalAnnotations: Map<number, GroupAnnotation>;
  bracketsByDisplayRow: Map<number, BracketSegment>;
  totalNumberIndices: Set<number>;
} {
  const allTotalIndices = new Set<number>();
  for (const g of proof.left.groups) allTotalIndices.add(g.totalIndex);
  for (const g of proof.right.groups) allTotalIndices.add(g.totalIndex);
  for (const m of proof.left.mismatches) allTotalIndices.add(m.totalIndex);
  for (const m of proof.right.mismatches) allTotalIndices.add(m.totalIndex);
  for (const r of proof.left.roundingGroups) allTotalIndices.add(r.totalIndex);
  for (const r of proof.right.roundingGroups) allTotalIndices.add(r.totalIndex);

  const leftGroupByTotal = new Map<number, AddingGroup>();
  for (const g of proof.left.groups) leftGroupByTotal.set(g.totalIndex, g);
  const rightGroupByTotal = new Map<number, AddingGroup>();
  for (const g of proof.right.groups) rightGroupByTotal.set(g.totalIndex, g);

  const leftMismatchByTotal = new Map<number, MismatchedGroup>();
  for (const m of proof.left.mismatches) {
    leftMismatchByTotal.set(m.totalIndex, m);
  }
  const rightMismatchByTotal = new Map<number, MismatchedGroup>();
  for (const m of proof.right.mismatches) {
    rightMismatchByTotal.set(m.totalIndex, m);
  }

  const leftRoundingByTotal = new Map<number, RoundingGroup>();
  for (const r of proof.left.roundingGroups) {
    leftRoundingByTotal.set(r.totalIndex, r);
  }
  const rightRoundingByTotal = new Map<number, RoundingGroup>();
  for (const r of proof.right.roundingGroups) {
    rightRoundingByTotal.set(r.totalIndex, r);
  }

  const totalAnnotations = new Map<number, GroupAnnotation>();

  for (const totalIndex of allTotalIndices) {
    const leftM = leftMismatchByTotal.get(totalIndex);
    const rightM = rightMismatchByTotal.get(totalIndex);

    if (leftM || rightM) {
      const primary = leftM ?? rightM!;
      const allMembersAreTotals = primary.memberIndices.every((idx) =>
        allTotalIndices.has(idx),
      );
      totalAnnotations.set(totalIndex, {
        kind: "mismatch",
        totalIndex,
        memberIndices: primary.memberIndices,
        computedSum: primary.computedSum,
        printedTotal: primary.printedTotal,
        gap: primary.gap,
        unitWord: allMembersAreTotals ? "totals" : "lines",
        brokenCols: [Boolean(leftM), Boolean(rightM)],
      });
      continue;
    }

    // A total that adds up only within rounding is not red and is not a full proof.
    // It wins over an exact group of the other column so the page says so.
    const leftR = leftRoundingByTotal.get(totalIndex);
    const rightR = rightRoundingByTotal.get(totalIndex);
    if (leftR || rightR) {
      const primary = leftR ?? rightR!;
      const allMembersAreTotals = primary.memberIndices.every((idx) =>
        allTotalIndices.has(idx),
      );
      totalAnnotations.set(totalIndex, {
        kind: "rounding",
        totalIndex,
        memberIndices: primary.memberIndices,
        computedSum: primary.computedSum,
        printedTotal: primary.printedTotal,
        gap: primary.gap,
        unitWord: allMembersAreTotals ? "totals" : "lines",
        roundingCols: [Boolean(leftR), Boolean(rightR)],
      });
      continue;
    }

    const leftG = leftGroupByTotal.get(totalIndex);
    const rightG = rightGroupByTotal.get(totalIndex);
    const primary = leftG ?? rightG;
    if (primary) {
      const allMembersAreTotals = primary.memberIndices.every((idx) =>
        allTotalIndices.has(idx),
      );
      totalAnnotations.set(totalIndex, {
        kind: "proven",
        totalIndex,
        memberIndices: primary.memberIndices,
        sum: primary.sum,
        unitWord: allMembersAreTotals ? "totals" : "lines",
        column: leftG ? 0 : 1,
      });
    }
  }

  const displayIndexByNumberIndex = new Map<number, number>();
  for (let d = 0; d < displayRows.length; d += 1) {
    const row = displayRows[d];
    if (row.kind === "number") {
      displayIndexByNumberIndex.set(row.numberRowIndex, d);
    }
  }

  const bracketsByDisplayRow = new Map<number, BracketSegment>();

  // Draw vertical brackets for leaf groups (groups whose members are not
  // themselves totals of inner groups) so brackets never overlap.
  const sortedAnnotations = [...totalAnnotations.values()].sort(
    (a, b) => a.totalIndex - b.totalIndex,
  );

  for (const annotation of sortedAnnotations) {
    if (annotation.memberIndices.length < 2) continue;
    const hasTotalMember = annotation.memberIndices.some((idx) =>
      allTotalIndices.has(idx),
    );
    if (hasTotalMember) continue;

    const startDisplay = displayIndexByNumberIndex.get(
      annotation.memberIndices[0],
    );
    const endDisplay = displayIndexByNumberIndex.get(annotation.totalIndex);
    if (
      startDisplay === undefined ||
      endDisplay === undefined ||
      endDisplay <= startDisplay
    ) {
      continue;
    }

    let overlaps = false;
    for (let d = startDisplay; d <= endDisplay; d += 1) {
      if (bracketsByDisplayRow.has(d)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;

    const midMemberIdx =
      annotation.memberIndices[
        Math.floor((annotation.memberIndices.length - 1) / 2)
      ];
    const midDisplay = displayIndexByNumberIndex.get(midMemberIdx);

    for (let d = startDisplay; d <= endDisplay; d += 1) {
      const position: BracketSegment["position"] =
        d === startDisplay ? "start" : d === endDisplay ? "end" : "middle";
      const sideNote =
        annotation.kind === "mismatch" && d === midDisplay
          ? `off by ${formatProofNumber(annotation.gap)} in this group`
          : undefined;
      bracketsByDisplayRow.set(d, {
        kind: annotation.kind,
        position,
        sideNote,
      });
    }
  }

  return {
    totalAnnotations,
    bracketsByDisplayRow,
    totalNumberIndices: allTotalIndices,
  };
}

function ProvenCheckIcon({ size = "sm" }: { size?: "sm" | "xs" }) {
  const dims = size === "xs" ? "h-4 w-4" : "h-[18px] w-[18px]";
  return (
    <svg
      className={`${dims} shrink-0 text-[#146c43]`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="9" />
      <path
        d="M6.4 10.3L8.8 12.7L13.8 7.5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The mark for a total that adds up within rounding: an amber check on a dashed
 * ring. It is neither the solid green tick nor the red warning.
 */
export function RoundingCheckIcon({ size = "sm" }: { size?: "sm" | "xs" }) {
  const dims = size === "xs" ? "h-4 w-4" : "h-[18px] w-[18px]";
  return (
    <svg
      className={`${dims} shrink-0 text-[#b45309]`}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="8.2" fill="#fff4d6" />
      <circle
        cx="10"
        cy="10"
        r="8.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeDasharray="2.6 2.1"
      />
      <path
        d="M6.2 10.4L8.6 12.4L10.5 8.9L13.9 7.3"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RowSpinnerIcon() {
  return (
    <svg
      className="h-[18px] w-[18px] shrink-0 animate-spin text-[#1d4ea8]"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7.5" stroke="#cbd5e1" strokeWidth="2.2" />
      <path
        d="M10 2.5A7.5 7.5 0 0 1 17.5 10"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CircleMinusIcon({
  tone = "muted",
}: {
  tone?: "muted" | "mismatch";
}) {
  const color = tone === "mismatch" ? "text-slate-500" : "text-slate-400";
  return (
    <svg
      className={`h-[18px] w-[18px] shrink-0 ${color}`}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7.5" />
      <path d="M6.8 10H13.2" strokeLinecap="round" />
    </svg>
  );
}

function MismatchTriangleIcon({ size = "sm" }: { size?: "sm" | "xs" }) {
  const dims = size === "xs" ? "h-4 w-4" : "h-[18px] w-[18px]";
  return (
    <svg
      className={`${dims} shrink-0 text-[#b53800]`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9.13 3.4a1 1 0 0 1 1.74 0l7.15 12.6A1 1 0 0 1 17.15 17.5H2.85a1 1 0 0 1-.87-1.5L9.13 3.4Z" />
      <path
        d="M10 8v3.6"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="10" cy="14.3" r="1" fill="#ffffff" />
    </svg>
  );
}

function NeedsEyeIcon() {
  return (
    <svg
      className="h-[18px] w-[18px] shrink-0 text-[#b45309]"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="15" height="15" rx="3.5" />
      <path
        d="M8.1 7.7a2 2 0 1 1 3.2 1.6c-.6.45-1.3.9-1.3 1.8v.4"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="10" cy="14.3" r="1" fill="#ffffff" />
    </svg>
  );
}

function DisagreesEyeIcon() {
  return (
    <svg
      className="h-[18px] w-[18px] shrink-0 text-[#b91c1c]"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="15" height="15" rx="3.5" />
      <path
        d="M10 6.5v4.3"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="10" cy="14.1" r="1.1" fill="#ffffff" />
    </svg>
  );
}

function getRowVisualStatus(
  leftStatus: CellProofStatus,
  rightStatus: CellProofStatus,
  isMismatchTotal: boolean,
  leftRecheck?: SecondReaderCellResult,
  rightRecheck?: SecondReaderCellResult,
):
  | "proven"
  | "mismatch-total"
  | "mismatch-member"
  | "recheck-disagrees"
  | "unread"
  | "recheck-unsure"
  | "not-proven"
  | "within-rounding"
  | "none" {
  if (leftStatus === "mismatch" || rightStatus === "mismatch") {
    return isMismatchTotal ? "mismatch-total" : "mismatch-member";
  }
  if (
    (leftStatus === "not_proven" && leftRecheck?.verdict === "disagrees") ||
    (rightStatus === "not_proven" && rightRecheck?.verdict === "disagrees")
  ) {
    return "recheck-disagrees";
  }
  if (leftStatus === "unread" || rightStatus === "unread") {
    return "unread";
  }
  if (
    (leftStatus === "not_proven" && leftRecheck?.verdict === "unsure") ||
    (rightStatus === "not_proven" && rightRecheck?.verdict === "unsure")
  ) {
    return "recheck-unsure";
  }
  if (leftStatus === "not_proven" || rightStatus === "not_proven") {
    return "not-proven";
  }
  if (leftStatus === "within_rounding" || rightStatus === "within_rounding") {
    return "within-rounding";
  }
  if (leftStatus === "proven" || rightStatus === "proven") {
    return "proven";
  }
  return "none";
}

function formatCellDisplay(
  raw: string,
  numberValue: number | null,
  status: CellProofStatus,
): string {
  if (status === "unread") return "Not read";
  if (raw) return raw;
  if (numberValue !== null) return formatProofNumber(numberValue);
  return "—";
}

type ResultTableProps = {
  statement: Statement;
  source: "sec" | "saved" | "fixture" | "upload";
  displayRows: ResultDisplayRow[];
  proof: TwoColumnProof;
  mode?: TableMode;
  selectedCell?: SelectedCellRef | null;
  onSelectCell?: (cell: SelectedCellRef) => void;
  onQuickHide?: (cell: SelectedCellRef) => void;
  onQuickChange?: (cell: SelectedCellRef) => void;
  activeHiddenCell?: SelectedCellRef | null;
  activeChangedCell?: (SelectedCellRef & { displayValue: string }) | null;
  rebuild?: RebuildResult | null;
  secondReaderByCell?: ReadonlyMap<string, SecondReaderCellResult>;
};

export function ResultTable({
  statement,
  source,
  displayRows,
  proof,
  mode = "normal",
  selectedCell = null,
  onSelectCell,
  onQuickHide,
  onQuickChange,
  activeHiddenCell = null,
  activeChangedCell = null,
  rebuild = null,
  secondReaderByCell,
}: ResultTableProps) {
  const { totalAnnotations, bracketsByDisplayRow, totalNumberIndices } =
    buildAnnotations(displayRows, proof);

  const lastNumberDisplayIdx = (() => {
    for (let i = displayRows.length - 1; i >= 0; i -= 1) {
      if (displayRows[i].kind === "number") return i;
    }
    return -1;
  })();

  const formattedUnitLine = statement.unitLine
    ? statement.unitLine.startsWith("(")
      ? statement.unitLine
      : `(${statement.unitLine})`
    : "";

  const isCheckingAgain = mode === "rehide" || mode === "rechange";

  const headerTitle =
    mode === "rehide" || mode === "hidden"
      ? "Picture sent to the models, with your number hidden"
      : mode === "rechange" || mode === "changed"
        ? "Picture sent to the models, with your change"
        : source === "upload"
          ? "Picture made from your file"
          : "Proved from the reading";

  const hiddenRowLabel = (() => {
    if (!activeHiddenCell) return "";
    const row = displayRows.find(
      (r): r is ResultNumberRow =>
        r.kind === "number" && r.numberRowIndex === activeHiddenCell.rowIndex,
    );
    return row?.label ?? "";
  })();

  return (
    <section
      aria-label="Balance sheet proof"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 text-xs text-slate-500 sm:px-6">
        <span>{headerTitle}</span>
        {source === "saved" && <span>Saved copy</span>}
      </div>

      <div className="px-3 py-5 sm:px-6 sm:py-6">
        <div className="mb-4">
          <h2 className="text-[13px] font-bold tracking-wide text-slate-900 uppercase sm:text-[15px]">
            {statement.title || "CONSOLIDATED BALANCE SHEETS"}
          </h2>
          {formattedUnitLine && (
            <p className="mt-0.5 text-xs text-slate-500 sm:text-[13px]">
              {formattedUnitLine}
            </p>
          )}
        </div>

        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="text-[11px] font-semibold text-slate-500 sm:text-xs">
              <th scope="col" className="pb-2.5 pr-2 font-semibold">
                <span className="sr-only">Line item</span>
              </th>
              <th
                scope="col"
                className="w-[78px] pb-2.5 pl-1.5 text-right font-semibold sm:w-[108px] sm:pl-3"
              >
                {statement.columns[0]}
              </th>
              <th
                scope="col"
                className="w-[78px] pb-2.5 pl-1.5 text-right font-semibold sm:w-[108px] sm:pl-3"
              >
                {statement.columns[1]}
              </th>
              <th scope="col" className="w-7 pb-2.5 pl-1.5 text-center sm:w-9">
                <span className="sr-only">Status</span>
              </th>
              <th
                scope="col"
                className="hidden pb-2.5 pl-3 text-left font-semibold md:table-cell md:w-[215px] lg:w-[225px]"
              >
                Proof
              </th>
            </tr>
          </thead>

          <tbody>
            {displayRows.map((row, displayIdx) => {
              if (row.kind === "heading") {
                const isMajor = row.label === row.label.toUpperCase();
                return (
                  <tr key={`heading-${displayIdx}`} data-row-kind="heading">
                    <th
                      scope="rowgroup"
                      colSpan={4}
                      className={`pr-2 text-left text-[13px] font-bold text-slate-900 sm:text-sm ${
                        displayIdx === 0 ? "pt-1 pb-1.5" : "pt-4 pb-1.5"
                      } ${isMajor ? "tracking-wide" : ""}`}
                    >
                      {row.label}
                    </th>
                    <td className="hidden md:table-cell" aria-hidden="true" />
                  </tr>
                );
              }

              const idx = row.numberRowIndex;
              const leftStatus = proof.left.cellStatuses[idx] ?? "not_proven";
              const rightStatus = proof.right.cellStatuses[idx] ?? "not_proven";
              const leftRecheck =
                leftStatus === "not_proven"
                  ? secondReaderByCell?.get(secondReaderCellKey(idx, 0))
                  : undefined;
              const rightRecheck =
                rightStatus === "not_proven"
                  ? secondReaderByCell?.get(secondReaderCellKey(idx, 1))
                  : undefined;
              const annotation = totalAnnotations.get(idx);
              const bracket = bracketsByDisplayRow.get(displayIdx);
              const isTotal = row.isTotal || totalNumberIndices.has(idx);
              const lowerLabel = row.label.trim().toLowerCase();
              const isGrandTotal =
                isTotal &&
                (lowerLabel === "total assets" ||
                  lowerLabel.startsWith("total liabilities and") ||
                  displayIdx === lastNumberDisplayIdx);

              const rowVisual = getRowVisualStatus(
                leftStatus,
                rightStatus,
                annotation?.kind === "mismatch",
                leftRecheck,
                rightRecheck,
              );

              const leftBrokenTotal =
                !isCheckingAgain &&
                annotation?.kind === "mismatch" &&
                annotation.brokenCols[0];
              const rightBrokenTotal =
                !isCheckingAgain &&
                annotation?.kind === "mismatch" &&
                annotation.brokenCols[1];

              const leftRoundingTotal =
                !isCheckingAgain &&
                annotation?.kind === "rounding" &&
                annotation.roundingCols[0];
              const rightRoundingTotal =
                !isCheckingAgain &&
                annotation?.kind === "rounding" &&
                annotation.roundingCols[1];

              const numberBorderClass = isTotal
                ? isGrandTotal
                  ? "border-t border-slate-800 border-b-[3px] border-b-slate-800 border-double"
                  : "border-t border-slate-800"
                : "";

              const leftText = formatCellDisplay(
                row.rawValues[0],
                row.numbers[0],
                leftStatus,
              );
              const rightText = formatCellDisplay(
                row.rawValues[1],
                row.numbers[1],
                rightStatus,
              );

              const isLeftHidden =
                (mode === "rehide" || mode === "hidden") &&
                activeHiddenCell?.rowIndex === idx &&
                activeHiddenCell.colIndex === 0;
              const isRightHidden =
                (mode === "rehide" || mode === "hidden") &&
                activeHiddenCell?.rowIndex === idx &&
                activeHiddenCell.colIndex === 1;

              const isLeftChanged =
                (mode === "rechange" || mode === "changed") &&
                activeChangedCell?.rowIndex === idx &&
                activeChangedCell.colIndex === 0;
              const isRightChanged =
                (mode === "rechange" || mode === "changed") &&
                activeChangedCell?.rowIndex === idx &&
                activeChangedCell.colIndex === 1;

              const primaryWay =
                mode === "hidden" && rebuild?.status === "rebuilt"
                  ? rebuild.ways[0]
                  : null;
              const isRebuildTotalRow =
                primaryWay !== null &&
                primaryWay.kind === "total_minus_others" &&
                primaryWay.totalIndex === idx;
              const isRebuiltHiddenRow =
                mode === "hidden" &&
                rebuild?.status === "rebuilt" &&
                rebuild.rowIndex === idx;

              const showMobileSubRow = isCheckingAgain
                ? isTotal
                : Boolean(annotation) ||
                  isRebuildTotalRow ||
                  isRebuiltHiddenRow ||
                  rowVisual === "not-proven" ||
                  rowVisual === "recheck-unsure" ||
                  rowVisual === "recheck-disagrees" ||
                  rowVisual === "unread";

              return (
                <ResultRowGroup
                  key={`num-${idx}`}
                  row={row}
                  columns={statement.columns}
                  mode={mode}
                  isCheckingAgain={isCheckingAgain}
                  isTotal={isTotal}
                  numberBorderClass={numberBorderClass}
                  leftStatus={leftStatus}
                  rightStatus={rightStatus}
                  leftRecheck={leftRecheck}
                  rightRecheck={rightRecheck}
                  leftText={
                    isLeftChanged && mode === "rechange" && activeChangedCell
                      ? activeChangedCell.displayValue
                      : leftText
                  }
                  rightText={
                    isRightChanged && mode === "rechange" && activeChangedCell
                      ? activeChangedCell.displayValue
                      : rightText
                  }
                  leftBrokenTotal={leftBrokenTotal}
                  rightBrokenTotal={rightBrokenTotal}
                  leftRoundingTotal={leftRoundingTotal}
                  rightRoundingTotal={rightRoundingTotal}
                  isLeftHidden={isLeftHidden}
                  isRightHidden={isRightHidden}
                  isLeftChanged={isLeftChanged}
                  isRightChanged={isRightChanged}
                  selectedCell={selectedCell}
                  onSelectCell={onSelectCell}
                  onQuickHide={onQuickHide}
                  onQuickChange={onQuickChange}
                  rowVisual={rowVisual}
                  annotation={annotation}
                  bracket={bracket}
                  rebuild={rebuild}
                  hiddenRowLabel={hiddenRowLabel}
                  showMobileSubRow={showMobileSubRow}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type ResultRowGroupProps = {
  row: ResultNumberRow;
  columns: [string, string];
  mode: TableMode;
  isCheckingAgain: boolean;
  isTotal: boolean;
  numberBorderClass: string;
  leftStatus: CellProofStatus;
  rightStatus: CellProofStatus;
  leftRecheck?: SecondReaderCellResult;
  rightRecheck?: SecondReaderCellResult;
  leftText: string;
  rightText: string;
  leftBrokenTotal: boolean;
  rightBrokenTotal: boolean;
  leftRoundingTotal: boolean;
  rightRoundingTotal: boolean;
  isLeftHidden: boolean;
  isRightHidden: boolean;
  isLeftChanged: boolean;
  isRightChanged: boolean;
  selectedCell: SelectedCellRef | null;
  onSelectCell?: (cell: SelectedCellRef) => void;
  onQuickHide?: (cell: SelectedCellRef) => void;
  onQuickChange?: (cell: SelectedCellRef) => void;
  rowVisual: ReturnType<typeof getRowVisualStatus>;
  annotation: GroupAnnotation | undefined;
  bracket: BracketSegment | undefined;
  rebuild: RebuildResult | null;
  hiddenRowLabel: string;
  showMobileSubRow: boolean;
};

function NumberCellContent({
  rowIndex,
  colIndex,
  rowLabel,
  columnLabel,
  text,
  status,
  mode,
  isHidden,
  isChanged,
  isSelected,
  recheckVerdict,
  onSelectCell,
  onQuickHide,
  onQuickChange,
}: {
  rowIndex: number;
  colIndex: 0 | 1;
  rowLabel: string;
  columnLabel: string;
  text: string;
  status: CellProofStatus;
  mode: TableMode;
  isHidden: boolean;
  isChanged: boolean;
  isSelected: boolean;
  recheckVerdict?: SecondReaderVerdict;
  onSelectCell?: (cell: SelectedCellRef) => void;
  onQuickHide?: (cell: SelectedCellRef) => void;
  onQuickChange?: (cell: SelectedCellRef) => void;
}) {
  if (isHidden) {
    return (
      <span
        data-hidden-cell="true"
        role="img"
        aria-label={`Hidden number for ${rowLabel}`}
        className="inline-block h-[22px] w-[58px] rounded-md bg-[#0f1c32] align-middle sm:w-[74px]"
      />
    );
  }

  if (isChanged) {
    return (
      <span
        data-changed-cell="true"
        className="inline-block rounded-md border-[1.5px] border-[#b53800] bg-orange-50/40 px-1.5 py-0.5 font-semibold text-slate-900"
      >
        {text}
      </span>
    );
  }

  if (mode === "normal" && onSelectCell && status !== "empty") {
    const cellRef: SelectedCellRef = { rowIndex, colIndex };
    return (
      <span className="relative inline-flex items-center justify-end">
        {isSelected && onQuickHide && onQuickChange && (
          <span
            className="absolute right-full top-1/2 z-10 mr-2 hidden -translate-y-1/2 items-center gap-1 rounded-xl border border-slate-300 bg-white p-1 font-sans shadow-md lg:inline-flex"
            data-inline-actions="true"
          >
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onQuickHide(cellRef);
              }}
              className="rounded-lg bg-[#1d4ea8] px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-[#173f8a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8]"
            >
              Hide
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onQuickChange(cellRef);
              }}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8]"
            >
              Change
            </button>
          </span>
        )}
        <button
          type="button"
          data-cell-button={`${rowIndex}-${colIndex}`}
          data-selected={isSelected ? "true" : undefined}
          aria-pressed={isSelected}
          title={`Select ${rowLabel} (${columnLabel})`}
          onClick={() => onSelectCell(cellRef)}
          className={`inline-block cursor-pointer rounded-md px-1.5 py-0.5 text-right transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8] ${
            isSelected
              ? recheckVerdict === "disagrees"
                ? "border-[1.5px] border-[#b91c1c] bg-red-50/70 font-semibold text-[#b91c1c]"
                : "border-[1.5px] border-[#1d4ea8] bg-blue-50/40 font-semibold text-slate-900"
              : recheckVerdict === "disagrees"
                ? "border-[1.5px] border-[#dc2626] bg-red-50/70 font-semibold text-[#b91c1c] hover:bg-red-50"
                : recheckVerdict === "unsure"
                  ? "border-[1.5px] border-dashed border-[#c27803] bg-amber-50/50 text-[#9a5b00] hover:bg-amber-50"
                  : "border border-transparent hover:border-slate-300 hover:bg-slate-50"
          }`}
        >
          {text}
        </button>
      </span>
    );
  }

  return <>{text}</>;
}

/** The note beside a total that adds up within rounding, e.g. "6 lines add to 77,301. Printed 77,302. Adds up within rounding, off by 1." */
function RoundingNote({
  annotation,
}: {
  annotation: Extract<GroupAnnotation, { kind: "rounding" }>;
}) {
  return (
    <span
      data-proof-note="rounding"
      className="inline-flex items-start gap-1.5 font-medium text-[#9a5b00]"
    >
      <span className="mt-px">
        <RoundingCheckIcon size="xs" />
      </span>
      <span>
        {annotation.memberIndices.length} {annotation.unitWord} add to{" "}
        <span className="font-mono tabular-nums">
          {formatProofNumber(annotation.computedSum)}
        </span>
        . Printed{" "}
        <span className="font-mono tabular-nums">
          {formatProofNumber(annotation.printedTotal)}
        </span>
        . Adds up within rounding, off by{" "}
        <span className="font-mono tabular-nums">
          {formatProofNumber(annotation.gap)}
        </span>
        .
      </span>
    </span>
  );
}

function ResultRowGroup({
  row,
  columns,
  mode,
  isCheckingAgain,
  isTotal,
  numberBorderClass,
  leftStatus,
  rightStatus,
  leftRecheck,
  rightRecheck,
  leftText,
  rightText,
  leftBrokenTotal,
  rightBrokenTotal,
  leftRoundingTotal,
  rightRoundingTotal,
  isLeftHidden,
  isRightHidden,
  isLeftChanged,
  isRightChanged,
  selectedCell,
  onSelectCell,
  onQuickHide,
  onQuickChange,
  rowVisual,
  annotation,
  bracket,
  rebuild,
  hiddenRowLabel,
  showMobileSubRow,
}: ResultRowGroupProps) {
  const indentClass = !isTotal && row.indent >= 1 ? "pl-3 sm:pl-5" : "pl-0";

  const isLeftSelected =
    mode === "normal" &&
    selectedCell?.rowIndex === row.numberRowIndex &&
    selectedCell.colIndex === 0;
  const isRightSelected =
    mode === "normal" &&
    selectedCell?.rowIndex === row.numberRowIndex &&
    selectedCell.colIndex === 1;

  const primaryWay =
    mode === "hidden" && rebuild?.status === "rebuilt" ? rebuild.ways[0] : null;
  const isRebuiltHiddenRow =
    mode === "hidden" &&
    rebuild?.status === "rebuilt" &&
    rebuild.rowIndex === row.numberRowIndex;
  const isRebuildSubtractTotal =
    primaryWay !== null &&
    primaryWay.kind === "total_minus_others" &&
    primaryWay.totalIndex === row.numberRowIndex &&
    primaryWay.printedTotal !== null;

  return (
    <>
      <tr
        data-row-kind="number"
        data-row-index={row.numberRowIndex}
        className={isTotal ? "font-semibold text-slate-900" : "text-slate-800"}
      >
        <td
          className={`py-1.5 pr-2 align-bottom text-[13px] leading-snug sm:text-sm ${indentClass}`}
        >
          {row.label}
        </td>

        <td
          data-col="0"
          data-proof-status={leftStatus}
          data-second-reader={leftRecheck?.verdict}
          className={`whitespace-nowrap py-1.5 pl-1.5 text-right align-bottom font-mono text-[12px] tabular-nums sm:pl-3 sm:text-[13.5px] ${numberBorderClass} ${
            leftBrokenTotal
              ? "font-bold text-[#b53800]"
              : leftRoundingTotal
                ? "font-semibold text-[#9a5b00]"
                : leftRecheck?.verdict === "disagrees"
                  ? "font-semibold text-[#b91c1c]"
                  : leftStatus === "unread" && !isLeftHidden
                    ? "font-sans text-xs font-medium text-[#9a5b00]"
                    : leftStatus === "empty"
                      ? "text-slate-400"
                      : ""
          }`}
        >
          <NumberCellContent
            rowIndex={row.numberRowIndex}
            colIndex={0}
            rowLabel={row.label}
            columnLabel={columns[0]}
            text={leftText}
            status={leftStatus}
            mode={mode}
            isHidden={isLeftHidden}
            isChanged={isLeftChanged}
            isSelected={isLeftSelected}
            recheckVerdict={leftRecheck?.verdict}
            onSelectCell={onSelectCell}
            onQuickHide={onQuickHide}
            onQuickChange={onQuickChange}
          />
        </td>

        <td
          data-col="1"
          data-proof-status={rightStatus}
          data-second-reader={rightRecheck?.verdict}
          className={`whitespace-nowrap py-1.5 pl-1.5 text-right align-bottom font-mono text-[12px] tabular-nums sm:pl-3 sm:text-[13.5px] ${numberBorderClass} ${
            rightBrokenTotal
              ? "font-bold text-[#b53800]"
              : rightRoundingTotal
                ? "font-semibold text-[#9a5b00]"
                : rightRecheck?.verdict === "disagrees"
                  ? "font-semibold text-[#b91c1c]"
                  : rightStatus === "unread" && !isRightHidden
                    ? "font-sans text-xs font-medium text-[#9a5b00]"
                    : rightStatus === "empty"
                      ? "text-slate-400"
                      : ""
          }`}
        >
          <NumberCellContent
            rowIndex={row.numberRowIndex}
            colIndex={1}
            rowLabel={row.label}
            columnLabel={columns[1]}
            text={rightText}
            status={rightStatus}
            mode={mode}
            isHidden={isRightHidden}
            isChanged={isRightChanged}
            isSelected={isRightSelected}
            recheckVerdict={rightRecheck?.verdict}
            onSelectCell={onSelectCell}
            onQuickHide={onQuickHide}
            onQuickChange={onQuickChange}
          />
        </td>

        <td className="py-1.5 pl-1.5 text-center align-bottom">
          <div className="flex items-center justify-center">
            {isCheckingAgain ? (
              <span
                data-checking-again="true"
                aria-label="Checking again"
                className="inline-flex"
              >
                <RowSpinnerIcon />
              </span>
            ) : (
              <>
                {rowVisual === "proven" && (
                  <span
                    data-proof-mark="proven"
                    aria-label="Proven"
                    title="Proven"
                    className="inline-flex"
                  >
                    <ProvenCheckIcon />
                  </span>
                )}
                {rowVisual === "within-rounding" && (
                  <span
                    data-proof-mark="within-rounding"
                    aria-label="Adds up within rounding"
                    title="Adds up within rounding"
                    className="inline-flex"
                  >
                    <RoundingCheckIcon />
                  </span>
                )}
                {rowVisual === "mismatch-total" && (
                  <span
                    data-proof-mark="mismatch-total"
                    aria-label="Does not add up"
                    title="Does not add up"
                    className="inline-flex"
                  >
                    <MismatchTriangleIcon />
                  </span>
                )}
                {rowVisual === "mismatch-member" && (
                  <span
                    data-proof-mark="mismatch-member"
                    aria-label="In group that does not add up"
                    title="In group that does not add up"
                    className="inline-flex"
                  >
                    <CircleMinusIcon tone="mismatch" />
                  </span>
                )}
                {rowVisual === "recheck-disagrees" && (
                  <span
                    data-proof-mark="needs-eye-red"
                    aria-label="Needs your eye"
                    title="Needs your eye"
                    className="inline-flex"
                  >
                    <DisagreesEyeIcon />
                  </span>
                )}
                {rowVisual === "recheck-unsure" && (
                  <span
                    data-proof-mark="needs-eye"
                    aria-label="Needs your eye"
                    title="Needs your eye"
                    className="inline-flex"
                  >
                    <NeedsEyeIcon />
                  </span>
                )}
                {rowVisual === "unread" && (
                  <span
                    data-proof-mark="unread"
                    aria-label="Needs your eye"
                    title="Needs your eye"
                    className="inline-flex"
                  >
                    <NeedsEyeIcon />
                  </span>
                )}
                {rowVisual === "not-proven" && (
                  <span
                    data-proof-mark="not-proven"
                    aria-label="Not proven"
                    title="Not proven"
                    className="inline-flex"
                  >
                    <CircleMinusIcon tone="muted" />
                  </span>
                )}
              </>
            )}
          </div>
        </td>

        <td className="relative hidden py-1.5 pl-4 align-bottom text-xs md:table-cell">
          {bracket && (
            <span
              data-proof-bracket={isCheckingAgain ? "checking" : bracket.kind}
              aria-hidden="true"
              className={`pointer-events-none absolute left-1.5 w-[2px] ${
                isCheckingAgain
                  ? "bg-slate-300"
                  : bracket.kind === "mismatch"
                    ? "bg-[#b53800]"
                    : bracket.kind === "rounding"
                      ? "bg-[repeating-linear-gradient(to_bottom,#c27803_0_5px,transparent_5px_8px)]"
                      : "bg-[#146c43]"
              } ${
                bracket.position === "start"
                  ? "top-2 bottom-0"
                  : bracket.position === "end"
                    ? "top-0 bottom-2"
                    : "top-0 bottom-0"
              }`}
            />
          )}

          {isCheckingAgain ? (
            isTotal ? (
              <span className="text-slate-500">checking again</span>
            ) : null
          ) : (
            <>
              {isRebuiltHiddenRow && rebuild?.status === "rebuilt" && (
                <span className="font-semibold text-[#146c43]">
                  rebuilt:{" "}
                  <span className="font-mono tabular-nums">
                    {formatProofNumber(rebuild.value)}
                  </span>
                </span>
              )}

              {!isRebuiltHiddenRow && bracket?.sideNote && (
                <span className="font-semibold text-[#b53800]">
                  {bracket.sideNote}
                </span>
              )}

              {isRebuildSubtractTotal && primaryWay ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-[#146c43]">
                  <ProvenCheckIcon size="xs" />
                  <span className="font-mono font-semibold tabular-nums">
                    {formatProofNumber(primaryWay.printedTotal!)} −{" "}
                    {formatProofNumber(primaryWay.otherMembersSum)}
                  </span>
                </span>
              ) : (
                <>
                  {!isRebuiltHiddenRow && annotation?.kind === "proven" && (
                    <span className="inline-flex items-center gap-1.5 font-medium text-[#146c43]">
                      <ProvenCheckIcon size="xs" />
                      <span>
                        {annotation.memberIndices.length} {annotation.unitWord}{" "}
                        add to{" "}
                        <span className="font-mono font-semibold tabular-nums">
                          {formatProofNumber(annotation.sum)}
                        </span>
                      </span>
                    </span>
                  )}

                  {!isRebuiltHiddenRow && annotation?.kind === "rounding" && (
                    <RoundingNote annotation={annotation} />
                  )}

                  {!isRebuiltHiddenRow && annotation?.kind === "mismatch" && (
                    <span className="inline-flex items-center gap-1.5 font-semibold text-[#b53800]">
                      <MismatchTriangleIcon size="xs" />
                      <span>
                        {annotation.unitWord} add to{" "}
                        <span className="font-mono tabular-nums">
                          {formatProofNumber(annotation.computedSum)}
                        </span>
                        {!bracket && (
                          <>
                            , off by{" "}
                            <span className="font-mono tabular-nums">
                              {formatProofNumber(annotation.gap)}
                            </span>
                          </>
                        )}
                      </span>
                    </span>
                  )}
                </>
              )}

              {!annotation &&
                !bracket?.sideNote &&
                !isRebuiltHiddenRow &&
                rowVisual === "recheck-disagrees" && (
                  <span
                    data-recheck-label="disagrees"
                    className="font-semibold text-[#b91c1c]"
                  >
                    Needs your eye
                  </span>
                )}

              {!annotation &&
                !bracket?.sideNote &&
                !isRebuiltHiddenRow &&
                rowVisual === "recheck-unsure" && (
                  <span
                    data-recheck-label="unsure"
                    className="font-medium text-[#9a5b00]"
                  >
                    Needs your eye
                  </span>
                )}

              {!annotation &&
                !bracket?.sideNote &&
                !isRebuiltHiddenRow &&
                rowVisual === "not-proven" && (
                  <span
                    data-recheck-label={
                      leftRecheck?.verdict === "agrees" ||
                      rightRecheck?.verdict === "agrees"
                        ? "agrees"
                        : undefined
                    }
                    className="text-slate-500"
                  >
                    not proven
                  </span>
                )}

              {!annotation &&
                !bracket?.sideNote &&
                !isRebuiltHiddenRow &&
                rowVisual === "unread" && (
                  <span className="font-medium text-[#9a5b00]">
                    needs your eye
                  </span>
                )}
            </>
          )}
        </td>
      </tr>

      {showMobileSubRow && (
        <tr className="md:hidden" data-mobile-proof-for={row.numberRowIndex}>
          <td colSpan={4} className="pt-0.5 pb-2.5 text-xs">
            {isCheckingAgain ? (
              <span className="text-slate-500">checking again</span>
            ) : isRebuildSubtractTotal &&
              rebuild?.status === "rebuilt" &&
              hiddenRowLabel ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-[#146c43]">
                <ProvenCheckIcon size="xs" />
                <span>
                  {hiddenRowLabel} rebuilt:{" "}
                  <span className="font-mono font-semibold tabular-nums">
                    {formatProofNumber(rebuild.value)}
                  </span>
                </span>
              </span>
            ) : isRebuiltHiddenRow &&
              rebuild?.status === "rebuilt" &&
              primaryWay?.kind === "sum_of_members" ? (
              <span className="inline-flex items-center gap-1.5 font-medium text-[#146c43]">
                <ProvenCheckIcon size="xs" />
                <span>
                  {row.label} rebuilt:{" "}
                  <span className="font-mono font-semibold tabular-nums">
                    {formatProofNumber(rebuild.value)}
                  </span>
                </span>
              </span>
            ) : (
              <>
                {annotation?.kind === "proven" && !isRebuiltHiddenRow && (
                  <span className="inline-flex items-center gap-1.5 font-medium text-[#146c43]">
                    <ProvenCheckIcon size="xs" />
                    <span>
                      {annotation.memberIndices.length} {annotation.unitWord}{" "}
                      add to{" "}
                      <span className="font-mono font-semibold tabular-nums">
                        {formatProofNumber(annotation.sum)}
                      </span>
                    </span>
                  </span>
                )}

                {annotation?.kind === "rounding" && !isRebuiltHiddenRow && (
                  <RoundingNote annotation={annotation} />
                )}

                {annotation?.kind === "mismatch" && (
                  <span className="inline-flex items-center gap-1.5 font-semibold text-[#b53800]">
                    <MismatchTriangleIcon size="xs" />
                    <span>
                      {annotation.unitWord} add to{" "}
                      <span className="font-mono tabular-nums">
                        {formatProofNumber(annotation.computedSum)}
                      </span>
                      , off by{" "}
                      <span className="font-mono tabular-nums">
                        {formatProofNumber(annotation.gap)}
                      </span>
                    </span>
                  </span>
                )}

                {!annotation &&
                  !isRebuiltHiddenRow &&
                  rowVisual === "recheck-disagrees" && (
                    <span
                      data-recheck-label="disagrees"
                      className="pl-3 font-semibold text-[#b91c1c]"
                    >
                      Needs your eye
                    </span>
                  )}

                {!annotation &&
                  !isRebuiltHiddenRow &&
                  rowVisual === "recheck-unsure" && (
                    <span
                      data-recheck-label="unsure"
                      className="pl-3 font-medium text-[#9a5b00]"
                    >
                      Needs your eye
                    </span>
                  )}

                {!annotation &&
                  !isRebuiltHiddenRow &&
                  rowVisual === "not-proven" && (
                    <span
                      data-recheck-label={
                        leftRecheck?.verdict === "agrees" ||
                        rightRecheck?.verdict === "agrees"
                          ? "agrees"
                          : undefined
                      }
                      className="pl-3 text-slate-500"
                    >
                      not proven
                    </span>
                  )}

                {!annotation &&
                  !isRebuiltHiddenRow &&
                  rowVisual === "unread" && (
                    <span className="pl-3 font-medium text-[#9a5b00]">
                      needs your eye
                    </span>
                  )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
