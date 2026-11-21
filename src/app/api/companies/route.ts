import { NextRequest, NextResponse } from "next/server";
import { CompanyListError, loadCompanyList, searchCompanies } from "@/lib/companies";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? "";
  if (!query.trim()) {
    return NextResponse.json({ companies: [] });
  }

  try {
    const companies = await loadCompanyList();
    const matches = searchCompanies(companies, query);
    return NextResponse.json({ companies: matches });
  } catch (error) {
    if (error instanceof CompanyListError) {
      return NextResponse.json(
        { error: error.message, companies: [] },
        { status: error.status },
      );
    }

    return NextResponse.json(
      { error: "Company search failed. Please try again.", companies: [] },
      { status: 500 },
    );
  }
}
