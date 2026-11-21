import Link from "next/link";
import {
  formatFilingDate,
  type Statement,
  type StatementSource,
} from "@/lib/statements";

type StatementViewProps = {
  statement: Statement;
  source: StatementSource;
  pictureUrl: string;
};

export function StatementView({
  statement,
  source,
  pictureUrl,
}: StatementViewProps) {
  const formattedDate = formatFilingDate(statement.filingDate);
  const reportLabel =
    statement.form === "10-K" ? "annual report" : "quarterly report";

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

      <section className="rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-2xs sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              {statement.companyName}
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Balance sheet · {statement.form} ({reportLabel}) · filed{" "}
              {formattedDate}
            </p>
          </div>

          <Link
            href="/"
            className="inline-flex w-fit shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8]"
          >
            Change company
          </Link>
        </div>
      </section>

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
    </div>
  );
}
