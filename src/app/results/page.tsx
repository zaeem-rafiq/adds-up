import { Suspense } from "react";
import { connection } from "next/server";
import { ResultsView } from "@/components/ResultsView";
import { loadScores } from "@/lib/scores";

async function ResultsContent({
  searchParams,
}: Pick<PageProps<"/results">, "searchParams">) {
  await connection();
  const resolvedSearchParams = await searchParams;
  const rawQuery = resolvedSearchParams.scores;
  const fixtureQuery = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  const state = await loadScores({ fixtureQuery });
  return <ResultsView state={state} />;
}

export default function ResultsPage({ searchParams }: PageProps<"/results">) {
  return (
    <Suspense
      fallback={
        <main className="mx-auto w-full max-w-[1160px] px-4 py-6 sm:px-6 sm:py-8">
          <div
            role="status"
            className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-2xs"
          >
            Loading test results...
          </div>
        </main>
      }
    >
      <ResultsContent searchParams={searchParams} />
    </Suspense>
  );
}
