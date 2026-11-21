import { NextRequest, NextResponse } from "next/server";
import { findCompanyByCik } from "@/lib/companies";
import { drawStatementPng } from "@/lib/draw-statement";
import { loadStatement, StatementError } from "@/lib/statements";

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/company/[cik]/picture">,
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
    const png = drawStatementPng(result.statement);
    return new NextResponse(new Uint8Array(png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof StatementError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }

    return NextResponse.json(
      { error: "Could not draw the balance sheet picture." },
      { status: 500 },
    );
  }
}
