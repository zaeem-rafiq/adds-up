import { CompanySearch } from "@/components/CompanySearch";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-[820px] px-4 pb-16 pt-10 sm:px-6 sm:pt-16 md:pt-20">
      <div className="text-center">
        <h1 className="mx-auto max-w-[660px] text-[30px] font-bold leading-[1.16] tracking-tight text-slate-900 sm:text-[40px] md:text-[44px]">
          Which company&apos;s balance sheet should we check?
        </h1>
        <p className="mx-auto mt-3.5 max-w-[560px] text-base leading-relaxed text-slate-600 sm:text-lg">
          Adds Up reads it from a picture and proves the numbers it read.
        </p>
      </div>

      <section aria-label="Company search" className="mt-8 sm:mt-9">
        <CompanySearch />
      </section>

      <section
        aria-label="Capabilities and limits"
        className="mx-auto mt-10 grid max-w-[780px] grid-cols-1 gap-4 sm:mt-12 md:grid-cols-2 md:gap-5"
      >
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
          <h2 className="text-base font-bold text-slate-900">
            What it does well
          </h2>
          <ul className="mt-4 space-y-3.5 text-[15px] leading-snug text-slate-800">
            <li className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#156d3b] text-white"
                aria-hidden="true"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M2.5 6.2L4.9 8.6L9.5 3.6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Reads every number on a balance sheet picture.</span>
            </li>
            <li className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#156d3b] text-white"
                aria-hidden="true"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M2.5 6.2L4.9 8.6L9.5 3.6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Proves each number that sits inside a total.</span>
            </li>
            <li className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#156d3b] text-white"
                aria-hidden="true"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M2.5 6.2L4.9 8.6L9.5 3.6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <span>Rebuilds a hidden number. Catches a changed one.</span>
            </li>
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-2xs">
          <h2 className="text-base font-bold text-slate-900">
            What it will not do
          </h2>
          <ul className="mt-4 space-y-3.5 text-[15px] leading-snug text-slate-800">
            <li className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-slate-500"
                aria-hidden="true"
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 20 20"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <circle
                    cx="10"
                    cy="10"
                    r="8.2"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <path
                    d="M6.5 10H13.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span>
                Guess. A number outside every total is marked &quot;not
                proven&quot;.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-[#c98706] text-xs font-bold text-white"
                aria-hidden="true"
              >
                ?
              </span>
              <span>Hide doubt. When two readings differ, the number gets no tick.</span>
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
}
