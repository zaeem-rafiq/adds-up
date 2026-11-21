"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

function NavLinks({ isResults }: { isResults: boolean }) {
  const isStatementFlow = !isResults;

  return (
    <nav aria-label="Main navigation" className="flex items-center gap-1 sm:gap-2">
      <Link
        href="/"
        prefetch={false}
        aria-current={isStatementFlow ? "page" : undefined}
        className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] transition-colors sm:px-3 sm:text-sm ${
          isStatementFlow
            ? "bg-slate-100 font-semibold text-slate-900"
            : "font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        }`}
      >
        Check a statement
      </Link>
      <Link
        href="/results"
        prefetch={false}
        aria-current={isResults ? "page" : undefined}
        className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px] transition-colors sm:px-3 sm:text-sm ${
          isResults
            ? "bg-slate-100 font-semibold text-slate-900"
            : "font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900"
        }`}
      >
        Test results
      </Link>
    </nav>
  );
}

function ActiveNavLinks() {
  const pathname = usePathname();
  const isResults = pathname === "/results" || pathname.startsWith("/results/");
  return <NavLinks isResults={isResults} />;
}

export function TopBar() {
  return (
    <header className="w-full border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-2 px-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Link
            href="/"
            prefetch={false}
            className="flex shrink-0 items-center gap-2 text-slate-900 no-underline"
          >
            <span
              className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-900 text-white"
              aria-hidden="true"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <rect x="2.5" y="3.5" width="11" height="1.8" rx="0.9" fill="currentColor" />
                <rect x="2.5" y="7.1" width="11" height="1.8" rx="0.9" fill="currentColor" />
                <rect x="2.5" y="10.7" width="11" height="1.8" rx="0.9" fill="currentColor" />
              </svg>
            </span>
            <span className="text-[15px] font-bold tracking-tight sm:text-base">
              Adds Up
            </span>
          </Link>

          <Suspense fallback={<NavLinks isResults={false} />}>
            <ActiveNavLinks />
          </Suspense>
        </div>

        <p className="hidden shrink-0 text-xs text-slate-500 md:block lg:text-[13px]">
          Reads a statement from a picture. Proves the numbers.
        </p>
      </div>
    </header>
  );
}
