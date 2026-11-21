import { NextResponse, type NextRequest } from "next/server";
import { isValidCik } from "@/lib/cik";

// The company page streams its content inside <Suspense>, so a notFound() thrown there keeps
// the status 200. This check runs before the page starts, so a bad "cik" gets a real 404.
// The page and every route under /api/company/[cik] check the value again.
export function proxy(request: NextRequest) {
  const segments = request.nextUrl.pathname.split("/");
  if (segments.length === 3 && segments[1] === "company") {
    if (!isValidCik(segments[2] ?? "")) {
      // QA: show the app's own 404 page (with the top bar) instead of a bare
      // "Not Found" line. The path below does not exist, so it renders the
      // not-found page with a 404 status.
      return NextResponse.rewrite(new URL("/company-not-found", request.url), {
        status: 404,
      });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/company/:cik"],
};
