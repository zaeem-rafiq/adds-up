import { Suspense } from "react";
import Link from "next/link";
import { CompanyListError, findCompanyByCik, type Company } from "@/lib/companies";

async function CompanyStatementContent({
  params,
}: Pick<PageProps<"/company/[cik]">, "params">) {
  const { cik } = await params;

  let company: Company | null = null;
  let errorMessage: string | null = null;

  try {
    company = await findCompanyByCik(cik);
  } catch (error) {
    errorMessage =
      error instanceof CompanyListError
        ? error.message
        : "Could not load the company right now. Please try again.";
  }

  if (errorMessage) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-900"
      >
        <p className="font-semibold">{errorMessage}</p>
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

  if (!company) {
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

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
        {company.name}
      </h1>
    </div>
  );
}

export default function CompanyStatementPage({
  params,
}: PageProps<"/company/[cik]">) {
  return (
    <main className="mx-auto w-full max-w-[1040px] px-4 py-8 sm:px-6 sm:py-10">
      <Suspense
        fallback={
          <div
            role="status"
            className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-2xs"
          >
            Loading company...
          </div>
        }
      >
        <CompanyStatementContent params={params} />
      </Suspense>
    </main>
  );
}
