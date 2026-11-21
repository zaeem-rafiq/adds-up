"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Company } from "@/lib/companies";
import { validateUploadFileMeta } from "@/lib/upload-validation";

const EXAMPLE_COMPANIES: readonly Company[] = [
  { cik: "320193", ticker: "AAPL", name: "Apple Inc." },
  { cik: "909832", ticker: "COST", name: "Costco Wholesale Corp" },
  { cik: "46195", ticker: "BOH", name: "Bank of Hawaii Corp" },
];

const EXAMPLE_LABELS: Record<string, string> = {
  "320193": "Apple",
  "909832": "Costco",
  "46195": "Bank of Hawaii",
};

type SearchResponse = {
  companies?: Company[];
  error?: string;
};

export function CompanySearch() {
  const router = useRouter();
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Company[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notListedQuery, setNotListedQuery] = useState<string | null>(null);
  const [lastSearchedQuery, setLastSearchedQuery] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showEmptyHint, setShowEmptyHint] = useState(false);

  async function runSearch(trimmedQuery: string): Promise<Company[] | null> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setErrorMessage(null);
    setNotListedQuery(null);

    try {
      const response = await fetch(
        `/api/companies?q=${encodeURIComponent(trimmedQuery)}`,
        { signal: controller.signal },
      );
      const data = (await response.json()) as SearchResponse;

      if (controller.signal.aborted) return null;

      if (!response.ok || data.error) {
        setMatches([]);
        setIsOpen(false);
        setNotListedQuery(null);
        setErrorMessage(
          data.error ?? "Company search failed. Please try again.",
        );
        setLastSearchedQuery(trimmedQuery);
        return null;
      }

      const nextMatches = data.companies ?? [];
      setMatches(nextMatches);
      setActiveIndex(0);
      setLastSearchedQuery(trimmedQuery);

      if (nextMatches.length > 0) {
        setIsOpen(true);
        setNotListedQuery(null);
      } else {
        setIsOpen(false);
        setNotListedQuery(trimmedQuery);
      }

      return nextMatches;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }
      setMatches([]);
      setIsOpen(false);
      setNotListedQuery(null);
      setErrorMessage("Could not search companies right now. Please try again.");
      setLastSearchedQuery(trimmedQuery);
      return null;
    } finally {
      if (abortRef.current === controller) {
        setIsLoading(false);
      }
    }
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }

    const timer = setTimeout(() => {
      void runSearch(trimmed);
    }, 100);

    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  function handleQueryChange(nextValue: string) {
    setQuery(nextValue);
    setShowEmptyHint(false);

    if (!nextValue.trim()) {
      abortRef.current?.abort();
      setMatches([]);
      setActiveIndex(0);
      setIsOpen(false);
      setIsLoading(false);
      setErrorMessage(null);
      setNotListedQuery(null);
      setLastSearchedQuery("");
    }
  }

  useEffect(() => {
    function handleOutsideClick(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function pickCompany(company: Company) {
    setIsOpen(false);
    router.push(`/company/${encodeURIComponent(company.cik)}`);
    // QA: the start screen can be kept alive while away, so "Start over"
    // should come back to an empty box with no open list.
    setQuery("");
    setMatches([]);
    setActiveIndex(0);
    setNotListedQuery(null);
  }

  async function handleFileSelected(file: File | null | undefined) {
    if (!file) return;
    setUploadError(null);

    const validation = validateUploadFileMeta({
      name: file.name,
      type: file.type,
      size: file.size,
    });
    if (!validation.ok) {
      setUploadError(validation.message);
      return;
    }

    setIsUploading(true);
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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setShowEmptyHint(true);
      inputRef.current?.focus();
      return;
    }

    if (lastSearchedQuery === trimmed && matches.length > 0) {
      const selected = matches[activeIndex] ?? matches[0];
      if (selected) {
        pickCompany(selected);
        return;
      }
    }

    const freshMatches = await runSearch(trimmed);
    if (freshMatches && freshMatches.length > 0) {
      pickCompany(freshMatches[0]);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      if (matches.length === 0) return;
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((prev) => (prev + 1) % matches.length);
      return;
    }

    if (event.key === "ArrowUp") {
      if (matches.length === 0) return;
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((prev) => (prev - 1 + matches.length) % matches.length);
      return;
    }

    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }

    if (event.key === "Enter" && isOpen && matches.length > 0) {
      event.preventDefault();
      const selected = matches[activeIndex] ?? matches[0];
      if (selected) {
        pickCompany(selected);
      }
    }
  }

  const activeOptionId =
    isOpen && matches[activeIndex]
      ? `${listboxId}-option-${activeIndex}`
      : undefined;

  return (
    <div className="mx-auto w-full max-w-[680px]">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 sm:flex-row sm:items-stretch"
      >
        <div ref={containerRef} className="relative flex-1">
          <div className="flex h-[52px] items-center rounded-xl border border-slate-800 bg-white px-3.5 shadow-xs focus-within:ring-2 focus-within:ring-blue-700/25">
            <svg
              className="mr-2.5 h-[18px] w-[18px] shrink-0 text-slate-600"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <circle cx="9" cy="9" r="6" />
              <path d="M13.5 13.5L17.5 17.5" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => handleQueryChange(event.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (matches.length > 0) setIsOpen(true);
              }}
              placeholder="Type a US public company"
              aria-label="Type a US public company"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={isOpen}
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-transparent text-[15px] text-slate-900 placeholder:text-slate-500 focus:outline-none sm:text-base"
            />
          </div>

          {isLoading && (
            <div
              role="status"
              className="absolute left-0 right-0 top-full z-20 mt-1.5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-lg"
            >
              Searching companies...
            </div>
          )}

          {!isLoading && isOpen && matches.length > 0 && (
            <ul
              id={listboxId}
              role="listbox"
              aria-label="Matching companies"
              className="absolute left-0 right-0 top-full z-20 mt-1.5 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
            >
              {matches.map((company, index) => {
                const isSelected = index === activeIndex;
                return (
                  <li
                    key={`${company.cik}-${company.ticker}`}
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => pickCompany(company)}
                    className={`flex cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors sm:text-[15px] ${
                      isSelected
                        ? "bg-blue-50 text-slate-900"
                        : "text-slate-800 hover:bg-slate-50"
                    }`}
                  >
                    <span className="w-16 shrink-0 font-mono text-xs font-semibold tracking-wide text-slate-700 sm:text-[13px]">
                      {company.ticker}
                    </span>
                    <span className="truncate font-medium text-slate-900">
                      {company.name}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <button
          type="submit"
          className="h-[52px] shrink-0 cursor-pointer rounded-xl bg-[#1d4ea8] px-7 text-[15px] font-semibold text-white transition-colors hover:bg-[#173f8a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8] sm:text-base"
        >
          Check it
        </button>
      </form>

      {showEmptyHint && (
        <p
          role="status"
          data-empty-hint="true"
          className="mx-auto mt-3 max-w-[560px] text-center text-sm text-slate-700"
        >
          Type a company name or ticker first, such as Apple or AAPL.
        </p>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="mx-auto mt-4 flex max-w-[560px] flex-col gap-2.5 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 text-left text-sm text-red-900 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <svg
              className="mt-0.5 h-5 w-5 shrink-0 text-red-700"
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
            <p className="leading-relaxed">{errorMessage}</p>
          </div>
          {lastSearchedQuery && (
            <button
              type="button"
              onClick={() => void runSearch(lastSearchedQuery)}
              className="w-fit shrink-0 cursor-pointer rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-900 transition-colors hover:bg-red-100"
            >
              Try again
            </button>
          )}
        </div>
      )}

      {uploadError && (
        <div
          role="alert"
          data-upload-error="true"
          className="mx-auto mt-4 flex max-w-[560px] items-start gap-3 rounded-xl border border-amber-200 bg-[#fceee5] px-4 py-3.5 text-left text-sm text-[#7c2d12]"
        >
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-[#9a3412]"
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
          <p className="leading-relaxed font-medium">{uploadError}</p>
        </div>
      )}

      {isUploading && (
        <div
          role="status"
          className="mx-auto mt-4 flex max-w-[560px] items-center justify-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-2xs"
        >
          <svg
            className="h-4 w-4 shrink-0 animate-spin text-[#1d4ea8]"
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
          <span>Uploading statement picture...</span>
        </div>
      )}

      {notListedQuery && !errorMessage && (
        <div
          role="status"
          className="mx-auto mt-4 flex max-w-[560px] items-start gap-3 rounded-xl bg-[#fceee5] px-4 py-3.5 text-left text-sm text-[#7c2d12]"
        >
          <svg
            className="mt-0.5 h-5 w-5 shrink-0 text-[#9a3412]"
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
          <div className="min-w-0 space-y-0.5 leading-relaxed">
            <p className="font-semibold [overflow-wrap:anywhere]">
              {notListedQuery.length > 60
                ? `${notListedQuery.slice(0, 60)}…`
                : notListedQuery}{" "}
              is not in the SEC&apos;s list.
            </p>
            <p>
              Private and foreign companies do not file there. Pick a listed
              company, or upload a statement.
            </p>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <span className="text-sm text-slate-600">Try an example</span>
        {EXAMPLE_COMPANIES.map((company) => (
          // QA: a link works on a slow phone before the page's script loads.
          <Link
            key={company.cik}
            href={`/company/${encodeURIComponent(company.cik)}`}
            prefetch={false}
            className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8]"
          >
            {EXAMPLE_LABELS[company.cik]}
          </Link>
        ))}
        <span className="text-sm text-slate-500">or</span>
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
            void handleFileSelected(file);
          }}
        />
        <button
          type="button"
          disabled={isUploading}
          onClick={() => fileInputRef.current?.click()}
          className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-900 shadow-2xs transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ea8] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Upload a statement
        </button>
      </div>
      <p
        data-upload-note="true"
        className="mx-auto mt-3 max-w-[560px] text-center text-xs leading-relaxed text-slate-600"
      >
        Upload one page as a PNG or JPEG, up to 8 MB. Google&apos;s Gemini
        models read it. It stays in server memory for one hour and is never
        saved to disk. Anyone with its link can open it during that hour.
      </p>
    </div>
  );
}
