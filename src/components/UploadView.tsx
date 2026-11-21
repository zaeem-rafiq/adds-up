"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  buildResultDisplayRows,
  formatProofNumber,
  ResultTable,
  type ResultNumberRow,
  type SelectedCellRef,
  type TableMode,
} from "@/components/ResultTable";
import {
  canHideCell,
  CHANGE_NOT_CAUGHT_MESSAGE,
  parseChangedNumberInput,
  proveColumns,
  proveColumnsWithChange,
  proveColumnsWithHidden,
  type ChangedProofOutcome,
  type MismatchedGroup,
  type RebuildResult,
  type TwoColumnProof,
} from "@/lib/adding";
import { normalizeReadLabel } from "@/lib/merge-readings";
import type {
  ReadingProgressEvent,
  ReadRow,
  StatementReadingResult,
} from "@/lib/reading";
import type { Statement } from "@/lib/statements";
import { validateUploadFileMeta } from "@/lib/upload-validation";

const SMALL_NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];

function countWord(n: number): string {
  if (n >= 0 && n < SMALL_NUMBER_WORDS.length) {
    return SMALL_NUMBER_WORDS[n];
  }
  return String(n);
}

function stripLeadingTotal(label: string): string {
  const trimmed = label.trim();
  const stripped = trimmed.replace(/^total\s+/i, "").trim();
  if (!stripped) return trimmed || "This group";
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function formatMismatchGroupHeading(
  totalLabel: string,
  gap: number,
): { groupName: string; heading: string } {
  const groupName = stripLeadingTotal(totalLabel);
  const lower = groupName.toLowerCase();
  const isPlural = lower.endsWith("s") && !lower.endsWith("ss");
  const verb = isPlural ? "are" : "is";
  return {
    groupName,
    heading: `${groupName} ${verb} off by ${formatProofNumber(gap)}`,
  };
}

function formatCauseModelLabel(model: string | null): string {
  const lower = (model ?? "").toLowerCase();
  if (lower.includes("neon")) return "Neon's note";
  if (lower.includes("carbon")) return "Carbon's note";
  return "Model's note";
}

function pickInitialSelectedCell(
  proof: TwoColumnProof,
): SelectedCellRef | null {
  for (let i = 0; i < proof.left.cellStatuses.length; i += 1) {
    if (canHideCell(proof, i, 0).allowed) {
      return { rowIndex: i, colIndex: 0 };
    }
  }
  for (let i = 0; i < proof.right.cellStatuses.length; i += 1) {
    if (canHideCell(proof, i, 1).allowed) {
      return { rowIndex: i, colIndex: 1 };
    }
  }
  for (let i = 0; i < proof.left.cellStatuses.length; i += 1) {
    if (proof.left.cellStatuses[i] === "proven") {
      return { rowIndex: i, colIndex: 0 };
    }
  }
  for (let i = 0; i < proof.right.cellStatuses.length; i += 1) {
    if (proof.right.cellStatuses[i] === "proven") {
      return { rowIndex: i, colIndex: 1 };
    }
  }
  for (let i = 0; i < proof.left.cellStatuses.length; i += 1) {
    if (proof.left.cellStatuses[i] !== "empty") {
      return { rowIndex: i, colIndex: 0 };
    }
  }
  for (let i = 0; i < proof.right.cellStatuses.length; i += 1) {
    if (proof.right.cellStatuses[i] !== "empty") {
      return { rowIndex: i, colIndex: 1 };
    }
  }
  return null;
}

function GreenCheckIcon({ size = "md" }: { size?: "md" | "sm" }) {
  const cls = size === "sm" ? "h-4 w-4" : "mt-0.5 h-5 w-5";
  return (
    <svg
      className={`${cls} shrink-0 text-[#146c43]`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="9" />
      <path
        d="M6.4 10.3L8.8 12.7L13.8 7.5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[#1d4ea8]"
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

function PendingStepIcon() {
  return (
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 text-slate-400"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7.5" />
      <path d="M6.8 10H13.2" strokeLinecap="round" />
    </svg>
  );
}

function WarningTriangleIcon() {
  return (
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 text-[#b53800]"
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

function OutlineWarningTriangleIcon() {
  return (
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 text-[#9a3412]"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="M10 3.2L17.5 16.2H2.5L10 3.2Z" strokeLinejoin="round" />
      <path d="M10 8V11.5" strokeLinecap="round" />
      <circle cx="10" cy="14" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function UndoArrowIcon() {
  return (
    <svg
      className="h-4 w-4 shrink-0"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6.5 7.5L3.5 10.5L6.5 13.5" />
      <path d="M4 10.5H12.5A3.5 3.5 0 1 1 12.5 17.5H9" />
    </svg>
  );
}

async function readNdjsonStream(
  response: Response,
  onEvent: (event: ReadingProgressEvent) => void,
): Promise<boolean> {
  let receivedTerminal = false;

  const processLine = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    const event = JSON.parse(trimmed) as ReadingProgressEvent;
    if (
      event.type === "done" ||
      event.type === "bad_upload" ||
      event.type === "error"
    ) {
      receivedTerminal = true;
    }
    onEvent(event);
  };

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        processLine(rawLine);
      }
    }

    const remaining = (buffer + decoder.decode()).trim();
    if (remaining) {
      for (const rawLine of remaining.split("\n")) {
        processLine(rawLine);
      }
    }
  } else {
    const text = await response.text();
    for (const rawLine of text.split("\n")) {
      processLine(rawLine);
    }
  }

  return receivedTerminal;
}

type UploadPhase =
  | "loading"
  | "slow"
  | "timeout"
  | "bad_upload"
  | "done"
  | "error"
  | "stopped";

type ErrorCode = "timeout" | "rate_limit" | "missing_key" | "failed" | "not_found";

type ModState =
  | { kind: "none" }
  | { kind: "rehiding"; cell: SelectedCellRef; rowLabel: string }
  | {
      kind: "hidden";
      cell: SelectedCellRef;
      rowLabel: string;
      modPictureKey?: string;
    }
  | {
      kind: "rechanging";
      cell: SelectedCellRef;
      rowLabel: string;
      newValue: string;
    }
  | {
      kind: "changed";
      cell: SelectedCellRef;
      rowLabel: string;
      newValue: string;
      modPictureKey?: string;
    };

type HistoryEntry = {
  id: number;
  text: string;
  tone?: "normal" | "error";
};

/**
 * A hide or a change re-reads the picture with one reader. A number the two readers
 * disputed on the first reading stays NOT READ in that view, so it never gets a tick.
 */
function keepDisputedCells(
  base: StatementReadingResult,
  next: StatementReadingResult,
): StatementReadingResult {
  if (!base.rows.some((row) => row.cells.some((cell) => cell.disputed))) {
    return next;
  }
  const rows = next.rows.map((row, index): ReadRow => {
    const before = base.rows[index];
    if (
      !before ||
      normalizeReadLabel(before.label) !== normalizeReadLabel(row.label)
    ) {
      return row;
    }
    return {
      ...row,
      cells: [
        before.cells[0].disputed ? before.cells[0] : row.cells[0],
        before.cells[1].disputed ? before.cells[1] : row.cells[1],
      ],
    };
  });
  return { ...next, rows };
}

function makeUploadTableStatement(fileName: string): Statement {
  return {
    cik: "upload",
    companyName: "Your statement",
    form: "10-K",
    filingDate: "",
    title: "BALANCE SHEET",
    columns: ["Column 1", "Column 2"],
    unitLine: fileName,
    rows: [],
  };
}

export function UploadExpiredView() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleNextFile(file: File | null | undefined) {
    if (!file) return;
    setUploadError(null);
    const check = validateUploadFileMeta({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!check.ok) {
      setUploadError(check.message);
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const payload = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok || !payload.id) {
        setUploadError(
          payload.error ?? "Could not upload that file right now. Please try again.",
        );
        return;
      }
      router.push(`/upload/${encodeURIComponent(payload.id)}`);
    } catch {
      setUploadError("Could not upload that file right now. Please try again.");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="mx-auto max-w-[560px] py-8 text-center">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
        This uploaded statement is no longer in memory
      </h1>
      <p className="mt-2.5 text-sm text-slate-600 sm:text-base">
        Uploaded pictures stay in memory for one hour and are never saved to
        disk. Upload the picture again, or pick a company.
      </p>

      {uploadError && (
        <div
          role="alert"
          className="mt-5 flex items-start gap-2.5 rounded-xl bg-[#fceee5] px-4 py-3 text-left text-sm font-medium text-[#7c2d12]"
        >
          <OutlineWarningTriangleIcon />
          <span>{uploadError}</span>
        </div>
      )}

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
        <div className="rounded-xl border border-dashed border-slate-300 px-5 py-7">
          <p className="text-sm text-slate-600">
            Drop a picture of one page here
          </p>
          <input
            ref={fileInputRef}
            type="file"
            aria-hidden="true"
            tabIndex={-1}
            accept=".png,.jpg,.jpeg,image/png,image/jpeg"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void handleNextFile(file);
            }}
          />
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-[#1d4ea8] px-4 py-2 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isUploading ? "Uploading..." : "Choose a file"}
            </button>
            <Link
              href="/"
              prefetch={false}
              className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              Pick a company
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

type UploadViewProps = {
  uploadId: string;
  fileName: string;
  pictureUrl: string;
  slowMode?: boolean;
};

export function UploadView({
  uploadId,
  fileName,
  pictureUrl,
  slowMode = false,
}: UploadViewProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<UploadPhase>("loading");
  const [baseResult, setBaseResult] = useState<StatementReadingResult | null>(
    null,
  );
  const [activeResult, setActiveResult] =
    useState<StatementReadingResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);

  const [isUploadingNext, setIsUploadingNext] = useState(false);
  const [nextUploadError, setNextUploadError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [selectedCell, setSelectedCell] = useState<SelectedCellRef | null>(
    null,
  );
  const [modState, setModState] = useState<ModState>({ kind: "none" });
  const [hideRefusal, setHideRefusal] = useState<string | null>(null);
  const [changeFormOpen, setChangeFormOpen] = useState(false);
  const [changeInput, setChangeInput] = useState("");
  const [changeInputError, setChangeInputError] = useState<string | null>(null);
  const [modError, setModError] = useState<string | null>(null);
  const [causeSentence, setCauseSentence] = useState<string | null>(null);
  const [causeModel, setCauseModel] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const nextHistoryIdRef = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const modAbortRef = useRef<AbortController | null>(null);
  const causeAbortRef = useRef<AbortController | null>(null);

  const [runState, setRunState] = useState<{
    runId: number;
    useSlowQuery: boolean;
  }>({ runId: 0, useSlowQuery: slowMode });

  const uploadStatement = useMemo(
    () => makeUploadTableStatement(fileName),
    [fileName],
  );

  const appendHistory = (text: string, tone: "normal" | "error" = "normal") => {
    const id = nextHistoryIdRef.current;
    nextHistoryIdRef.current += 1;
    setHistory((prev) => [...prev, { id, text, tone }]);
  };

  async function uploadAnotherFile(file: File | null | undefined) {
    if (!file) return;
    setNextUploadError(null);

    const validation = validateUploadFileMeta({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!validation.ok) {
      setNextUploadError(validation.message);
      return;
    }

    setIsUploadingNext(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!response.ok || !payload.id) {
        setNextUploadError(
          payload.error ?? "Could not upload that file right now. Please try again.",
        );
        return;
      }
      router.push(`/upload/${encodeURIComponent(payload.id)}`);
    } catch {
      setNextUploadError("Could not upload that file right now. Please try again.");
    } finally {
      setIsUploadingNext(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    void uploadAnotherFile(file);
  }

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    const readUrl = `/api/upload/${encodeURIComponent(uploadId)}/read${
      runState.useSlowQuery ? "?slow=1" : ""
    }`;

    const applyEvent = (event: ReadingProgressEvent) => {
      if (controller.signal.aborted) return;
      if (event.type === "slow") {
        setPhase("slow");
      } else if (event.type === "bad_upload") {
        setBaseResult(null);
        setActiveResult(null);
        setPhase("bad_upload");
      } else if (event.type === "done") {
        setBaseResult(event.result);
        setActiveResult(event.result);
        setModState({ kind: "none" });
        setHideRefusal(null);
        setChangeFormOpen(false);
        setChangeInputError(null);
        setModError(null);
        setCauseSentence(null);
        setCauseModel(null);

        const displayRows = buildResultDisplayRows(uploadStatement, event.result);
        const numberRows = displayRows.filter(
          (row): row is ResultNumberRow => row.kind === "number",
        );
        const initialProof = proveColumns(
          numberRows.map((r) => r.numbers[0]),
          numberRows.map((r) => r.numbers[1]),
          { unreadMask: numberRows.map((r) => r.unread) },
        );
        setSelectedCell(pickInitialSelectedCell(initialProof));

        const readCount =
          event.result.comparison.readCount || initialProof.counts.total;
        const initialEntries: HistoryEntry[] = [
          { id: 1, text: `Read the page: ${readCount} numbers.` },
        ];
        nextHistoryIdRef.current = 2;
        setHistory(initialEntries);
        setPhase("done");
      } else if (event.type === "error") {
        setErrorCode(event.code);
        setErrorMessage(event.message);
        setPhase(event.code === "timeout" ? "timeout" : "error");
      }
    };

    const run = async () => {
      try {
        const response = await fetch(readUrl, {
          method: "POST",
          headers: { Accept: "application/x-ndjson" },
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        if (!response.ok) {
          let message = "Could not read this uploaded picture right now.";
          let code: ErrorCode = "failed";
          try {
            const payload = (await response.json()) as {
              error?: string;
              code?: ErrorCode;
            };
            if (payload.error) message = payload.error;
            if (payload.code) code = payload.code;
          } catch {
            // Keep default message.
          }

          if (controller.signal.aborted) return;
          setErrorCode(code);
          setErrorMessage(message);
          setPhase(code === "timeout" ? "timeout" : "error");
          return;
        }

        const receivedTerminal = await readNdjsonStream(response, applyEvent);
        if (!receivedTerminal && !controller.signal.aborted) {
          setErrorCode("failed");
          setErrorMessage(
            "Reading ended before the server returned an answer.",
          );
          setPhase("error");
        }
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        setErrorCode("failed");
        setErrorMessage("Could not read this uploaded picture right now.");
        setPhase("error");
      }
    };

    void run();

    return () => {
      controller.abort();
      modAbortRef.current?.abort();
      causeAbortRef.current?.abort();
    };
  }, [runState, uploadId, uploadStatement]);

  const handleStop = () => {
    abortRef.current?.abort();
    setPhase("stopped");
  };

  const handleStopModification = () => {
    modAbortRef.current?.abort();
    causeAbortRef.current?.abort();
    setModState({ kind: "none" });
    setActiveResult(baseResult);
    setModError(null);
  };

  const handleRetry = () => {
    abortRef.current?.abort();
    modAbortRef.current?.abort();
    causeAbortRef.current?.abort();
    setPhase("loading");
    setBaseResult(null);
    setActiveResult(null);
    setSelectedCell(null);
    setModState({ kind: "none" });
    setHideRefusal(null);
    setChangeFormOpen(false);
    setChangeInputError(null);
    setModError(null);
    setCauseSentence(null);
    setCauseModel(null);
    setHistory([]);
    setErrorMessage(null);
    setErrorCode(null);
    setRunState((prev) => ({ runId: prev.runId + 1, useSlowQuery: false }));
  };

  const handleUndoToUnchanged = (keepSelected?: SelectedCellRef) => {
    modAbortRef.current?.abort();
    causeAbortRef.current?.abort();
    setModState({ kind: "none" });
    setActiveResult(baseResult);
    setHideRefusal(null);
    setChangeFormOpen(false);
    setChangeInputError(null);
    setModError(null);
    setCauseSentence(null);
    setCauseModel(null);
    if (keepSelected) {
      setSelectedCell(keepSelected);
    }
  };

  const baseProof = useMemo(() => {
    if (!baseResult) return null;
    const displayRows = buildResultDisplayRows(uploadStatement, baseResult);
    const numberRows = displayRows.filter(
      (row): row is ResultNumberRow => row.kind === "number",
    );
    return proveColumns(
      numberRows.map((row) => row.numbers[0]),
      numberRows.map((row) => row.numbers[1]),
      { unreadMask: numberRows.map((row) => row.unread) },
    );
  }, [baseResult, uploadStatement]);

  const provenModel = useMemo(() => {
    if (!activeResult) return null;
    const displayRows = buildResultDisplayRows(uploadStatement, activeResult);
    const numberRows = displayRows.filter(
      (row): row is ResultNumberRow => row.kind === "number",
    );
    const leftColumn = numberRows.map((row) => row.numbers[0]);
    const rightColumn = numberRows.map((row) => row.numbers[1]);
    const unreadMask = numberRows.map((row) => row.unread);

    let proof: TwoColumnProof;
    let rebuild: RebuildResult | null = null;
    let changeOutcome: ChangedProofOutcome | null = null;

    if (modState.kind === "hidden") {
      const targetCell = modState.cell;
      const targetRow = numberRows[targetCell.rowIndex];
      const cellIsHiddenInReading =
        targetRow !== undefined &&
        (targetRow.hidden[targetCell.colIndex] ||
          targetRow.numbers[targetCell.colIndex] === null);

      if (cellIsHiddenInReading) {
        const hiddenOutcome = proveColumnsWithHidden(
          leftColumn,
          rightColumn,
          targetCell,
          { unreadMask },
        );
        proof = hiddenOutcome.proof;
        rebuild = hiddenOutcome.rebuild;
      } else {
        proof = proveColumns(leftColumn, rightColumn, { unreadMask });
        rebuild = {
          status: "cannot_rebuild",
          rowIndex: targetCell.rowIndex,
          colIndex: targetCell.colIndex,
          reason:
            "The model did not report a covered cell in the picture, so the number was not rebuilt.",
          ways: [],
          agreed: false,
        };
      }
    } else if (modState.kind === "changed" && baseProof) {
      changeOutcome = proveColumnsWithChange(
        baseProof,
        leftColumn,
        rightColumn,
        modState.cell,
        { unreadMask },
      );
      proof = changeOutcome.proof;
    } else {
      proof = proveColumns(leftColumn, rightColumn, { unreadMask });
    }

    const allMismatches = [...proof.left.mismatches, ...proof.right.mismatches];
    let mismatchCellCount = 0;
    let unreadCellCount = 0;
    for (const status of [
      ...proof.left.cellStatuses,
      ...proof.right.cellStatuses,
    ]) {
      if (status === "mismatch") mismatchCellCount += 1;
      else if (status === "unread") unreadCellCount += 1;
    }

    return {
      displayRows,
      numberRows,
      proof,
      rebuild,
      changeOutcome,
      allMismatches,
      mismatchCellCount,
      unreadCellCount,
    };
  }, [activeResult, baseProof, modState, uploadStatement]);

  // Primary mismatch for the changed screen: ONLY an earlier group of the
  // changed column that contains the changed row and failed with the new reading.
  const primaryChangedMismatch = useMemo((): {
    mismatch: MismatchedGroup;
    colIndex: 0 | 1;
    totalLabel: string;
    groupName: string;
    heading: string;
  } | null => {
    if (!provenModel || modState.kind !== "changed") return null;
    const chosen = provenModel.changeOutcome?.caughtMismatches[0] ?? null;
    if (!chosen) return null;
    const totalLabel =
      provenModel.numberRows[chosen.totalIndex]?.label ?? "This group";
    const { groupName, heading } = formatMismatchGroupHeading(
      totalLabel,
      chosen.gap,
    );

    return {
      mismatch: chosen,
      colIndex: modState.cell.colIndex,
      totalLabel,
      groupName,
      heading,
    };
  }, [modState, provenModel]);

  const handleSelectCell = (cell: SelectedCellRef) => {
    setSelectedCell(cell);
    setHideRefusal(null);
    setChangeFormOpen(false);
    setChangeInputError(null);
    setModError(null);
  };

  const handleOpenChangeForm = (cell: SelectedCellRef) => {
    if (!provenModel || !baseProof) return;

    // A number that cannot be hidden also cannot be changed, with the same reason.
    const check = canHideCell(baseProof, cell.rowIndex, cell.colIndex);
    if (!check.allowed) {
      setSelectedCell(cell);
      setChangeFormOpen(false);
      setChangeInputError(null);
      setModError(null);
      setHideRefusal(check.reason);
      return;
    }

    setSelectedCell(cell);
    setHideRefusal(null);
    setModError(null);
    setChangeInputError(null);
    const row = provenModel.numberRows[cell.rowIndex];
    const currentText =
      row?.rawValues[cell.colIndex]?.replace(/^\$\s*/, "") ??
      (row?.numbers[cell.colIndex] !== null &&
      row?.numbers[cell.colIndex] !== undefined
        ? formatProofNumber(row.numbers[cell.colIndex]!)
        : "");
    setChangeInput(currentText);
    setChangeFormOpen(true);
  };

  const handleStartHide = async (cell: SelectedCellRef) => {
    if (!provenModel || !baseResult || !baseProof) return;

    // Refuse immediately with NO model call if the cell cannot be rebuilt.
    const check = canHideCell(baseProof, cell.rowIndex, cell.colIndex);
    if (!check.allowed) {
      setSelectedCell(cell);
      setChangeFormOpen(false);
      setChangeInputError(null);
      setHideRefusal(check.reason);
      return;
    }

    const row = provenModel.numberRows[cell.rowIndex];
    const rowLabel = row?.label ?? "this number";
    const printedValue =
      row?.rawValues[cell.colIndex] ??
      (row?.numbers[cell.colIndex] !== null &&
      row?.numbers[cell.colIndex] !== undefined
        ? formatProofNumber(row.numbers[cell.colIndex]!)
        : "");

    setSelectedCell(cell);
    setHideRefusal(null);
    setChangeFormOpen(false);
    setChangeInputError(null);
    setModError(null);
    setCauseSentence(null);
    setCauseModel(null);

    modAbortRef.current?.abort();
    causeAbortRef.current?.abort();
    const controller = new AbortController();
    modAbortRef.current = controller;

    setModState({ kind: "rehiding", cell, rowLabel });
    appendHistory(`You hid ${rowLabel}.`);

    try {
      const response = await fetch(
        `/api/upload/${encodeURIComponent(uploadId)}/modify`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify({
            action: "hide",
            numberRowIndex: cell.rowIndex,
            colIndex: cell.colIndex,
            rowLabel,
            printedValue,
          }),
          signal: controller.signal,
        },
      );

      if (controller.signal.aborted) return;

      if (!response.ok) {
        let message = "Could not hide that number right now.";
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) message = payload.error;
        } catch {
          // Keep default message.
        }
        setModState({ kind: "none" });
        setModError(message);
        return;
      }

      let modResult: StatementReadingResult | null = null;
      let modPictureKey: string | undefined;
      let streamError: string | null = null;

      await readNdjsonStream(response, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "done") {
          modResult = event.result;
          modPictureKey = event.modPictureKey;
        } else if (event.type === "error") {
          streamError = event.message;
        }
      });

      if (controller.signal.aborted) return;

      if (streamError) {
        setModState({ kind: "none" });
        setModError(streamError);
        return;
      }

      if (!modResult) {
        setModState({ kind: "none" });
        setModError("Reading ended before the server returned an answer.");
        return;
      }

      const finalResult = keepDisputedCells(baseResult, modResult);
      const nextDisplayRows = buildResultDisplayRows(uploadStatement, finalResult);
      const nextNumberRows = nextDisplayRows.filter(
        (r): r is ResultNumberRow => r.kind === "number",
      );
      const nextTargetRow = nextNumberRows[cell.rowIndex];
      const hasHidden =
        nextTargetRow !== undefined &&
        (nextTargetRow.hidden[cell.colIndex] ||
          nextTargetRow.numbers[cell.colIndex] === null);

      if (hasHidden) {
        const { rebuild } = proveColumnsWithHidden(
          nextNumberRows.map((r) => r.numbers[0]),
          nextNumberRows.map((r) => r.numbers[1]),
          cell,
          { unreadMask: nextNumberRows.map((r) => r.unread) },
        );
        if (rebuild.status === "rebuilt") {
          const primaryWay = rebuild.ways[0];
          const fromLabel =
            primaryWay?.kind === "sum_of_members"
              ? "from the lines."
              : "from the total.";
          appendHistory(
            `Rebuilt ${formatProofNumber(rebuild.value)} ${fromLabel}`,
          );
        } else {
          appendHistory(`Could not rebuild ${rowLabel}.`, "error");
        }
      } else {
        appendHistory(`Could not rebuild ${rowLabel}.`, "error");
      }

      setActiveResult(finalResult);
      setModState({ kind: "hidden", cell, rowLabel, modPictureKey });
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      setModState({ kind: "none" });
      setModError("Could not read the page with your number hidden right now.");
    }
  };

  const fetchCauseAsync = (params: {
    groupLabel: string;
    rows: Array<{ label: string; value: string; number: number }>;
    statedTotal: number;
    computedSum: number;
    gap: number;
    diff: number;
  }) => {
    causeAbortRef.current?.abort();
    const controller = new AbortController();
    causeAbortRef.current = controller;

    void fetch(`/api/upload/${encodeURIComponent(uploadId)}/cause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok || controller.signal.aborted) return;
        const payload = (await res.json()) as {
          sentence?: string | null;
          model?: string | null;
        };
        if (controller.signal.aborted) return;
        if (payload.sentence && payload.sentence.trim()) {
          setCauseSentence(payload.sentence.trim());
          setCauseModel(payload.model ?? null);
        }
      })
      .catch(() => {
        // Silent on cause failure.
      });
  };

  const handleSubmitChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedCell || !provenModel || !baseResult || !baseProof) return;

    const check = canHideCell(
      baseProof,
      selectedCell.rowIndex,
      selectedCell.colIndex,
    );
    if (!check.allowed) {
      setChangeFormOpen(false);
      setChangeInputError(null);
      setHideRefusal(check.reason);
      return;
    }

    const parsed = parseChangedNumberInput(changeInput);
    if (!parsed.ok) {
      setChangeInputError(parsed.error);
      return;
    }

    const cell = selectedCell;
    const row = provenModel.numberRows[cell.rowIndex];
    const rowLabel = row?.label ?? "this number";
    const printedValue =
      row?.rawValues[cell.colIndex] ??
      (row?.numbers[cell.colIndex] !== null &&
      row?.numbers[cell.colIndex] !== undefined
        ? formatProofNumber(row.numbers[cell.colIndex]!)
        : "");

    setChangeFormOpen(false);
    setChangeInputError(null);
    setHideRefusal(null);
    setModError(null);
    setCauseSentence(null);
    setCauseModel(null);

    modAbortRef.current?.abort();
    causeAbortRef.current?.abort();
    const controller = new AbortController();
    modAbortRef.current = controller;

    setModState({
      kind: "rechanging",
      cell,
      rowLabel,
      newValue: parsed.formatted,
    });
    appendHistory(`You changed ${rowLabel}.`);

    try {
      const response = await fetch(
        `/api/upload/${encodeURIComponent(uploadId)}/modify`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/x-ndjson",
          },
          body: JSON.stringify({
            action: "change",
            numberRowIndex: cell.rowIndex,
            colIndex: cell.colIndex,
            rowLabel,
            printedValue,
            newValue: parsed.formatted,
          }),
          signal: controller.signal,
        },
      );

      if (controller.signal.aborted) return;

      if (!response.ok) {
        let message = "Could not apply that change right now.";
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) message = payload.error;
        } catch {
          // Keep default message.
        }
        setModState({ kind: "none" });
        setModError(message);
        return;
      }

      let modResult: StatementReadingResult | null = null;
      let modPictureKey: string | undefined;
      let streamError: string | null = null;

      await readNdjsonStream(response, (ev) => {
        if (controller.signal.aborted) return;
        if (ev.type === "done") {
          modResult = ev.result;
          modPictureKey = ev.modPictureKey;
        } else if (ev.type === "error") {
          streamError = ev.message;
        }
      });

      if (controller.signal.aborted) return;

      if (streamError) {
        setModState({ kind: "none" });
        setModError(streamError);
        return;
      }

      if (!modResult) {
        setModState({ kind: "none" });
        setModError("Reading ended before the server returned an answer.");
        return;
      }

      const finalResult = keepDisputedCells(baseResult, modResult);
      const nextDisplayRows = buildResultDisplayRows(uploadStatement, finalResult);
      const nextNumberRows = nextDisplayRows.filter(
        (r): r is ResultNumberRow => r.kind === "number",
      );
      const changeOutcome = proveColumnsWithChange(
        baseProof,
        nextNumberRows.map((r) => r.numbers[0]),
        nextNumberRows.map((r) => r.numbers[1]),
        cell,
        { unreadMask: nextNumberRows.map((r) => r.unread) },
      );

      const targetMismatch = changeOutcome.caughtMismatches[0] ?? null;

      setActiveResult(finalResult);
      setModState({
        kind: "changed",
        cell,
        rowLabel,
        newValue: parsed.formatted,
        modPictureKey,
      });

      if (targetMismatch) {
        const chosenCol: 0 | 1 = cell.colIndex;
        const totalLabel =
          nextNumberRows[targetMismatch.totalIndex]?.label ?? "This group";
        const { groupName } = formatMismatchGroupHeading(
          totalLabel,
          targetMismatch.gap,
        );
        appendHistory(`${groupName} stopped adding up.`, "error");

        const groupRows = targetMismatch.memberIndices
          .map((idx) => {
            const memberRow = nextNumberRows[idx];
            if (!memberRow) return null;
            const num = memberRow.numbers[chosenCol];
            if (num === null) return null;
            return {
              label: memberRow.label,
              value: memberRow.rawValues[chosenCol] || formatProofNumber(num),
              number: num,
            };
          })
          .filter(
            (r): r is { label: string; value: string; number: number } =>
              r !== null,
          );

        if (groupRows.length > 0) {
          fetchCauseAsync({
            groupLabel: totalLabel,
            rows: groupRows,
            statedTotal: targetMismatch.printedTotal,
            computedSum: targetMismatch.computedSum,
            gap: targetMismatch.gap,
            diff: targetMismatch.diff,
          });
        }
      } else {
        appendHistory(CHANGE_NOT_CAUGHT_MESSAGE);
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      setModState({ kind: "none" });
      setModError("Could not read the changed balance sheet right now.");
    }
  };

  const hiddenFileInput = (
    <input
      ref={fileInputRef}
      type="file"
      aria-hidden="true"
      tabIndex={-1}
      data-upload-input="true"
      accept=".png,.jpg,.jpeg,image/png,image/jpeg"
      className="sr-only"
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        void uploadAnotherFile(file);
      }}
    />
  );

  // Bad upload screen (design/desktop-badupload.png & design/phone-badupload.png)
  if (phase === "bad_upload") {
    return (
      <div
        data-bad-upload="true"
        className="mx-auto max-w-[600px] py-8 text-center sm:py-12"
      >
        {hiddenFileInput}
        <h1 className="text-[28px] font-bold leading-tight tracking-tight text-slate-900 sm:text-[34px]">
          We could not find a statement in this file
        </h1>
        <p className="mt-2.5 break-words text-sm text-slate-600 sm:text-base">
          {fileName} · uploaded just now
        </p>

        <div
          role="status"
          className="mx-auto mt-6 inline-flex max-w-full items-start gap-2.5 rounded-xl bg-[#fceee5] px-4 py-3 text-left text-sm font-medium text-[#7c2d12]"
        >
          <OutlineWarningTriangleIcon />
          <span>
            Use one picture, PNG or JPEG, that shows a single balance sheet.
          </span>
        </div>

        {nextUploadError && (
          <div
            role="alert"
            data-upload-error="true"
            className="mx-auto mt-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm font-medium text-red-900"
          >
            <span>{nextUploadError}</span>
          </div>
        )}

        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`rounded-xl border border-dashed px-5 py-8 transition-colors ${
              isDragging
                ? "border-[#1d4ea8] bg-blue-50/40"
                : "border-slate-300 bg-white"
            }`}
          >
            <p className="text-sm text-slate-600">
              Drop a picture of one page here
            </p>
            <div className="mt-4 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
              <button
                type="button"
                disabled={isUploadingNext}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex w-full cursor-pointer items-center justify-center rounded-lg bg-[#1d4ea8] px-5 py-2.5 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
              >
                {isUploadingNext ? "Uploading..." : "Choose a file"}
              </button>
              <Link
                href="/"
                prefetch={false}
                className="inline-flex w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8] sm:w-auto"
              >
                Pick a company
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isModifying =
    modState.kind === "rehiding" || modState.kind === "rechanging";
  const isModifiedResult =
    modState.kind === "hidden" || modState.kind === "changed";
  const showSidebar =
    phase === "loading" ||
    phase === "slow" ||
    phase === "timeout" ||
    (phase === "done" && provenModel !== null);

  const activePictureUrl =
    (modState.kind === "hidden" || modState.kind === "changed") &&
    modState.modPictureKey
      ? `${pictureUrl}${pictureUrl.includes("?") ? "&" : "?"}mod=${encodeURIComponent(modState.modPictureKey)}`
      : pictureUrl;

  const verdictCounts = provenModel
    ? {
        proven: provenModel.proof.counts.proven,
        needYourEye: provenModel.proof.counts.needYourEye,
        notProven: provenModel.proof.counts.notProven,
        total: provenModel.proof.counts.total,
        redCount: provenModel.mismatchCellCount,
        amberCount: provenModel.unreadCellCount,
      }
    : null;

  const verdictHeadline = (() => {
    if (!provenModel || !verdictCounts) return null;
    const { rebuild, allMismatches } = provenModel;
    const { proven, needYourEye, total } = verdictCounts;

    if (modState.kind === "hidden") {
      if (rebuild?.status === "rebuilt") {
        return {
          text: `Rebuilt: ${formatProofNumber(rebuild.value)}`,
          colorClass: "text-[#146c43]",
        };
      }
      return {
        text: "Could not rebuild the hidden number",
        colorClass: "text-[#b53800]",
      };
    }

    if (modState.kind === "changed") {
      if (primaryChangedMismatch) {
        return {
          text: primaryChangedMismatch.heading,
          colorClass: "text-[#b53800]",
        };
      }
      return {
        text: CHANGE_NOT_CAUGHT_MESSAGE,
        colorClass: "text-[#9a5b00]",
      };
    }

    if (allMismatches.length === 1) {
      return {
        text: "One group does not add up",
        colorClass: "text-[#b53800]",
      };
    }
    if (allMismatches.length > 1) {
      return {
        text: `${allMismatches.length} groups do not add up`,
        colorClass: "text-[#b53800]",
      };
    }
    if (needYourEye > 0) {
      return {
        text: `${needYourEye} ${
          needYourEye === 1 ? "number needs" : "numbers need"
        } your eye`,
        colorClass: "text-[#9a5b00]",
      };
    }
    return {
      text: `${proven} of ${total} numbers proven`,
      colorClass: proven > 0 ? "text-[#146c43]" : "text-slate-900",
    };
  })();

  const provenPct =
    verdictCounts && verdictCounts.total > 0
      ? (verdictCounts.proven / verdictCounts.total) * 100
      : 0;
  const mismatchPct =
    verdictCounts && verdictCounts.total > 0
      ? (verdictCounts.redCount / verdictCounts.total) * 100
      : 0;
  const unreadPct =
    verdictCounts && verdictCounts.total > 0
      ? (verdictCounts.amberCount / verdictCounts.total) * 100
      : 0;

  const tableMode: TableMode =
    modState.kind === "rehiding"
      ? "rehide"
      : modState.kind === "hidden"
        ? "hidden"
        : modState.kind === "rechanging"
          ? "rechange"
          : modState.kind === "changed"
            ? "changed"
            : "normal";

  const selectedCellInfo = (() => {
    if (!selectedCell || !provenModel) return null;
    const row = provenModel.numberRows[selectedCell.rowIndex];
    if (!row) return null;
    const col = selectedCell.colIndex;
    const status =
      (col === 0
        ? provenModel.proof.left.cellStatuses[selectedCell.rowIndex]
        : provenModel.proof.right.cellStatuses[selectedCell.rowIndex]) ??
      "not_proven";
    const colGroups =
      col === 0 ? provenModel.proof.left.groups : provenModel.proof.right.groups;
    const containingGroup = colGroups.find((g) =>
      g.memberIndices.includes(selectedCell.rowIndex),
    );
    const totalGroup = colGroups.find(
      (g) => g.totalIndex === selectedCell.rowIndex,
    );
    const containingTotalLabel = containingGroup
      ? provenModel.numberRows[containingGroup.totalIndex]?.label
      : null;

    const formattedValue =
      row.rawValues[col] ||
      (row.numbers[col] !== null ? formatProofNumber(row.numbers[col]!) : "—");

    return {
      cell: selectedCell,
      row,
      columnHeading: uploadStatement.columns[col],
      status,
      containingTotalLabel,
      totalGroup,
      formattedValue,
      disputed: row.disputed?.[col] ?? null,
    };
  })();

  const hiddenCountNote = (() => {
    if (modState.kind !== "hidden" || !provenModel) return null;
    const total = provenModel.proof.counts.total;
    if (provenModel.rebuild?.status === "rebuilt") {
      return `${Math.max(0, total - 1)} read, 1 rebuilt`;
    }
    return `${Math.max(0, total - 1)} read, 1 hidden`;
  })();

  const pictureCardHeader =
    modState.kind === "rehiding" || modState.kind === "hidden"
      ? "Uploaded picture, with your number hidden"
      : modState.kind === "rechanging" || modState.kind === "changed"
        ? "Uploaded picture, with your change"
        : "Picture sent to the models";

  return (
    <div className="space-y-4">
      {hiddenFileInput}

      {nextUploadError && (
        <div
          role="alert"
          data-upload-error="true"
          className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-[#fceee5] px-5 py-3.5 text-sm text-[#7c2d12] sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2.5">
            <OutlineWarningTriangleIcon />
            <p className="font-medium">{nextUploadError}</p>
          </div>
          <button
            type="button"
            onClick={() => setNextUploadError(null)}
            className="w-fit shrink-0 cursor-pointer rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-[#7c2d12] hover:bg-amber-50"
          >
            Dismiss
          </button>
        </div>
      )}

      <section
        aria-label="Statement verdict"
        className="rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-2xs sm:px-6"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
          <div className="min-w-0 lg:max-w-[260px]">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              Your statement
            </h1>
            <p className="mt-1 break-words text-sm text-slate-600">
              {fileName} · uploaded just now
            </p>
          </div>

          {phase === "loading" && (
            <div className="min-w-0 flex-1" role="status" aria-live="polite">
              <p className="text-2xl font-bold tracking-tight text-slate-900 sm:text-[28px]">
                Reading your statement
              </p>
              <div
                className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200"
                role="progressbar"
                aria-label="Reading progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={30}
              >
                <div
                  className="h-full rounded-full bg-[#146c43] transition-all duration-300"
                  style={{ width: "30%" }}
                />
              </div>
              <p className="mt-2 text-xs text-slate-500 sm:text-sm">
                Hydrogen is reading the uploaded picture. This takes a few
                seconds.
              </p>
            </div>
          )}

          {(phase === "slow" || phase === "timeout") && (
            <div className="min-w-0 flex-1" role="alert">
              <p className="text-2xl font-bold tracking-tight text-[#b53800] sm:text-[28px]">
                {phase === "timeout"
                  ? "Stopped: reading took too long"
                  : "Reading took too long"}
              </p>
              <p className="mt-2 text-xs text-slate-600 sm:text-sm">
                {phase === "timeout"
                  ? "A model did not answer within 12 seconds. Nothing was guessed."
                  : "A model did not answer within 12 seconds. Trying once more. Nothing was guessed."}
              </p>
            </div>
          )}

          {phase === "stopped" && (
            <div className="min-w-0 flex-1" role="status">
              <p className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
                Reading stopped
              </p>
              <p className="mt-1 text-xs text-slate-600 sm:text-sm">
                Nothing was guessed.
              </p>
            </div>
          )}

          {phase === "error" && errorMessage && (
            <div className="min-w-0 flex-1" role="alert">
              <p className="text-2xl font-bold tracking-tight text-[#b53800] sm:text-[28px]">
                {errorCode === "rate_limit"
                  ? "Reading limit reached"
                  : errorCode === "missing_key"
                    ? "Reading is unavailable"
                    : "Could not read this statement"}
              </p>
              <p className="mt-2 text-xs text-slate-700 sm:text-sm">
                {errorMessage}
              </p>
              <p className="mt-1 text-xs text-slate-500 sm:text-sm">
                Nothing was guessed.
              </p>
            </div>
          )}

          {phase === "done" && modState.kind === "rehiding" && (
            <div className="min-w-0 flex-1" role="status" aria-live="polite">
              <p className="text-2xl font-bold tracking-tight text-slate-900 sm:text-[28px]">
                Reading the page with your number hidden
              </p>
              <p className="mt-2 text-xs text-slate-600 sm:text-sm">
                The models get only the new picture. This takes a few seconds.
              </p>
            </div>
          )}

          {phase === "done" && modState.kind === "rechanging" && (
            <div className="min-w-0 flex-1" role="status" aria-live="polite">
              <p className="text-2xl font-bold tracking-tight text-slate-900 sm:text-[28px]">
                Reading the changed page
              </p>
              <p className="mt-2 text-xs text-slate-600 sm:text-sm">
                The models get only the new picture. This takes a few seconds.
              </p>
            </div>
          )}

          {phase === "done" &&
            !isModifying &&
            activeResult &&
            provenModel &&
            verdictHeadline && (
              <div
                className="min-w-0 flex-1"
                role="status"
                aria-live="polite"
                data-verdict-band="true"
              >
                <p
                  className={`text-2xl font-bold tracking-tight sm:text-[28px] ${verdictHeadline.colorClass}`}
                >
                  {verdictHeadline.text}
                </p>

                <div
                  className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-slate-200"
                  aria-hidden="true"
                >
                  {provenPct > 0 && (
                    <div
                      className="h-full bg-[#146c43]"
                      style={{ width: `${provenPct}%` }}
                    />
                  )}
                  {mismatchPct > 0 && (
                    <div
                      className="h-full bg-[#b53800]"
                      style={{ width: `${mismatchPct}%` }}
                    />
                  )}
                  {unreadPct > 0 && (
                    <div
                      className="h-full bg-[#c27803]"
                      style={{ width: `${unreadPct}%` }}
                    />
                  )}
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 sm:text-[13px]">
                  <span data-count="proven">
                    <strong className="font-bold text-slate-900">
                      {verdictCounts?.proven ?? 0}
                    </strong>{" "}
                    proven
                  </span>
                  <span data-count="need-your-eye">
                    <strong className="font-bold text-slate-900">
                      {verdictCounts?.needYourEye ?? 0}
                    </strong>{" "}
                    need your eye
                  </span>
                  <span data-count="not-proven">
                    <strong className="font-bold text-slate-900">
                      {verdictCounts?.notProven ?? 0}
                    </strong>{" "}
                    not proven
                  </span>
                  {hiddenCountNote && (
                    <span data-hidden-summary="true">{hiddenCountNote}</span>
                  )}
                  {modState.kind === "changed" ? (
                    primaryChangedMismatch && (
                      <span data-verdict-gap="true">
                        Gap:{" "}
                        {formatProofNumber(primaryChangedMismatch.mismatch.gap)}
                      </span>
                    )
                  ) : (
                    provenModel.allMismatches.length === 1 && (
                      <span data-verdict-gap="true">
                        Gap:{" "}
                        {formatProofNumber(provenModel.allMismatches[0].gap)}
                      </span>
                    )
                  )}
                </div>

                {modState.kind === "none" &&
                  activeResult.crossCheck &&
                  activeResult.crossCheck.disputedCount > 0 && (
                    <p
                      data-disputed-note="true"
                      className="mt-2 text-xs font-medium text-[#9a5b00] sm:text-[13px]"
                    >
                      {activeResult.crossCheck.disputedCount}{" "}
                      {activeResult.crossCheck.disputedCount === 1
                        ? "number was"
                        : "numbers were"}{" "}
                      read differently by the two readers and got no tick.
                    </p>
                  )}

                {modState.kind === "none" &&
                  activeResult.crossCheck &&
                  !activeResult.crossCheck.answered && (
                    <p
                      data-second-reader-note="true"
                      className="mt-2 text-xs font-medium text-[#9a5b00] sm:text-[13px]"
                    >
                      The second reader did not answer. Ticks rest on one
                      reading.
                    </p>
                  )}

                {modState.kind === "none" && (
                  <p className="mt-2 text-xs text-slate-600 sm:text-[13px]">
                    Hide any ticked number on this balance sheet. Adds Up works out
                    what it was.
                  </p>
                )}
              </div>
            )}

          <div className="flex flex-wrap items-center gap-2.5 lg:shrink-0">
            {phase === "loading" && (
              <button
                type="button"
                onClick={handleStop}
                className="inline-flex w-fit shrink-0 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50"
              >
                Stop
              </button>
            )}

            {phase === "done" && isModifying && (
              <button
                type="button"
                onClick={handleStopModification}
                className="inline-flex w-fit shrink-0 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50"
              >
                Stop
              </button>
            )}

            {(phase === "slow" || phase === "stopped") && (
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex w-fit shrink-0 cursor-pointer items-center justify-center rounded-lg bg-[#1d4ea8] px-4 py-2 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a]"
              >
                Read it again
              </button>
            )}

            {(phase === "timeout" ||
              (phase === "error" && errorCode === "failed")) && (
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex w-fit shrink-0 cursor-pointer items-center justify-center rounded-lg bg-[#1d4ea8] px-4 py-2 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a]"
              >
                Try again
              </button>
            )}

            {phase === "done" && isModifiedResult && (
              <>
                <button
                  type="button"
                  onClick={() => handleUndoToUnchanged(modState.cell)}
                  className="inline-flex w-fit shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50"
                >
                  <UndoArrowIcon />
                  <span>Undo</span>
                </button>
                <Link
                  href="/"
                  prefetch={false}
                  className="inline-flex w-fit shrink-0 items-center justify-center px-2 py-2 text-sm font-semibold text-[#1d4ea8] transition-colors hover:text-[#173f8a]"
                >
                  Start over
                </Link>
              </>
            )}

            {phase !== "loading" && !isModifying && !isModifiedResult && (
              <button
                type="button"
                disabled={isUploadingNext}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex w-fit shrink-0 cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isUploadingNext ? "Uploading..." : "Upload another"}
              </button>
            )}
          </div>
        </div>
      </section>

      {modError && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-red-200 bg-red-50 px-5 py-3.5 text-sm text-red-900 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="font-medium">{modError}</p>
          <button
            type="button"
            onClick={() => setModError(null)}
            className="w-fit shrink-0 cursor-pointer rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-semibold text-red-900 hover:bg-red-100"
          >
            Dismiss
          </button>
        </div>
      )}

      <div
        className={
          showSidebar
            ? "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start"
            : "space-y-4"
        }
      >
        <div
          className={`min-w-0 space-y-4 ${
            isModifiedResult
              ? "order-2 lg:order-none lg:col-start-1 lg:row-start-1 lg:row-span-3"
              : "order-1 lg:order-none lg:col-start-1 lg:row-start-1 lg:row-span-3"
          }`}
        >
          {phase === "done" && provenModel && (
            <ResultTable
              statement={uploadStatement}
              source="upload"
              displayRows={provenModel.displayRows}
              proof={provenModel.proof}
              mode={tableMode}
              selectedCell={modState.kind === "none" ? selectedCell : null}
              onSelectCell={handleSelectCell}
              onQuickHide={handleStartHide}
              onQuickChange={handleOpenChangeForm}
              activeHiddenCell={
                modState.kind === "rehiding" || modState.kind === "hidden"
                  ? modState.cell
                  : null
              }
              activeChangedCell={
                modState.kind === "rechanging" || modState.kind === "changed"
                  ? { ...modState.cell, displayValue: modState.newValue }
                  : null
              }
              rebuild={provenModel.rebuild}
            />
          )}

          <section
            aria-label="Uploaded balance sheet picture"
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3 text-xs text-slate-500 sm:px-6">
              <span>{pictureCardHeader}</span>
              <span className="truncate">{fileName}</span>
            </div>

            <div className="bg-white p-2 sm:p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={activePictureUrl}
                alt={`Uploaded balance sheet picture: ${fileName}`}
                className="mx-auto block h-auto w-full max-w-full"
              />
            </div>
          </section>
        </div>

        {phase === "loading" && (
          <aside
            aria-label="Working"
            className="order-2 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs lg:order-none lg:col-start-2 lg:row-start-1"
          >
            <h2 className="text-base font-bold text-slate-900">Working</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-800">
              <li className="flex items-start gap-2.5">
                <GreenCheckIcon />
                <span>Got your picture.</span>
              </li>
              <li className="flex items-start gap-2.5 font-medium text-slate-900">
                <SpinnerIcon />
                <span>Hydrogen is reading the picture.</span>
              </li>
              <li className="flex items-start gap-2.5 text-slate-500">
                <PendingStepIcon />
                <span>Re-add every total.</span>
              </li>
            </ul>
          </aside>
        )}

        {(phase === "slow" || phase === "timeout") && (
          <aside
            aria-label="What happened"
            className="order-2 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs lg:order-none lg:col-start-2 lg:row-start-1"
          >
            <h2 className="text-base font-bold text-slate-900">
              What happened
            </h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-800">
              <li className="flex items-start gap-2.5">
                <GreenCheckIcon />
                <span>Got your picture.</span>
              </li>
              <li className="flex items-start gap-2.5 font-medium text-slate-900">
                <WarningTriangleIcon />
                <span>The first reading timed out.</span>
              </li>
              {phase === "slow" && (
                <li className="flex items-start gap-2.5 text-slate-600">
                  <SpinnerIcon />
                  <span>Trying once more.</span>
                </li>
              )}
            </ul>
          </aside>
        )}

        {phase === "done" && isModifying && (
          <aside
            aria-label="Working"
            className="order-2 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs lg:order-none lg:col-start-2 lg:row-start-1"
          >
            <h2 className="text-base font-bold text-slate-900">Working</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-800">
              <li className="flex items-start gap-2.5">
                <GreenCheckIcon />
                <span>Drew the new picture.</span>
              </li>
              <li className="flex items-start gap-2.5 font-medium text-slate-900">
                <SpinnerIcon />
                <span>Hydrogen is reading it.</span>
              </li>
              <li className="flex items-start gap-2.5 text-slate-500">
                <PendingStepIcon />
                <span>Re-add every total.</span>
              </li>
            </ul>
          </aside>
        )}

        {phase === "done" &&
          modState.kind === "none" &&
          selectedCellInfo && (
            <aside
              aria-label="Selected number"
              data-selected-panel="true"
              className="order-2 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs lg:order-none lg:col-start-2 lg:row-start-1"
            >
              <p className="text-xs font-medium text-slate-500">
                Selected number
              </p>

              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-bold leading-snug text-slate-900">
                  {selectedCellInfo.row.label}
                </h2>
                {selectedCellInfo.status === "proven" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#e6f4ec] px-2.5 py-0.5 text-xs font-semibold text-[#146c43]">
                    <GreenCheckIcon size="sm" />
                    <span>Proven</span>
                  </span>
                )}
                {selectedCellInfo.status === "not_proven" && (
                  <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                    Not proven
                  </span>
                )}
                {(selectedCellInfo.status === "mismatch" ||
                  selectedCellInfo.status === "unread") && (
                  <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-[#9a5b00]">
                    Needs your eye
                  </span>
                )}
              </div>

              <p className="mt-1 text-sm text-slate-600">
                {selectedCellInfo.columnHeading} ·{" "}
                {selectedCellInfo.formattedValue}
              </p>

              <ul className="mt-4 space-y-2.5 text-sm text-slate-800">
                {selectedCellInfo.status === "proven" &&
                  selectedCellInfo.containingTotalLabel && (
                    <li className="flex items-start gap-2.5">
                      <GreenCheckIcon />
                      <span>
                        Sits inside {selectedCellInfo.containingTotalLabel},
                        which re-adds.
                      </span>
                    </li>
                  )}
                {selectedCellInfo.status === "proven" &&
                  !selectedCellInfo.containingTotalLabel &&
                  selectedCellInfo.totalGroup && (
                    <li className="flex items-start gap-2.5">
                      <GreenCheckIcon />
                      <span>
                        Re-adds from{" "}
                        {selectedCellInfo.totalGroup.memberIndices.length} lines
                        above.
                      </span>
                    </li>
                  )}
                {selectedCellInfo.status === "not_proven" && (
                  <li className="flex items-start gap-2.5 text-slate-600">
                    <PendingStepIcon />
                    <span>Sits outside every total on this balance sheet.</span>
                  </li>
                )}
                {selectedCellInfo.disputed && (
                  <li
                    data-disputed-reason="true"
                    className="flex items-start gap-2.5 font-medium text-[#9a5b00]"
                  >
                    <OutlineWarningTriangleIcon />
                    <span>
                      Two readers disagree:{" "}
                      {selectedCellInfo.disputed.first || "no value"} and{" "}
                      {selectedCellInfo.disputed.second || "no value"}.
                    </span>
                  </li>
                )}
              </ul>

              <div className="mt-4">
                <div className="flex items-baseline justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm">
                  <span className="min-w-0 truncate text-slate-800">
                    {selectedCellInfo.row.label}
                  </span>
                  <span className="shrink-0 font-mono font-semibold text-slate-900 tabular-nums">
                    {selectedCellInfo.formattedValue}
                  </span>
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  What the model saw
                </p>
              </div>

              {hideRefusal && (
                <div
                  role="alert"
                  data-hide-refusal="true"
                  className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs font-medium text-[#71490a]"
                >
                  {hideRefusal}
                </div>
              )}

              {!changeFormOpen ? (
                <div className="mt-4 flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => handleStartHide(selectedCellInfo.cell)}
                    className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-[#1d4ea8] px-4 py-2 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a]"
                  >
                    Hide it
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenChangeForm(selectedCellInfo.cell)}
                    className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50"
                  >
                    Change it
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={handleSubmitChange}
                  noValidate
                  className="mt-4 space-y-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3.5"
                  data-change-form="true"
                >
                  <label
                    htmlFor="upload-change-value-input"
                    className="block text-xs font-semibold text-slate-700"
                  >
                    New value for {selectedCellInfo.row.label}
                  </label>
                  <input
                    id="upload-change-value-input"
                    type="text"
                    inputMode="decimal"
                    value={changeInput}
                    onChange={(e) => {
                      setChangeInput(e.target.value);
                      if (changeInputError) setChangeInputError(null);
                    }}
                    autoFocus
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-[#1d4ea8] focus:outline-2 focus:outline-offset-1 focus:outline-[#1d4ea8]"
                  />
                  {changeInputError && (
                    <p
                      role="alert"
                      data-change-error="true"
                      className="text-xs font-medium text-[#b53800]"
                    >
                      {changeInputError}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-[#1d4ea8] px-3.5 py-1.5 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a]"
                    >
                      Apply change
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setChangeFormOpen(false);
                        setChangeInputError(null);
                      }}
                      className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </aside>
          )}

        {phase === "done" && modState.kind === "hidden" && provenModel && (
          <aside
            aria-label="Hidden number result"
            data-hidden-panel="true"
            className="order-1 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs lg:order-none lg:col-start-2 lg:row-start-1"
          >
            {provenModel.rebuild?.status === "rebuilt" ? (
              <>
                <p className="text-xs font-medium text-slate-500">
                  The hidden number is
                </p>
                <p
                  data-rebuilt-value="true"
                  className="mt-1 font-mono text-4xl font-bold tracking-tight text-slate-900 tabular-nums"
                >
                  {formatProofNumber(provenModel.rebuild.value)}
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {modState.rowLabel},{" "}
                  {uploadStatement.columns[modState.cell.colIndex]}
                </p>

                {provenModel.rebuild.ways[0] && (
                  <div className="mt-4 rounded-xl bg-slate-50 p-3.5 text-xs text-slate-800 sm:text-[13px]">
                    {provenModel.rebuild.ways[0].kind === "total_minus_others" &&
                    provenModel.rebuild.ways[0].printedTotal !== null ? (
                      <div className="space-y-1.5">
                        <div className="flex items-baseline gap-3">
                          <span className="w-[82px] shrink-0 text-right font-mono tabular-nums text-slate-900">
                            {formatProofNumber(
                              provenModel.rebuild.ways[0].printedTotal,
                            )}
                          </span>
                          <span className="min-w-0 text-slate-700">
                            {provenModel.numberRows[
                              provenModel.rebuild.ways[0].totalIndex
                            ]?.label ?? "Total"}
                          </span>
                        </div>
                        <div className="flex items-baseline gap-3">
                          <span className="w-[82px] shrink-0 text-right font-mono tabular-nums text-slate-900">
                            −
                            {formatProofNumber(
                              provenModel.rebuild.ways[0].otherMembersSum,
                            )}
                          </span>
                          <span className="min-w-0 text-slate-700">
                            the{" "}
                            {countWord(
                              provenModel.rebuild.ways[0].memberIndices.length -
                                1,
                            )}{" "}
                            other lines
                          </span>
                        </div>
                        <div className="border-t border-slate-700 pt-1.5">
                          <div className="flex items-baseline gap-3 font-bold text-slate-900">
                            <span className="w-[82px] shrink-0 text-right font-mono tabular-nums">
                              {formatProofNumber(provenModel.rebuild.value)}
                            </span>
                            <span className="min-w-0">{modState.rowLabel}</span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <div className="flex items-baseline gap-3">
                          <span className="w-[82px] shrink-0 text-right font-mono tabular-nums text-slate-900">
                            {formatProofNumber(
                              provenModel.rebuild.ways[0].otherMembersSum,
                            )}
                          </span>
                          <span className="min-w-0 text-slate-700">
                            the{" "}
                            {countWord(
                              provenModel.rebuild.ways[0].memberIndices.length,
                            )}{" "}
                            lines, added
                          </span>
                        </div>
                        <div className="border-t border-slate-700 pt-1.5">
                          <div className="flex items-baseline gap-3 font-bold text-slate-900">
                            <span className="w-[82px] shrink-0 text-right font-mono tabular-nums">
                              {formatProofNumber(provenModel.rebuild.value)}
                            </span>
                            <span className="min-w-0">{modState.rowLabel}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <p className="mt-3 text-sm text-slate-600">
                  The models saw a black box. Plain code did this sum.
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-slate-500">
                  Could not rebuild
                </p>
                <h2 className="mt-1 text-lg font-bold text-slate-900">
                  {modState.rowLabel}
                </h2>
                <p
                  data-cannot-rebuild="true"
                  className="mt-2 text-sm text-slate-700"
                >
                  {provenModel.rebuild?.reason ??
                    "Cannot rebuild this number because the other column has no group for these rows. Adds Up never guesses."}
                </p>
              </>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => handleUndoToUnchanged(modState.cell)}
                className="inline-flex cursor-pointer items-center justify-center rounded-lg bg-[#1d4ea8] px-4 py-2 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a]"
              >
                Reveal the number
              </button>
              <button
                type="button"
                onClick={() => handleUndoToUnchanged(modState.cell)}
                className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50"
              >
                Hide another
              </button>
            </div>
          </aside>
        )}

        {phase === "done" && modState.kind === "changed" && provenModel && (
          <aside
            aria-label="Change result"
            data-changed-panel="true"
            className="order-1 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs lg:order-none lg:col-start-2 lg:row-start-1"
          >
            {primaryChangedMismatch ? (
              <>
                <p className="text-xs font-medium text-slate-500">Found</p>
                <h2 className="mt-1 text-2xl font-bold leading-tight text-slate-900">
                  {primaryChangedMismatch.heading}
                </h2>

                <div className="mt-4 rounded-xl bg-slate-50 p-3.5 text-xs text-slate-800 sm:text-[13px]">
                  {primaryChangedMismatch.mismatch.computedSum >=
                  primaryChangedMismatch.mismatch.printedTotal ? (
                    <div className="space-y-1.5">
                      <div className="flex items-baseline gap-3">
                        <span className="w-[82px] shrink-0 text-right font-mono tabular-nums text-slate-900">
                          {formatProofNumber(
                            primaryChangedMismatch.mismatch.computedSum,
                          )}
                        </span>
                        <span className="min-w-0 text-slate-700">
                          the{" "}
                          {countWord(
                            primaryChangedMismatch.mismatch.memberIndices
                              .length,
                          )}{" "}
                          lines, added
                        </span>
                      </div>
                      <div className="flex items-baseline gap-3">
                        <span className="w-[82px] shrink-0 text-right font-mono tabular-nums text-slate-900">
                          −
                          {formatProofNumber(
                            primaryChangedMismatch.mismatch.printedTotal,
                          )}
                        </span>
                        <span className="min-w-0 text-slate-700">
                          the printed total
                        </span>
                      </div>
                      <div className="border-t border-slate-700 pt-1.5">
                        <div className="flex items-baseline gap-3 font-bold text-slate-900">
                          <span className="w-[82px] shrink-0 text-right font-mono tabular-nums">
                            {formatProofNumber(
                              primaryChangedMismatch.mismatch.gap,
                            )}
                          </span>
                          <span className="min-w-0">gap</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="flex items-baseline gap-3">
                        <span className="w-[82px] shrink-0 text-right font-mono tabular-nums text-slate-900">
                          {formatProofNumber(
                            primaryChangedMismatch.mismatch.printedTotal,
                          )}
                        </span>
                        <span className="min-w-0 text-slate-700">
                          the printed total
                        </span>
                      </div>
                      <div className="flex items-baseline gap-3">
                        <span className="w-[82px] shrink-0 text-right font-mono tabular-nums text-slate-900">
                          −
                          {formatProofNumber(
                            primaryChangedMismatch.mismatch.computedSum,
                          )}
                        </span>
                        <span className="min-w-0 text-slate-700">
                          the{" "}
                          {countWord(
                            primaryChangedMismatch.mismatch.memberIndices
                              .length,
                          )}{" "}
                          lines, added
                        </span>
                      </div>
                      <div className="border-t border-slate-700 pt-1.5">
                        <div className="flex items-baseline gap-3 font-bold text-slate-900">
                          <span className="w-[82px] shrink-0 text-right font-mono tabular-nums">
                            {formatProofNumber(
                              primaryChangedMismatch.mismatch.gap,
                            )}
                          </span>
                          <span className="min-w-0">gap</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {causeSentence && (
                  <div className="mt-4" data-cause-block="true">
                    <p className="text-xs font-medium text-slate-500">
                      {formatCauseModelLabel(causeModel)}
                    </p>
                    <p
                      data-cause-sentence="true"
                      className="mt-1 text-sm leading-relaxed text-slate-900"
                    >
                      {causeSentence}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-slate-500">Checked</p>
                <h2
                  data-change-not-caught="true"
                  className="mt-1 text-lg font-bold text-slate-900"
                >
                  {CHANGE_NOT_CAUGHT_MESSAGE}
                </h2>
                <p className="mt-1.5 text-sm text-slate-600">
                  {modState.rowLabel} was changed to {modState.newValue}.
                </p>
              </>
            )}

            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => handleUndoToUnchanged(modState.cell)}
                className="inline-flex w-fit cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-[#1d4ea8] px-4 py-2 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a]"
              >
                <UndoArrowIcon />
                <span>Undo my change</span>
              </button>
              <button
                type="button"
                onClick={() => handleUndoToUnchanged(modState.cell)}
                className="inline-flex w-fit cursor-pointer items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50"
              >
                Change another
              </button>
            </div>
          </aside>
        )}

        {phase === "done" && activeResult && provenModel && (
          <aside
            aria-label="Proof note"
            className="order-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs lg:order-none lg:col-start-2 lg:row-start-2"
          >
            <h2 className="text-base font-bold text-slate-900">
              No answer key for this page
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              This file was uploaded directly, so the proof comes from
              re-adding the numbers alone.
            </p>
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className={`mt-4 cursor-pointer rounded-xl border border-dashed px-4 py-4 text-center text-xs font-medium text-slate-600 transition-colors ${
                isDragging
                  ? "border-[#1d4ea8] bg-blue-50/40 text-slate-900"
                  : "border-slate-300 hover:border-slate-400 hover:bg-slate-50"
              }`}
            >
              Drop a picture of one page here
            </div>
          </aside>
        )}

        {phase === "done" && activeResult && provenModel && history.length > 0 && (
          <aside
            aria-label="What happened"
            className="order-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs lg:order-none lg:col-start-2 lg:row-start-3"
          >
            <h2 className="text-base font-bold text-slate-900">
              What happened
            </h2>
            <ol className="mt-3.5 space-y-2.5 text-sm text-slate-800">
              {history.map((entry, idx) => {
                const isLast = idx === history.length - 1;
                return (
                  <li
                    key={entry.id}
                    className={`flex items-baseline gap-3 ${
                      idx > 0 ? "border-t border-slate-100 pt-2.5" : ""
                    }`}
                  >
                    <span className="font-mono text-xs text-slate-400">
                      {idx + 1}
                    </span>
                    <span
                      className={
                        entry.tone === "error"
                          ? "font-semibold text-[#b53800]"
                          : isLast
                            ? "font-semibold text-slate-900"
                            : "text-slate-700"
                      }
                    >
                      {entry.text}
                    </span>
                  </li>
                );
              })}
            </ol>
          </aside>
        )}
      </div>
    </div>
  );
}
