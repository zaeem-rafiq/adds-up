import { Suspense } from "react";
import { connection } from "next/server";
import { UploadExpiredView, UploadView } from "@/components/UploadView";
import { getGlobalUploadStore } from "@/lib/uploads";

async function UploadPageContent({
  params,
  searchParams,
}: Pick<PageProps<"/upload/[id]">, "params" | "searchParams">) {
  await connection();
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const isTestMode = process.env.ADDS_UP_TEST === "1";
  const slowParam = resolvedSearchParams.slow;
  const slowMode =
    isTestMode &&
    (slowParam === "1" || (Array.isArray(slowParam) && slowParam.includes("1")));

  const store = getGlobalUploadStore();
  const record = store.get(id);

  if (!record) {
    return <UploadExpiredView />;
  }

  return (
    <UploadView
      uploadId={record.id}
      fileName={record.fileName}
      pictureUrl={`/api/upload/${encodeURIComponent(record.id)}/picture`}
      slowMode={slowMode}
    />
  );
}

export default function UploadPage({
  params,
  searchParams,
}: PageProps<"/upload/[id]">) {
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
            <span>Loading uploaded statement...</span>
          </div>
        }
      >
        <UploadPageContent params={params} searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
