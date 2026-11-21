import { NextRequest, NextResponse } from "next/server";
import { CompanyListError, loadCompanyList, searchCompanies } from "@/lib/companies";
import { logServerError, publicCompanyListError } from "@/lib/public-errors";

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
      const { status, message } = publicCompanyListError(error);
      return NextResponse.json({ error: message, companies: [] }, { status });
    }

    logServerError("searching companies", error);
    return NextResponse.json(
      { error: "Company search failed. Please try again.", companies: [] },
      { status: 500 },
    );
  }
}
