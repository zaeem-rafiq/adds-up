import { NextResponse, type NextRequest } from "next/server";
import { isValidCik } from "@/lib/cik";

// The company page streams its content inside <Suspense>, so a notFound() thrown there keeps
// the status 200. This check runs before the page starts, so a bad "cik" gets a real 404.
// The page and every route under /api/company/[cik] check the value again.
export function proxy(request: NextRequest) {
  const segments = request.nextUrl.pathname.split("/");
  if (segments.length === 3 && segments[1] === "company") {
    if (!isValidCik(segments[2] ?? "")) {
      return new NextResponse("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/company/:cik"],
};
