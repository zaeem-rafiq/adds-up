// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { StatementView } from "./StatementView";
import type { Statement } from "@/lib/statements";

const SAMPLE_STATEMENT: Statement = {
  cik: "320193",
  companyName: "Apple Inc.",
  form: "10-K",
  filingDate: "2026-11-03",
  title: "CONSOLIDATED BALANCE SHEETS",
  columns: ["Sep. 26, 2026", "Sep. 27, 2025"],
  unitLine: "USD ($) $ in Millions",
  rows: [
    { kind: "heading", label: "Current assets:", indent: 0 },
    {
      kind: "number",
      label: "Cash and cash equivalents",
      indent: 1,
      isTotal: false,
      values: ["$ 36,305", "$ 35,934"],
      numbers: [36305, 35934],
    },
  ],
};

describe("StatementView", () => {
  afterEach(() => {
    cleanup();
  });

  test("shows company name, form, filing date and balance sheet picture without saved banner on live source", () => {
    render(
      <StatementView
        statement={SAMPLE_STATEMENT}
        source="sec"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Apple Inc." }),
    ).toBeInTheDocument();
    expect(screen.getByText(/10-K/)).toBeInTheDocument();
    expect(screen.getByText(/Nov 3, 2026/)).toBeInTheDocument();
    expect(screen.getByText("Picture sent to the models")).toBeInTheDocument();

    const img = screen.getByRole("img", { name: /Apple Inc\. balance sheet/i });
    expect(img).toHaveAttribute("src", "/api/company/320193/picture");
    expect(
      screen.queryByText(/The SEC did not answer\./),
    ).not.toBeInTheDocument();
  });

  test("shows the saved-copy banner from design/desktop-saved.png when source is saved", () => {
    render(
      <StatementView
        statement={SAMPLE_STATEMENT}
        source="saved"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    expect(screen.getByText("The SEC did not answer.")).toBeInTheDocument();
    expect(
      screen.getByText(
        /This is a copy of the filing that we saved earlier\./,
      ),
    ).toBeInTheDocument();
  });
});
