"use client";

import type {
  AddingGroup,
  CellProofStatus,
  MismatchedGroup,
  TwoColumnProof,
} from "@/lib/adding";
import type { RowComparison, StatementReadingResult } from "@/lib/reading";
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
};

export type ResultDisplayRow = ResultHeadingRow | ResultNumberRow;

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
    unread: [readRow.cells[0].hidden, readRow.cells[1].hidden],
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
    };

type BracketSegment = {
  kind: "proven" | "mismatch";
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

function getRowVisualStatus(
  leftStatus: CellProofStatus,
  rightStatus: CellProofStatus,
  isMismatchTotal: boolean,
): "proven" | "mismatch-total" | "mismatch-member" | "unread" | "not-proven" | "none" {
  if (leftStatus === "mismatch" || rightStatus === "mismatch") {
    return isMismatchTotal ? "mismatch-total" : "mismatch-member";
  }
  if (leftStatus === "unread" || rightStatus === "unread") {
    return "unread";
  }
  if (leftStatus === "not_proven" || rightStatus === "not_proven") {
    return "not-proven";
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
  source: "sec" | "saved" | "fixture";
  displayRows: ResultDisplayRow[];
  proof: TwoColumnProof;
};

export function ResultTable({
  statement,
  source,
  displayRows,
  proof,
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

  return (
    <section
      aria-label="Balance sheet proof"
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 text-xs text-slate-500 sm:px-6">
        <span>Proved from the reading</span>
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
                  <tr
                    key={`heading-${displayIdx}`}
                    data-row-kind="heading"
                  >
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
              );

              const leftBrokenTotal =
                annotation?.kind === "mismatch" && annotation.brokenCols[0];
              const rightBrokenTotal =
                annotation?.kind === "mismatch" && annotation.brokenCols[1];

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

              const showMobileSubRow =
                Boolean(annotation) ||
                rowVisual === "not-proven" ||
                rowVisual === "unread";

              return (
                <ResultRowGroup
                  key={`num-${idx}`}
                  row={row}
                  isTotal={isTotal}
                  numberBorderClass={numberBorderClass}
                  leftStatus={leftStatus}
                  rightStatus={rightStatus}
                  leftText={leftText}
                  rightText={rightText}
                  leftBrokenTotal={leftBrokenTotal}
                  rightBrokenTotal={rightBrokenTotal}
                  rowVisual={rowVisual}
                  annotation={annotation}
                  bracket={bracket}
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
  isTotal: boolean;
  numberBorderClass: string;
  leftStatus: CellProofStatus;
  rightStatus: CellProofStatus;
  leftText: string;
  rightText: string;
  leftBrokenTotal: boolean;
  rightBrokenTotal: boolean;
  rowVisual: ReturnType<typeof getRowVisualStatus>;
  annotation: GroupAnnotation | undefined;
  bracket: BracketSegment | undefined;
  showMobileSubRow: boolean;
};

function ResultRowGroup({
  row,
  isTotal,
  numberBorderClass,
  leftStatus,
  rightStatus,
  leftText,
  rightText,
  leftBrokenTotal,
  rightBrokenTotal,
  rowVisual,
  annotation,
  bracket,
  showMobileSubRow,
}: ResultRowGroupProps) {
  const indentClass =
    !isTotal && row.indent >= 1 ? "pl-3 sm:pl-5" : "pl-0";

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
          className={`whitespace-nowrap py-1.5 pl-1.5 text-right align-bottom font-mono text-[12px] tabular-nums sm:pl-3 sm:text-[13.5px] ${numberBorderClass} ${
            leftBrokenTotal
              ? "font-bold text-[#b53800]"
              : leftStatus === "unread"
                ? "font-sans text-xs font-medium text-[#9a5b00]"
                : leftStatus === "empty"
                  ? "text-slate-400"
                  : ""
          }`}
        >
          {leftText}
        </td>

        <td
          data-col="1"
          data-proof-status={rightStatus}
          className={`whitespace-nowrap py-1.5 pl-1.5 text-right align-bottom font-mono text-[12px] tabular-nums sm:pl-3 sm:text-[13.5px] ${numberBorderClass} ${
            rightBrokenTotal
              ? "font-bold text-[#b53800]"
              : rightStatus === "unread"
                ? "font-sans text-xs font-medium text-[#9a5b00]"
                : rightStatus === "empty"
                  ? "text-slate-400"
                  : ""
          }`}
        >
          {rightText}
        </td>

        <td className="py-1.5 pl-1.5 text-center align-bottom">
          <div className="flex items-center justify-center">
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
          </div>
        </td>

        <td className="relative hidden py-1.5 pl-4 align-bottom text-xs md:table-cell">
          {bracket && (
            <span
              data-proof-bracket={bracket.kind}
              aria-hidden="true"
              className={`pointer-events-none absolute left-1.5 w-[2px] ${
                bracket.kind === "mismatch" ? "bg-[#b53800]" : "bg-[#146c43]"
              } ${
                bracket.position === "start"
                  ? "top-2 bottom-0"
                  : bracket.position === "end"
                    ? "top-0 bottom-2"
                    : "top-0 bottom-0"
              }`}
            />
          )}

          {bracket?.sideNote && (
            <span className="font-semibold text-[#b53800]">
              {bracket.sideNote}
            </span>
          )}

          {annotation?.kind === "proven" && (
            <span className="inline-flex items-center gap-1.5 font-medium text-[#146c43]">
              <ProvenCheckIcon size="xs" />
              <span>
                {annotation.memberIndices.length} {annotation.unitWord} add to{" "}
                <span className="font-mono font-semibold tabular-nums">
                  {formatProofNumber(annotation.sum)}
                </span>
              </span>
            </span>
          )}

          {annotation?.kind === "mismatch" && (
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

          {!annotation && !bracket?.sideNote && rowVisual === "not-proven" && (
            <span className="text-slate-500">not proven</span>
          )}

          {!annotation && !bracket?.sideNote && rowVisual === "unread" && (
            <span className="font-medium text-[#9a5b00]">needs your eye</span>
          )}
        </td>
      </tr>

      {showMobileSubRow && (
        <tr className="md:hidden" data-mobile-proof-for={row.numberRowIndex}>
          <td colSpan={4} className="pt-0.5 pb-2.5 text-xs">
            {annotation?.kind === "proven" && (
              <span className="inline-flex items-center gap-1.5 font-medium text-[#146c43]">
                <ProvenCheckIcon size="xs" />
                <span>
                  {annotation.memberIndices.length} {annotation.unitWord} add to{" "}
                  <span className="font-mono font-semibold tabular-nums">
                    {formatProofNumber(annotation.sum)}
                  </span>
                </span>
              </span>
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

            {!annotation && rowVisual === "not-proven" && (
              <span className="pl-3 text-slate-500">not proven</span>
            )}

            {!annotation && rowVisual === "unread" && (
              <span className="pl-3 font-medium text-[#9a5b00]">
                needs your eye
              </span>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
