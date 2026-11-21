import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatementView } from "@/components/StatementView";
import {
  findCompanyByCik,
  isValidCik,
  normalizeCik,
  type Company,
} from "@/lib/companies";
import {
  COMPANY_LOAD_FAILED_MESSAGE,
  logServerError,
  publicStatementError,
} from "@/lib/public-errors";
import { loadStatement, type StatementLoadResult } from "@/lib/statements";

function extractQueryValues(
  raw: string | string[] | undefined,
): string[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => item.trim()).filter(Boolean);
}

async function CompanyStatementContent({
  params,
  searchParams,
}: Pick<PageProps<"/company/[cik]">, "params" | "searchParams">) {
  const { cik } = await params;
  if (!isValidCik(cik)) {
    notFound();
  }
  const resolvedSearchParams = await searchParams;
  const isTestMode = process.env.ADDS_UP_TEST === "1";
  const slowParam = resolvedSearchParams.slow;
  const slowMode =
    isTestMode &&
    (slowParam === "1" || (Array.isArray(slowParam) && slowParam.includes("1")));
  const testDoubtLabels = isTestMode
    ? extractQueryValues(resolvedSearchParams.doubt)
    : [];
  const testUnsureLabels = isTestMode
    ? extractQueryValues(resolvedSearchParams.unsure)
    : [];
  const normalizedCik = normalizeCik(cik);

  let company: Company | null = null;
  let companyListError: string | null = null;

  try {
    company = await findCompanyByCik(normalizedCik);
  } catch (error) {
    logServerError("looking up a company", error);
    companyListError = COMPANY_LOAD_FAILED_MESSAGE;
  }

  // If the company list loaded and the company is not in it, show the not-listed message.
  if (!companyListError && !company) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
        <p className="text-base font-semibold text-slate-900">
          This company is not in the SEC&apos;s list.
        </p>
        <p className="mt-2 text-sm text-slate-600">
          <Link
            href="/"
            className="font-semibold text-[#1d4ea8] underline underline-offset-2 hover:text-[#173f8a]"
          >
            Check a statement
          </Link>
        </p>
      </div>
    );
  }

  let statementResult: StatementLoadResult | null = null;
  let statementError: string | null = null;

  try {
    statementResult = await loadStatement(normalizedCik, {
      companyName: company?.name,
    });
  } catch (error) {
    statementError = publicStatementError(error).message;
  }

  if (statementResult) {
    const pictureUrl = `/api/company/${encodeURIComponent(statementResult.statement.cik)}/picture`;
    return (
      <StatementView
        statement={statementResult.statement}
        source={statementResult.source}
        pictureUrl={pictureUrl}
        slowMode={slowMode}
        testDoubtLabels={testDoubtLabels}
        testUnsureLabels={testUnsureLabels}
      />
    );
  }

  // No statement loaded (and no saved copy). If we have the company from the SEC list,
  // keep showing its name heading with a plain error below.
  if (company) {
    return (
      <div className="space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-2xs sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
              {company.name}
            </h1>
            <Link
              href="/"
              className="inline-flex w-fit shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50"
            >
              Change company
            </Link>
          </div>
        </section>

        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-900"
        >
          <p className="font-semibold">{statementError}</p>
          <p className="mt-2">
            <Link
              href="/"
              className="font-semibold text-red-900 underline underline-offset-2"
            >
              Back to start
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-900"
    >
      <p className="font-semibold">{statementError ?? companyListError}</p>
      <p className="mt-2">
        <Link
          href="/"
          className="font-semibold text-red-900 underline underline-offset-2"
        >
          Back to start
        </Link>
      </p>
    </div>
  );
}

export default function CompanyStatementPage({
  params,
  searchParams,
}: PageProps<"/company/[cik]">) {
  return (
    <main className="mx-auto w-full max-w-[1160px] px-4 py-6 sm:px-6 sm:py-8">
      <Suspense
        fallback={
          <div
            role="status"
            className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-2xs"
          >
            <svg
              className="h-5 w-5 shrink-0 animate-spin text-[#1d4ea8]"
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
            <span>Loading balance sheet...</span>
          </div>
        }
      >
        <CompanyStatementContent params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
