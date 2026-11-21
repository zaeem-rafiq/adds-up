"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  buildResultDisplayRows,
  formatProofNumber,
  ResultTable,
} from "@/components/ResultTable";
import { proveColumns } from "@/lib/adding";
import type {
  ReadingProgressEvent,
  StatementReadingResult,
} from "@/lib/reading";
import type { Statement, StatementSource } from "@/lib/statements";

function formatFilingDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) return isoDate;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (Number.isNaN(date.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

type StatementViewProps = {
  statement: Statement;
  source: StatementSource;
  pictureUrl: string;
  slowMode?: boolean;
  /** Set to false when showing a statement that has no SEC comparison data. */
  hasSecData?: boolean;
};

type ReadingPhase =
  | "loading"
  | "slow"
  | "timeout"
  | "done"
  | "error"
  | "stopped";

type ErrorCode = "timeout" | "rate_limit" | "missing_key" | "failed";

function countExpectedNumbers(statement: Statement): number {
  let total = 0;
  for (const row of statement.rows) {
    if (row.kind !== "number") continue;
    if (row.numbers[0] !== null) total += 1;
    if (row.numbers[1] !== null) total += 1;
  }
  return total;
}

function GreenCheckIcon() {
  return (
    <svg
      className="mt-0.5 h-5 w-5 shrink-0 text-[#146c43]"
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
      <circle
        cx="10"
        cy="10"
        r="7.5"
        stroke="#cbd5e1"
        strokeWidth="2.2"
      />
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

export function StatementView({
  statement,
  source,
  pictureUrl,
  slowMode = false,
  hasSecData = true,
}: StatementViewProps) {
  const formattedDate = formatFilingDate(statement.filingDate);
  const reportLabel =
    statement.form === "10-K" ? "annual report" : "quarterly report";
  const initialTotalNumbers = countExpectedNumbers(statement);

  const [phase, setPhase] = useState<ReadingPhase>("loading");
  const [numbersRead, setNumbersRead] = useState(0);
  const [totalNumbers, setTotalNumbers] = useState(initialTotalNumbers);
  const [totalStrips, setTotalStrips] = useState(2);
  const [completedStrips, setCompletedStrips] = useState(0);
  const [slowStrip, setSlowStrip] = useState(2);
  const [result, setResult] = useState<StatementReadingResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ErrorCode | null>(null);

  const [runState, setRunState] = useState<{
    runId: number;
    useSlowQuery: boolean;
  }>({ runId: 0, useSlowQuery: slowMode });

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    const readUrl = `/api/company/${encodeURIComponent(statement.cik)}/read${
      runState.useSlowQuery ? "?slow=1" : ""
    }`;

    const applyEvent = (event: ReadingProgressEvent) => {
      if (controller.signal.aborted) return;
      if (event.type === "started") {
        setTotalNumbers(event.totalNumbers);
        setTotalStrips(event.totalStrips);
      } else if (event.type === "strip_done") {
        setNumbersRead(event.numbersRead);
        setTotalNumbers(event.totalNumbers);
        setTotalStrips(event.totalStrips);
        setCompletedStrips((prev) => Math.min(event.totalStrips, prev + 1));
      } else if (event.type === "slow") {
        setSlowStrip(event.strip);
        setTotalStrips(event.totalStrips);
        setPhase("slow");
      } else if (event.type === "done") {
        setResult(event.result);
        setNumbersRead(event.result.comparison.readCount);
        setTotalNumbers(event.result.comparison.totalStatementNumbers);
        setPhase("done");
      } else if (event.type === "error") {
        setErrorCode(event.code);
        setErrorMessage(event.message);
        if (event.strip) setSlowStrip(event.strip);
        if (event.totalStrips) setTotalStrips(event.totalStrips);
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
          let message = "Could not read the balance sheet picture right now.";
          let code: ErrorCode = "failed";
          try {
            const payload = (await response.json()) as {
              error?: string;
              code?: ErrorCode;
            };
            if (payload.error) message = payload.error;
            if (payload.code) code = payload.code;
          } catch {
            // Keep default plain error message.
          }

          if (controller.signal.aborted) return;
          setErrorCode(code);
          setErrorMessage(message);
          setPhase(code === "timeout" ? "timeout" : "error");
          return;
        }

        let receivedTerminal = false;

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
              const trimmed = rawLine.trim();
              if (!trimmed) continue;
              const event = JSON.parse(trimmed) as ReadingProgressEvent;
              if (event.type === "done" || event.type === "error") {
                receivedTerminal = true;
              }
              applyEvent(event);
            }
          }

          const remaining = (buffer + decoder.decode()).trim();
          if (remaining) {
            for (const rawLine of remaining.split("\n")) {
              const trimmed = rawLine.trim();
              if (!trimmed) continue;
              const event = JSON.parse(trimmed) as ReadingProgressEvent;
              if (event.type === "done" || event.type === "error") {
                receivedTerminal = true;
              }
              applyEvent(event);
            }
          }
        } else {
          const text = await response.text();
          for (const rawLine of text.split("\n")) {
            const trimmed = rawLine.trim();
            if (!trimmed) continue;
            const event = JSON.parse(trimmed) as ReadingProgressEvent;
            if (event.type === "done" || event.type === "error") {
              receivedTerminal = true;
            }
            applyEvent(event);
          }
        }

        if (!receivedTerminal && !controller.signal.aborted) {
          setErrorCode("failed");
          setErrorMessage("Reading ended before the server returned an answer.");
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
        setErrorMessage("Could not read the balance sheet picture right now.");
        setPhase("error");
      }
    };

    void run();

    return () => {
      controller.abort();
    };
  }, [runState, statement.cik]);

  const handleStop = () => {
    abortRef.current?.abort();
    setPhase("stopped");
  };

  const handleRetry = () => {
    abortRef.current?.abort();
    setPhase("loading");
    setNumbersRead(0);
    setTotalNumbers(initialTotalNumbers);
    setTotalStrips(2);
    setCompletedStrips(0);
    setSlowStrip(2);
    setResult(null);
    setErrorMessage(null);
    setErrorCode(null);
    setRunState((prev) => ({ runId: prev.runId + 1, useSlowQuery: false }));
  };

  const provenModel = useMemo(() => {
    if (!result) return null;
    const displayRows = buildResultDisplayRows(statement, result);
    const numberRows = displayRows.filter((row) => row.kind === "number");
    const leftColumn = numberRows.map((row) => row.numbers[0]);
    const rightColumn = numberRows.map((row) => row.numbers[1]);
    const unreadMask = numberRows.map((row) => row.unread);

    const proof = proveColumns(leftColumn, rightColumn, { unreadMask });
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
      allMismatches,
      mismatchCellCount,
      unreadCellCount,
    };
  }, [result, statement]);

  const progressPercent =
    totalNumbers > 0
      ? Math.min(100, Math.round((numbersRead / totalNumbers) * 100))
      : 0;
  const displayedProgressWidth =
    phase === "loading" && numbersRead === 0 ? 12 : Math.max(progressPercent, 12);
  const activeStrip = Math.min(totalStrips, completedStrips + 1);
  const showSidebar =
    phase === "loading" ||
    phase === "slow" ||
    phase === "timeout" ||
    (phase === "done" && provenModel !== null);

  const showSecMatch =
    hasSecData &&
    result !== null &&
    result.comparison.totalStatementNumbers > 0;

  const verdictHeadline = (() => {
    if (!provenModel) return null;
    const { proof, allMismatches } = provenModel;
    const { proven, needYourEye, total } = proof.counts;

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
    provenModel && provenModel.proof.counts.total > 0
      ? (provenModel.proof.counts.proven / provenModel.proof.counts.total) * 100
      : 0;
  const mismatchPct =
    provenModel && provenModel.proof.counts.total > 0
      ? (provenModel.mismatchCellCount / provenModel.proof.counts.total) * 100
      : 0;
  const unreadPct =
    provenModel && provenModel.proof.counts.total > 0
      ? (provenModel.unreadCellCount / provenModel.proof.counts.total) * 100
      : 0;

  return (
    <div className="space-y-4">
      {source === "saved" && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-xl border border-[#f2dc9b] bg-[#fef5d6] px-4 py-3 text-sm text-[#71490a]"
        >
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-[#8a5a0b]"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path
              d="M10 3.2L17.5 16.2H2.5L10 3.2Z"
              strokeLinejoin="round"
            />
            <path d="M10 8V11.5" strokeLinecap="round" />
            <circle cx="10" cy="14" r="0.8" fill="currentColor" stroke="none" />
          </svg>
          <p className="leading-snug">
            <strong className="font-semibold">The SEC did not answer.</strong>{" "}
            This is a copy of the filing that we saved earlier.
          </p>
        </div>
      )}

      <section
        aria-label="Statement verdict"
        className="rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-2xs sm:px-6"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
          <div className="min-w-0 lg:max-w-[260px]">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              {statement.companyName}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Balance sheet · {statement.form} ({reportLabel}) · filed{" "}
              {formattedDate}
            </p>
          </div>

          {phase === "loading" && (
            <div className="min-w-0 flex-1" role="status" aria-live="polite">
              <p className="text-2xl font-bold tracking-tight text-slate-900 sm:text-[28px]">
                Reading: {numbersRead} of {totalNumbers} numbers
              </p>
              <div
                className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200"
                role="progressbar"
                aria-label="Reading progress"
                aria-valuemin={0}
                aria-valuemax={totalNumbers}
                aria-valuenow={numbersRead}
              >
                <div
                  className="h-full rounded-full bg-[#146c43] transition-all duration-300"
                  style={{ width: `${displayedProgressWidth}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-slate-500 sm:text-sm">
                The ticks land as each strip of the page is read.
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
              <div
                className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-slate-200"
                aria-hidden="true"
              >
                <div
                  className="h-full rounded-full bg-[#146c43] transition-all duration-300"
                  style={{ width: `${displayedProgressWidth}%` }}
                />
              </div>
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

          {phase === "done" && result && provenModel && verdictHeadline && (
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
                    {provenModel.proof.counts.proven}
                  </strong>{" "}
                  proven
                </span>
                <span data-count="need-your-eye">
                  <strong className="font-bold text-slate-900">
                    {provenModel.proof.counts.needYourEye}
                  </strong>{" "}
                  need your eye
                </span>
                <span data-count="not-proven">
                  <strong className="font-bold text-slate-900">
                    {provenModel.proof.counts.notProven}
                  </strong>{" "}
                  not proven
                </span>
                {provenModel.allMismatches.length === 1 && (
                  <span data-verdict-gap="true">
                    Gap:{" "}
                    {formatProofNumber(provenModel.allMismatches[0].gap)}
                  </span>
                )}
                {showSecMatch && (
                  <span
                    data-sec-match="true"
                    className="w-full sm:w-auto"
                  >
                    Matches SEC data: {result.comparison.matchCount} of{" "}
                    {result.comparison.totalStatementNumbers}
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2.5 lg:shrink-0">
            {phase === "loading" && (
              <button
                type="button"
                onClick={handleStop}
                className="inline-flex w-fit shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8]"
              >
                Stop
              </button>
            )}

            {(phase === "slow" || phase === "stopped") && (
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex w-fit shrink-0 items-center justify-center rounded-lg bg-[#1d4ea8] px-4 py-2 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8]"
              >
                Read it again
              </button>
            )}

            {phase === "timeout" && (
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex w-fit shrink-0 items-center justify-center rounded-lg bg-[#1d4ea8] px-4 py-2 text-sm font-semibold text-white shadow-2xs transition-colors hover:bg-[#173f8a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8]"
              >
                Try again
              </button>
            )}

            {phase !== "loading" && (
              <Link
                href="/"
                prefetch={false}
                className="inline-flex w-fit shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8]"
              >
                Change company
              </Link>
            )}
          </div>
        </div>
      </section>

      <div
        className={
          showSidebar
            ? "grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start"
            : "space-y-4"
        }
      >
        <div className="min-w-0 space-y-4">
          {phase === "done" && provenModel && (
            <ResultTable
              statement={statement}
              source={source}
              displayRows={provenModel.displayRows}
              proof={provenModel.proof}
            />
          )}

          <section
            aria-label="Balance sheet picture"
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3 text-xs text-slate-500 sm:px-6">
              <span>Picture sent to the models</span>
              {source === "saved" && <span>Saved copy</span>}
            </div>

            <div className="bg-white p-2 sm:p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={pictureUrl}
                alt={`${statement.companyName} balance sheet, ${statement.form} filed ${formattedDate}`}
                className="mx-auto block h-auto w-full max-w-full"
              />
            </div>
          </section>

          {phase === "error" && errorMessage && (
            <div
              role="alert"
              className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-900 sm:flex-row sm:items-center sm:justify-between"
            >
              <p className="font-medium">{errorMessage}</p>
              {errorCode === "failed" && (
                <button
                  type="button"
                  onClick={handleRetry}
                  className="inline-flex w-fit shrink-0 items-center justify-center rounded-lg border border-red-300 bg-white px-3.5 py-1.5 text-sm font-semibold text-red-900 transition-colors hover:bg-red-100"
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </div>

        {phase === "loading" && (
          <aside
            aria-label="Working"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs"
          >
            <h2 className="text-base font-bold text-slate-900">Working</h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-800">
              <li className="flex items-start gap-2.5">
                <GreenCheckIcon />
                <span>Found the filing.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <GreenCheckIcon />
                <span>Took the picture.</span>
              </li>
              <li className="flex items-start gap-2.5 font-medium text-slate-900">
                <SpinnerIcon />
                <span>
                  Hydrogen is reading strip {activeStrip} of {totalStrips}.
                </span>
              </li>
              <li className="flex items-start gap-2.5 text-slate-500">
                <PendingStepIcon />
                <span>Re-add every total.</span>
              </li>
              <li className="flex items-start gap-2.5 text-slate-500">
                <PendingStepIcon />
                <span>Compare with SEC data.</span>
              </li>
            </ul>
          </aside>
        )}

        {(phase === "slow" || phase === "timeout") && (
          <aside
            aria-label="What happened"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs"
          >
            <h2 className="text-base font-bold text-slate-900">
              What happened
            </h2>
            <ul className="mt-4 space-y-3 text-sm text-slate-800">
              <li className="flex items-start gap-2.5">
                <GreenCheckIcon />
                <span>Found the filing.</span>
              </li>
              <li className="flex items-start gap-2.5">
                <GreenCheckIcon />
                <span>Took the picture.</span>
              </li>
              <li className="flex items-start gap-2.5 font-medium text-slate-900">
                <WarningTriangleIcon />
                <span>
                  Strip {slowStrip} of {totalStrips} timed out.
                </span>
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

        {phase === "done" && result && provenModel && (
          <aside
            aria-label="What happened"
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs"
          >
            <h2 className="text-base font-bold text-slate-900">
              What happened
            </h2>
            <ol className="mt-3.5 space-y-2.5 text-sm text-slate-800">
              <li className="flex items-baseline gap-3">
                <span className="font-mono text-xs text-slate-400">1</span>
                <span className="font-semibold text-slate-900">
                  Read the page:{" "}
                  {result.comparison.readCount || provenModel.proof.counts.total}{" "}
                  numbers.
                </span>
              </li>
              {provenModel.allMismatches.length > 0 && (
                <li className="flex items-baseline gap-3 border-t border-slate-100 pt-2.5">
                  <span className="font-mono text-xs text-slate-400">2</span>
                  <span className="font-semibold text-[#b53800]">
                    {provenModel.allMismatches.length === 1
                      ? `${
                          provenModel.numberRows[
                            provenModel.allMismatches[0].totalIndex
                          ]?.label ?? "One group"
                        } did not add up.`
                      : `${provenModel.allMismatches.length} groups did not add up.`}
                  </span>
                </li>
              )}
            </ol>
          </aside>
        )}
      </div>
    </div>
  );
}
