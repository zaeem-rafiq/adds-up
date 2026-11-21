import {
  buildComparisonRows,
  buildRecheckRows,
  formatCutoffPercent,
  formatInt,
  formatWrongShownAsRight,
  getOutsideTotalsSummary,
  type FilingScore,
  type PassMark,
  type ScoresFile,
  type ScoresLoadResult,
} from "@/lib/scores";

function WarningTriangleIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M7.14 2.48a1 1 0 0 1 1.72 0l5.42 9.18A1 1 0 0 1 13.42 13.17H2.58a1 1 0 0 1-.86-1.51L7.14 2.48Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.1v3.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.2" r="0.8" fill="currentColor" />
    </svg>
  );
}

function FilledWarningIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M7.14 2.15a1 1 0 0 1 1.72 0l5.64 9.55A1 1 0 0 1 13.64 13.2H2.36a1 1 0 0 1-.86-1.5l5.64-9.55Z"
        fill="currentColor"
      />
      <path
        d="M8 5.7v3.2"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="10.95" r="0.85" fill="white" />
    </svg>
  );
}

function MinusCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M5.2 8h5.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PassMarkBadge({ met }: { met: PassMark["met"] }) {
  if (met === true) {
    return (
      <span className="inline-flex items-center rounded-full bg-[#dff1e5] px-2.5 py-0.5 text-xs font-semibold text-[#14532d]">
        Met
      </span>
    );
  }
  if (met === false) {
    return (
      <span className="inline-flex items-center rounded-full bg-[#fdecec] px-2.5 py-0.5 text-xs font-semibold text-[#b42318]">
        Missed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
      not run
    </span>
  );
}

function formatBooleanStep(value: boolean | null, stepRan: boolean): string {
  if (!stepRan || value === null) return "not run";
  return value ? "Yes" : "No";
}

function formatFilingSeconds(seconds: number): string {
  if (seconds < 1) return "from memory";
  return `${seconds.toFixed(1)}s`;
}

function isFilingProblem(filing: FilingScore): boolean {
  return (
    filing.wrongTicked > 0 ||
    filing.flagged ||
    filing.hiddenRebuilt === false ||
    filing.changedCaught === false
  );
}

function EmptyResultsState() {
  return (
    <main className="mx-auto flex w-full max-w-[1160px] flex-col items-center justify-center px-4 pb-24 pt-20 text-center sm:px-6 sm:pt-28">
      <h1 className="text-[28px] font-bold tracking-tight text-slate-900 sm:text-[32px]">
        No test has run yet
      </h1>
      <p className="mt-3 max-w-[400px] text-[15px] leading-relaxed text-slate-600 sm:text-base">
        The test reads 50 filings that a script picks. Results appear here when
        it ends.
      </p>
    </main>
  );
}

function ErrorResultsState({ message }: { message: string }) {
  return (
    <main className="mx-auto w-full max-w-[1160px] px-4 py-8 sm:px-6 sm:py-10">
      <div
        role="alert"
        className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-900"
      >
        <p className="font-semibold">Could not load test results</p>
        <p className="mt-1">{message}</p>
      </div>
    </main>
  );
}

function ReadyResultsView({ scores }: { scores: ScoresFile }) {
  const isRunning = scores.status === "running";
  const progressPct =
    scores.filingsPlanned > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round((scores.filingsScored / scores.filingsPlanned) * 100),
          ),
        )
      : 0;

  const headlineValue = formatWrongShownAsRight(
    scores.totals.addsUp.wrongShownAsRight,
    scores.totals.addsUp.numbers,
    scores.stepsRun.A,
  );

  const filingsPhrase = isRunning
    ? `${formatInt(scores.filingsScored)} of ${formatInt(scores.filingsPlanned)} filings so far`
    : `${formatInt(scores.filingsScored)} filings`;

  let headlineSubtitle: string;
  if (!scores.stepsRun.A || scores.totals.addsUp.numbers <= 0) {
    headlineSubtitle = `Step A has not run yet. The share of numbers on ${filingsPhrase}.`;
  } else if (scores.totals.addsUp.wrongShownAsRight === 0) {
    headlineSubtitle = `0.00% — the share of numbers on ${filingsPhrase}.`;
  } else {
    headlineSubtitle = `${formatInt(scores.totals.addsUp.wrongShownAsRight)} of ${formatInt(scores.totals.addsUp.numbers)} numbers on ${filingsPhrase}.`;
  }

  const comparisonRows = buildComparisonRows(scores);
  const recheckRows = buildRecheckRows(scores);
  const outsideTotalsSummary = getOutsideTotalsSummary(scores);

  const upperCutoffLabel =
    !scores.stepsRun.E || !scores.cutoffs
      ? "not run"
      : scores.cutoffs.upper === null
        ? "none (no number counts as agreed)"
        : `at or above ${formatCutoffPercent(scores.cutoffs.upper)}`;

  const unsureLabel =
    !scores.stepsRun.E || !scores.cutoffs ? "not run" : "in between";

  const lowerCutoffLabel =
    !scores.stepsRun.E || !scores.cutoffs
      ? "not run"
      : scores.cutoffs.lower === null
        ? "none (no number counts as disagreed)"
        : `below ${formatCutoffPercent(scores.cutoffs.lower)}`;

  return (
    <main className="mx-auto w-full max-w-[1160px] space-y-5 px-4 pb-16 pt-6 sm:px-6 sm:pt-8">
      <header>
        <h1 className="text-[28px] font-bold leading-[1.15] tracking-tight text-slate-900 sm:text-[32px]">
          Does it work on pages we did not pick?
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-slate-600 sm:text-base">
          A script picked {formatInt(scores.filingsPlanned)} filings. Each
          number was scored against the company&apos;s own SEC data.
        </p>
      </header>

      {isRunning && (
        <section
          role="status"
          aria-live="polite"
          className="rounded-2xl border border-[#f2dc9b] bg-[#fef3d0] px-4 py-3.5 text-[#714305] sm:px-5"
        >
          <div className="flex items-start gap-2.5 text-sm leading-snug">
            <WarningTriangleIcon className="mt-0.5 shrink-0 text-[#714305]" />
            <div className="min-w-0 flex-1">
              <p>
                <strong className="font-semibold">The test is running.</strong>{" "}
                {formatInt(scores.filingsScored)} of{" "}
                {formatInt(scores.filingsPlanned)} filings scored so far. The
                numbers below change until it ends.
              </p>
              <div
                role="progressbar"
                aria-label="Filings scored"
                aria-valuenow={scores.filingsScored}
                aria-valuemin={0}
                aria-valuemax={scores.filingsPlanned}
                className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-[#e8d59a]"
              >
                <div
                  className="h-full rounded-full bg-[#714305] transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          </div>
        </section>
      )}

      <section
        aria-label="Headline comparison"
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
      >
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6">
          <p className="text-xs font-medium text-slate-500">The problem</p>
          <p className="mt-2 font-mono text-[32px] font-bold leading-none tracking-tight text-slate-900 sm:text-[42px]">
            9% to 18%
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            <strong className="font-semibold text-slate-900">
              AI&apos;s error rate reading figures from 5,000 annual reports.
            </strong>{" "}
            Source: study reported by Thomson Reuters, March 2026.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6">
          <p className="text-xs font-medium text-slate-500">
            Adds Up, wrong numbers shown as right
          </p>
          <p
            data-testid="headline-wrong-shown"
            className="mt-2 font-mono text-[32px] font-bold leading-none tracking-tight text-slate-900 sm:text-[42px]"
          >
            {headlineValue}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            {headlineSubtitle}
          </p>
          {scores.stepsRun.B &&
            scores.totals.oneCall.numbers > 0 &&
            scores.totals.oneCall.readRight ===
              scores.totals.oneCall.numbers && (
              <p className="mt-2 text-sm leading-relaxed text-slate-600">
                One plain model call also read every number right. The
                difference is proof: Adds Up shows the sum behind every tick.
              </p>
            )}
        </div>
      </section>

      <section
        aria-labelledby="against-one-call-heading"
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6"
      >
        <h2
          id="against-one-call-heading"
          className="text-base font-bold text-slate-900"
        >
          Against one plain model call
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-200 font-mono text-xs font-medium text-slate-500">
                <th scope="col" className="pb-2.5 pr-3 font-medium">
                  Measure
                </th>
                <th scope="col" className="pb-2.5 px-2 text-right font-medium">
                  One call
                </th>
                <th scope="col" className="pb-2.5 pl-2 text-right font-medium">
                  Adds Up
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-[13px] sm:text-sm">
              {comparisonRows.map((row) => (
                <tr key={row.measure}>
                  <td className="py-3 pr-3 align-top text-slate-900">
                    <div>{row.measure}</div>
                    {row.note && (
                      <div className="mt-0.5 text-xs text-slate-500">
                        {row.note}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-2 text-right align-top font-mono tabular-nums text-slate-700">
                    <div
                      className={
                        row.oneCall === "not run" ? "text-slate-500" : undefined
                      }
                    >
                      {row.oneCall}
                    </div>
                    {row.oneCallDetail && (
                      <div className="mt-0.5 text-xs text-slate-500">
                        {row.oneCallDetail}
                      </div>
                    )}
                  </td>
                  <td className="py-3 pl-2 text-right align-top font-mono tabular-nums">
                    <div
                      className={
                        row.addsUp === "not run"
                          ? "font-normal text-slate-500"
                          : "font-semibold text-slate-900"
                      }
                    >
                      {row.addsUp}
                    </div>
                    {row.addsUpDetail && (
                      <div className="mt-0.5 text-xs font-normal text-slate-600">
                        {row.addsUpDetail}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        aria-labelledby="pass-marks-heading"
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6"
      >
        <h2
          id="pass-marks-heading"
          className="text-base font-bold text-slate-900"
        >
          Pass marks
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Fixed before the test ran. A missed mark stays on this page.
        </p>

        {scores.passMarks.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">not run</p>
        ) : (
          <ul className="mt-4 divide-y divide-slate-100">
            {scores.passMarks.map((item) => (
              <li
                key={item.measure}
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">
                    {item.measure}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">{item.mark}</p>
                </div>
                <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                  <span className="font-mono text-sm font-semibold tabular-nums text-slate-900">
                    {item.met === null
                      ? "not run"
                      : item.value.replace(/\b\d{4,}\b/g, (digits) =>
                          Number(digits).toLocaleString("en-US"),
                        )}
                  </span>
                  <PassMarkBadge met={item.met} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6">
          <h2 className="text-base font-bold text-slate-900">
            What the second reader decides
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            The re-check gives each number a probability. The test sets the two
            cut-offs.
            {scores.stepsRun.E && scores.cutoffs
              ? ` Set on the first ${formatInt(scores.cutoffs.setOnFilings)} filings.`
              : ""}
          </p>

          <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <div className="rounded-xl bg-[#dff1e5] px-3.5 py-3 text-[#14532d]">
              <p className="text-sm font-semibold leading-snug">
                The second reader agrees
              </p>
              <p className="mt-1 text-xs leading-snug">{upperCutoffLabel}</p>
            </div>

            <div className="rounded-xl bg-[#fef0c7] px-3.5 py-3 text-[#7c4a03]">
              <p className="text-sm font-semibold leading-snug">
                The second reader is unsure
              </p>
              <p className="mt-1 text-xs leading-snug">{unsureLabel}</p>
            </div>

            <div className="rounded-xl bg-[#e9edf2] px-3.5 py-3 text-slate-700">
              <p className="text-sm font-semibold leading-snug">
                The second reader disagrees
              </p>
              <p className="mt-1 text-xs leading-snug">{lowerCutoffLabel}</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6">
          <h2 className="text-base font-bold text-slate-900">
            Where it still fails
          </h2>

          <ul className="mt-3.5 space-y-2.5 text-sm leading-snug text-slate-700">
            {scores.causes.map((cause) => (
              <li key={cause} className="flex items-start gap-2.5">
                <FilledWarningIcon className="mt-0.5 shrink-0 text-[#b42318]" />
                <span>{cause}</span>
              </li>
            ))}
            <li className="flex items-start gap-2.5">
              <MinusCircleIcon className="mt-0.5 shrink-0 text-slate-500" />
              <span className="text-slate-900">
                Numbers outside every total cannot be proven.
                {outsideTotalsSummary ? ` ${outsideTotalsSummary}.` : ""}
              </span>
            </li>
          </ul>

          <div className="mt-4 border-t border-slate-100 pt-4">
            {scores.failures.length === 0 ? (
              <p className="text-sm text-slate-500">
                {isRunning
                  ? "No failures recorded so far."
                  : "No failures recorded."}
              </p>
            ) : (
              <ul className="space-y-2.5" aria-label="Recorded failures">
                {scores.failures.map((failure, index) => (
                  <li
                    key={`${failure.company}-${failure.step}-${failure.number}-${index}`}
                    className="rounded-xl border border-red-200 bg-red-50/60 px-3.5 py-2.5 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">
                        {failure.company}
                      </span>
                      <span className="rounded bg-white px-2 py-0.5 font-mono text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">
                        {failure.step}
                      </span>
                    </div>
                    <p className="mt-1 text-xs font-medium text-slate-700">
                      {failure.number}
                    </p>
                    <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                      <div>
                        <dt className="inline">Page showed: </dt>
                        <dd className="inline font-mono font-semibold text-[#b42318]">
                          {failure.shown}
                        </dd>
                      </div>
                      <div>
                        <dt className="inline">Truth: </dt>
                        <dd className="inline font-mono font-semibold text-slate-900">
                          {failure.truth}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section
        aria-labelledby="recheck-heading"
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6"
      >
        <h2 id="recheck-heading" className="text-base font-bold text-slate-900">
          How sure is the re-check?
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          When Decision 1 says a number is on the page, how often is it right?
        </p>

        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-200 font-mono text-xs font-medium text-slate-500">
                <th scope="col" className="pb-2.5 pr-3 font-medium">
                  It said
                </th>
                <th scope="col" className="pb-2.5 px-2 text-right font-medium">
                  Answers
                </th>
                <th scope="col" className="pb-2.5 pl-2 text-right font-medium">
                  Truly there
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-[13px] sm:text-sm">
              {recheckRows.map((row) => (
                <tr key={row.said}>
                  <td className="py-3 pr-3 text-slate-900">{row.said}</td>
                  <td
                    className={`py-3 px-2 text-right font-mono tabular-nums ${
                      row.answers === "not run"
                        ? "text-slate-500"
                        : "text-slate-700"
                    }`}
                  >
                    {row.answers}
                  </td>
                  <td
                    className={`py-3 pl-2 text-right font-mono tabular-nums ${
                      row.trulyThere === "not run"
                        ? "text-slate-500"
                        : "font-semibold text-slate-900"
                    }`}
                  >
                    {row.trulyThere}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        aria-labelledby="limits-heading"
        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6"
      >
        <h2 id="limits-heading" className="text-base font-bold text-slate-900">
          Limits of this test
        </h2>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-slate-600">
          <li>
            {scores.stepsRun.F
              ? "The pictures are drawn from each filing's own table. Scans, photos and original layouts are harder. Step F is only a first look at that."
              : "The pictures are drawn from each filing's own table. Scans, photos and original layouts are harder. The test did not run on blurred or tilted copies, scans or photos."}
          </li>
          <li>
            Fifty filings find big problems. They do not measure a small failure
            rate. If 1 filing in 100 fails, a test of 50 shows it only about 40
            times in 100.
          </li>
          <li>
            A changed number outside every total cannot be caught from the
            picture alone. Step D therefore uses only numbers inside a group.
          </li>
        </ul>
      </section>

      {scores.filings.length > 0 && (
        <section
          aria-labelledby="filings-heading"
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6"
        >
          <h2
            id="filings-heading"
            className="text-base font-bold text-slate-900"
          >
            Filings scored ({formatInt(scores.filings.length)})
          </h2>

          <ul className="mt-4 space-y-2.5 md:hidden">
            {scores.filings.map((filing) => {
              const problem = isFilingProblem(filing);
              return (
                <li
                  key={`${filing.cik}-${filing.filed}`}
                  className={`rounded-xl border px-3.5 py-3 text-xs ${
                    problem
                      ? "border-red-200 bg-red-50/50"
                      : "border-slate-200 bg-slate-50/50"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      {filing.company}
                    </span>
                    <span className="shrink-0 font-mono text-slate-500">
                      {filing.form} · {filing.filed}
                    </span>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-slate-600">
                    <div>
                      <dt className="inline">Read right: </dt>
                      <dd className="inline font-mono text-slate-900">
                        {formatInt(filing.readRight)}/{formatInt(filing.numbers)}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Wrong ticked: </dt>
                      <dd
                        className={`inline font-mono ${
                          filing.wrongTicked > 0
                            ? "font-semibold text-[#b42318]"
                            : "text-slate-900"
                        }`}
                      >
                        {formatInt(filing.wrongTicked)}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">False alarm: </dt>
                      <dd
                        className={`inline font-mono ${
                          filing.flagged
                            ? "font-semibold text-[#b42318]"
                            : "text-slate-900"
                        }`}
                      >
                        {filing.flagged ? "Yes" : "No"}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Seconds: </dt>
                      <dd className="inline font-mono text-slate-900">
                        {formatFilingSeconds(filing.seconds)}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Hidden rebuilt: </dt>
                      <dd className="inline font-mono text-slate-900">
                        {formatBooleanStep(
                          filing.hiddenRebuilt,
                          scores.stepsRun.C,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Changed caught: </dt>
                      <dd className="inline font-mono text-slate-900">
                        {formatBooleanStep(
                          filing.changedCaught,
                          scores.stepsRun.D,
                        )}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-200 font-mono text-xs font-medium text-slate-500">
                  <th scope="col" className="pb-2.5 pr-3 font-medium">
                    Company
                  </th>
                  <th scope="col" className="pb-2.5 px-2 text-right font-medium">
                    Read right
                  </th>
                  <th scope="col" className="pb-2.5 px-2 text-right font-medium">
                    Wrong ticked
                  </th>
                  <th scope="col" className="pb-2.5 px-2 text-right font-medium">
                    False alarm
                  </th>
                  <th scope="col" className="pb-2.5 px-2 text-right font-medium">
                    Hidden rebuilt
                  </th>
                  <th scope="col" className="pb-2.5 px-2 text-right font-medium">
                    Changed caught
                  </th>
                  <th scope="col" className="pb-2.5 pl-2 text-right font-medium">
                    Seconds
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {scores.filings.map((filing) => {
                  const problem = isFilingProblem(filing);
                  return (
                    <tr
                      key={`${filing.cik}-${filing.filed}`}
                      className={problem ? "bg-red-50/40" : undefined}
                    >
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-slate-900">
                          {filing.company}
                        </div>
                        <div className="font-mono text-xs text-slate-500">
                          {filing.form} · {filing.filed}
                        </div>
                      </td>
                      <td className="py-2.5 px-2 text-right font-mono tabular-nums text-slate-700">
                        {formatInt(filing.readRight)}/{formatInt(filing.numbers)}
                      </td>
                      <td
                        className={`py-2.5 px-2 text-right font-mono tabular-nums ${
                          filing.wrongTicked > 0
                            ? "font-semibold text-[#b42318]"
                            : "text-slate-700"
                        }`}
                      >
                        {formatInt(filing.wrongTicked)}
                      </td>
                      <td
                        className={`py-2.5 px-2 text-right font-mono ${
                          filing.flagged
                            ? "font-semibold text-[#b42318]"
                            : "text-slate-700"
                        }`}
                      >
                        {filing.flagged ? "Yes" : "No"}
                      </td>
                      <td
                        className={`py-2.5 px-2 text-right font-mono ${
                          filing.hiddenRebuilt === false
                            ? "font-semibold text-[#b42318]"
                            : "text-slate-700"
                        }`}
                      >
                        {formatBooleanStep(
                          filing.hiddenRebuilt,
                          scores.stepsRun.C,
                        )}
                      </td>
                      <td
                        className={`py-2.5 px-2 text-right font-mono ${
                          filing.changedCaught === false
                            ? "font-semibold text-[#b42318]"
                            : "text-slate-700"
                        }`}
                      >
                        {formatBooleanStep(
                          filing.changedCaught,
                          scores.stepsRun.D,
                        )}
                      </td>
                      <td className="py-2.5 pl-2 text-right font-mono tabular-nums text-slate-700">
                        {formatFilingSeconds(filing.seconds)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {scores.skipped.length > 0 && (
        <section
          aria-labelledby="skipped-heading"
          className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs sm:p-6"
        >
          <details>
            <summary
              id="skipped-heading"
              className="cursor-pointer text-sm font-semibold text-slate-900"
            >
              Skipped companies ({formatInt(scores.skipped.length)})
            </summary>
            <ul className="mt-3 divide-y divide-slate-100 text-sm">
              {scores.skipped.map((item) => (
                <li
                  key={`${item.company}-${item.reason}`}
                  className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                >
                  <span className="font-medium text-slate-900">
                    {item.company}
                  </span>
                  <span className="text-slate-600">{item.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </main>
  );
}

export function ResultsView({ state }: { state: ScoresLoadResult }) {
  if (state.kind === "empty") {
    return <EmptyResultsState />;
  }
  if (state.kind === "error") {
    return <ErrorResultsState message={state.message} />;
  }
  return <ReadyResultsView scores={state.scores} />;
}
