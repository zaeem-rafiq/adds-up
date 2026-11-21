import { NextRequest, NextResponse } from "next/server";
import { findCompanyByCik } from "@/lib/companies";
import { loadStatement, StatementError } from "@/lib/statements";

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/company/[cik]/statement">,
) {
  const { cik } = await context.params;

  let companyName = "";
  try {
    const company = await findCompanyByCik(cik);
    if (company) {
      companyName = company.name;
    }
  } catch {
    // Allow saved-copy fallback even if the SEC company list is unreachable.
  }

  try {
    const result = await loadStatement(cik, { companyName });
    return NextResponse.json(
      {
        statement: result.statement,
        source: result.source,
        ...(result.fallbackReason
          ? { fallbackReason: result.fallbackReason }
          : {}),
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof StatementError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    return NextResponse.json(
      { error: "Could not load this company's balance sheet." },
      { status: 500 },
    );
  }
}
