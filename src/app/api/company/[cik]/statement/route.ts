import { NextRequest, NextResponse } from "next/server";
import { findCompanyByCik, isValidCik } from "@/lib/companies";
import { publicStatementError, SAVED_COPY_MESSAGE } from "@/lib/public-errors";
import { loadStatement } from "@/lib/statements";

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/company/[cik]/statement">,
) {
  const { cik } = await context.params;
  if (!isValidCik(cik)) {
    return NextResponse.json({ error: "Company not found." }, { status: 404 });
  }

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
        // The SEC's own error text stays in the server log.
        ...(result.fallbackReason
          ? { fallbackReason: SAVED_COPY_MESSAGE }
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
    const { status, message } = publicStatementError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
