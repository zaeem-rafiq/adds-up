import { NextRequest, NextResponse } from "next/server";
import { findCompanyByCik, isValidCik } from "@/lib/companies";
import {
  drawStatementPng,
  type DrawStatementOptions,
} from "@/lib/draw-statement";
import { findStatementRowIndexForNumberRow } from "@/lib/reading";
import { loadStatement, StatementError } from "@/lib/statements";

function parseNonNegInt(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/company/[cik]/picture">,
) {
  const { cik } = await context.params;
  if (!isValidCik(cik)) {
    return NextResponse.json({ error: "Company not found." }, { status: 404 });
  }
  const params = request.nextUrl.searchParams;

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
    const drawOptions: DrawStatementOptions = {};

    const hideRow = parseNonNegInt(params.get("hideRow"));
    const hideCol = parseNonNegInt(params.get("hideCol"));
    const changeRow = parseNonNegInt(params.get("changeRow"));
    const changeCol = parseNonNegInt(params.get("changeCol"));
    const changeValue = params.get("changeValue");

    if (hideRow !== null && (hideCol === 0 || hideCol === 1)) {
      const stmtRowIdx = findStatementRowIndexForNumberRow(
        result.statement,
        hideRow,
      );
      if (stmtRowIdx !== -1) {
        drawOptions.coverCell = { rowIndex: stmtRowIdx, colIndex: hideCol };
      }
    } else if (
      changeRow !== null &&
      (changeCol === 0 || changeCol === 1) &&
      changeValue &&
      changeValue.trim().length > 0 &&
      changeValue.trim().length <= 32
    ) {
      const stmtRowIdx = findStatementRowIndexForNumberRow(
        result.statement,
        changeRow,
      );
      if (stmtRowIdx !== -1) {
        drawOptions.overrideCell = {
          rowIndex: stmtRowIdx,
          colIndex: changeCol,
          value: changeValue.trim(),
        };
      }
    }

    const png = drawStatementPng(result.statement, drawOptions);
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
