import Link from "next/link";
import { CompanySearch } from "@/components/CompanySearch";
import scores from "../../data/scores.json";

// The proof numbers come from the 50-filing test's own results file, so the
// start screen can never drift from the "Test results" page.
const addsUp = scores.totals.addsUp;
const formatCount = (value: number) => value.toLocaleString("en-US");
const PROOF_NUMBERS = [
  {
    value: `${formatCount(addsUp.wrongShownAsRight)} of ${formatCount(addsUp.numbers)}`,
    label: `numbers were wrong and still got a tick, on ${scores.filingsScored} SEC filings a script picked.`,
  },
  {
    value: `${formatCount(addsUp.hiddenRebuilt)} of ${formatCount(addsUp.hiddenTried)}`,
    label: "hidden numbers rebuilt by plain arithmetic.",
  },
  {
    value: `${formatCount(addsUp.changedCaught)} of ${formatCount(addsUp.changedTried)}`,
    label: "changed numbers caught, with no hint given.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-8 sm:px-6 sm:pt-12 md:pt-14">
      <div className="text-center">
        <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-2xs sm:text-[13px]">
          <span
            className="h-1.5 w-1.5 rounded-full bg-[#156d3b]"
            aria-hidden="true"
          />
          Real SEC filings, read by AI from a picture
        </p>
        <h1 className="mx-auto mt-4 max-w-[720px] text-[32px] font-bold leading-[1.12] tracking-tight text-slate-900 sm:text-[44px] md:text-[50px]">
          A wrong number looks just like a right one.
        </h1>
        <p className="mx-auto mt-4 max-w-[640px] text-base leading-relaxed text-slate-700 sm:text-lg">
          AI gets{" "}
          <strong className="font-bold text-[#b53800]">9% to 18%</strong> of
          the figures in annual reports wrong. Lenders get statements like
          these as PDFs, and nothing marks the wrong numbers.
        </p>
        <p className="mx-auto mt-1.5 max-w-[640px] text-xs text-slate-600">
          Source: study of 5,000 annual reports, reported by Thomson Reuters,
          March 2026.
        </p>
        <p className="mx-auto mt-4 max-w-[640px] text-base font-semibold leading-relaxed text-slate-900 sm:text-lg">
          Adds Up re-adds every total. A number gets a tick only when the sums
          prove it.
        </p>
      </div>

      <section
        aria-label="Company search"
        className="mt-7 rounded-2xl border border-slate-200 bg-white px-4 py-6 shadow-xs sm:mt-8 sm:px-8 sm:py-7"
      >
        <h2 className="text-center text-lg font-bold text-slate-900 sm:text-xl">
          Which company&apos;s balance sheet should we check?
        </h2>
        <p className="mx-auto mt-1.5 max-w-[560px] text-center text-sm leading-relaxed text-slate-600">
          In about 10 seconds, each number the sums prove gets a tick. Then
          hide a ticked number, and Adds Up works out what it was.
        </p>
        <div className="mt-5">
          <CompanySearch />
        </div>
      </section>

      <section aria-label="Test results in brief" className="mt-8 sm:mt-10">
        <h2 className="text-center text-base font-bold text-slate-900 sm:text-lg">
          Tested on filings we did not pick
        </h2>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
          {PROOF_NUMBERS.map((item) => (
            <li
              key={item.label}
              className="rounded-2xl border border-slate-200 bg-white p-5 text-center shadow-2xs"
            >
              <p className="font-mono text-[28px] font-bold leading-none tabular-nums tracking-tight text-[#156d3b] sm:text-[30px]">
                {item.value}
              </p>
              <p className="mt-2 text-sm leading-snug text-slate-700">
                {item.label}
              </p>
            </li>
          ))}
        </ul>
        <p className="mx-auto mt-4 max-w-[660px] text-center text-sm leading-relaxed text-slate-700">
          Plain AI also read these clean pages right. You just cannot check
          it. On bad photos, Adds Up gave some wrong ticks too. Every miss is
          listed.
        </p>
        <p className="mt-2 text-center">
          <Link
            href="/results"
            prefetch={false}
            className="text-sm font-semibold text-[#1d4ea8] underline underline-offset-2 hover:text-[#173f8a]"
          >
            See all {scores.filingsScored} filings and every failure
          </Link>
        </p>
      </section>

      <section
        aria-label="Capabilities and limits"
        className="mx-auto mt-8 grid grid-cols-1 gap-4 sm:mt-10 md:grid-cols-2 md:gap-5"
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

      <p className="mx-auto mt-10 max-w-[620px] text-center text-xl font-bold leading-snug tracking-tight text-slate-900 sm:mt-12 sm:text-2xl">
        A right answer you cannot check is still a guess.
      </p>
    </main>
  );
}
