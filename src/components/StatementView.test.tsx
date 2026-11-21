// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StatementView } from "./StatementView";
import appleFixture from "@/fixtures/apple-statement.json";
import type {
  ReadingComparison,
  ReadingProgressEvent,
  ReadRow,
  RowComparison,
} from "@/lib/reading";
import type { Statement } from "@/lib/statements";

const APPLE_STATEMENT = appleFixture as unknown as Statement;

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

function makeNdjsonResponse(events: ReadingProgressEvent[]): Response {
  const payload = events.map((e) => `${JSON.stringify(e)}\n`).join("");
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

function buildComparisonFromReadValues(
  statement: Statement,
  readPairs: Array<[number | null, number | null]>,
  overrides?: {
    rawPairs?: Array<[string, string]>;
  },
): { rows: ReadRow[]; comparison: ReadingComparison } {
  const readRows: ReadRow[] = [];
  const compRows: RowComparison[] = [];
  let totalStatementNumbers = 0;
  let readCount = 0;
  let matchCount = 0;
  let unreadCount = 0;
  let numberIdx = 0;

  for (let i = 0; i < statement.rows.length; i += 1) {
    const stmtRow = statement.rows[i];
    if (stmtRow.kind !== "number") continue;

    const pair = readPairs[numberIdx] ?? stmtRow.numbers;
    const rawPair = overrides?.rawPairs?.[numberIdx];
    const leftRaw =
      rawPair?.[0] ??
      (pair[0] !== null ? pair[0].toLocaleString("en-US") : "");
    const rightRaw =
      rawPair?.[1] ??
      (pair[1] !== null ? pair[1].toLocaleString("en-US") : "");

    const readRow: ReadRow = {
      label: stmtRow.label,
      cells: [
        { raw: leftRaw, number: pair[0], hidden: false },
        { raw: rightRaw, number: pair[1], hidden: false },
      ],
    };
    readRows.push(readRow);

    const cells = ([0, 1] as const).map((col) => {
      const expected = stmtRow.numbers[col];
      const read = pair[col];
      if (expected !== null) totalStatementNumbers += 1;
      if (read !== null) readCount += 1;
      else if (expected !== null) unreadCount += 1;
      const matches = expected !== null && read !== null && expected === read;
      if (matches) matchCount += 1;
      return {
        expected,
        read,
        hidden: false,
        unread: expected !== null && read === null,
        matches,
      };
    }) as RowComparison["cells"];

    compRows.push({
      statementRowIndex: i,
      label: stmtRow.label,
      readRow,
      unread: false,
      cells,
    });
    numberIdx += 1;
  }

  return {
    rows: readRows,
    comparison: {
      totalStatementNumbers,
      readCount,
      matchCount,
      unreadCount,
      rows: compRows,
    },
  };
}

describe("StatementView", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("shows company name, form, filing date and balance sheet picture without saved banner on live source", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}),
    );

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
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}),
    );

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

  test("shows the loading screen from design/desktop-loading.png while reading runs", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}),
    );

    render(
      <StatementView
        statement={SAMPLE_STATEMENT}
        source="fixture"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    expect(screen.getByText("Reading: 0 of 2 numbers")).toBeInTheDocument();
    expect(
      screen.getByText("The ticks land as each strip of the page is read."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Working" })).toBeInTheDocument();
    expect(screen.getByText("Found the filing.")).toBeInTheDocument();
    expect(screen.getByText("Took the picture.")).toBeInTheDocument();
    expect(screen.getByText("Re-add every total.")).toBeInTheDocument();
    expect(screen.getByText("Compare with SEC data.")).toBeInTheDocument();
  });

  test("shows the proven result screen with verdict band, ticks, brackets, Matches SEC data, and heading rows without marks", async () => {
    const numberPairs = APPLE_STATEMENT.rows
      .filter((r) => r.kind === "number")
      .map((r) => r.numbers);
    const { rows, comparison } = buildComparisonFromReadValues(
      APPLE_STATEMENT,
      numberPairs,
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        { type: "started", totalNumbers: 26, totalStrips: 2 },
        {
          type: "done",
          result: {
            rows,
            comparison,
            fromCache: false,
            usedRepeat: false,
            modelCalls: 2,
          },
        },
      ]),
    );

    const { container } = render(
      <StatementView
        statement={APPLE_STATEMENT}
        source="fixture"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("26 of 26 numbers proven")).toBeInTheDocument();
    });

    // Verdict band counts and SEC comparison
    const verdict = container.querySelector('[data-verdict-band="true"]');
    expect(verdict).not.toBeNull();
    expect(verdict).toHaveTextContent("26 proven");
    expect(verdict).toHaveTextContent("0 need your eye");
    expect(verdict).toHaveTextContent("0 not proven");
    expect(verdict).toHaveTextContent("Matches SEC data: 26 of 26");

    // Unit 3 plain count line is replaced by the result screen
    expect(
      screen.queryByText("26 numbers read. 26 match the SEC's values."),
    ).not.toBeInTheDocument();

    // Ticks on proven rows and brackets joining groups to totals
    const provenMarks = container.querySelectorAll('[data-proof-mark="proven"]');
    expect(provenMarks.length).toBe(13);

    const provenBrackets = container.querySelectorAll(
      '[data-proof-bracket="proven"]',
    );
    expect(provenBrackets.length).toBeGreaterThan(0);

    // Proof notes for totals
    expect(screen.getAllByText(/6 lines add to/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/4 lines add to/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2 totals add to/i).length).toBeGreaterThan(0);

    // Heading rows have no number and get no mark
    const headingRows = container.querySelectorAll('tr[data-row-kind="heading"]');
    expect(headingRows.length).toBe(3);
    for (const headingRow of headingRows) {
      expect(headingRow.querySelector("[data-proof-mark]")).toBeNull();
      expect(headingRow.querySelector("[data-proof-status]")).toBeNull();
    }

    // Picture sent to the models stays on the page
    expect(screen.getByText("Picture sent to the models")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Apple Inc\. balance sheet/i }),
    ).toBeInTheDocument();
  });

  test("marks numbers outside every total as not proven and hides Matches SEC data when statement has no SEC data", async () => {
    const noGroupStatement: Statement = {
      cik: "999999",
      companyName: "Example Corp.",
      form: "10-K",
      filingDate: "2026-11-03",
      title: "BALANCE SHEET",
      columns: ["2026", "2025"],
      unitLine: "In millions",
      rows: [
        { kind: "heading", label: "Items", indent: 0 },
        {
          kind: "number",
          label: "Item A",
          indent: 1,
          isTotal: false,
          values: ["10", "10"],
          numbers: [10, 10],
        },
        {
          kind: "number",
          label: "Item B",
          indent: 1,
          isTotal: false,
          values: ["20", "20"],
          numbers: [20, 20],
        },
        {
          kind: "number",
          label: "Item C",
          indent: 1,
          isTotal: false,
          values: ["31", "31"],
          numbers: [31, 31],
        },
        {
          kind: "number",
          label: "Item D",
          indent: 1,
          isTotal: false,
          values: ["5", "5"],
          numbers: [5, 5],
        },
      ],
    };

    const { rows, comparison } = buildComparisonFromReadValues(
      noGroupStatement,
      [
        [10, 10],
        [20, 20],
        [31, 31],
        [5, 5],
      ],
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        {
          type: "done",
          result: {
            rows,
            comparison,
            fromCache: false,
            usedRepeat: false,
            modelCalls: 1,
          },
        },
      ]),
    );

    const { container } = render(
      <StatementView
        statement={noGroupStatement}
        source="fixture"
        pictureUrl="/api/company/999999/picture"
        hasSecData={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("0 of 8 numbers proven")).toBeInTheDocument();
    });

    const verdict = container.querySelector('[data-verdict-band="true"]');
    expect(verdict).toHaveTextContent("0 proven");
    expect(verdict).toHaveTextContent("0 need your eye");
    expect(verdict).toHaveTextContent("8 not proven");
    expect(screen.queryByText(/Matches SEC data/i)).not.toBeInTheDocument();

    const notProvenMarks = container.querySelectorAll(
      '[data-proof-mark="not-proven"]',
    );
    expect(notProvenMarks.length).toBe(4);
    expect(screen.getAllByText("not proven").length).toBeGreaterThan(0);
  });

  test("C14 UI: when a group re-adds in one column only, marks the other column as not adding up with its gap", async () => {
    const c14Statement: Statement = {
      cik: "320193",
      companyName: "Apple Inc.",
      form: "10-K",
      filingDate: "2026-11-03",
      title: "CONSOLIDATED BALANCE SHEETS",
      columns: ["Sep. 26, 2026", "Sep. 27, 2025"],
      unitLine: "In millions",
      rows: [
        { kind: "heading", label: "Current assets:", indent: 0 },
        ...APPLE_STATEMENT.rows.slice(2, 9),
      ],
    };

    // Left is C11 (adds up to 173,857); right has row 2 misread as 18,768 (adds to 147,962 vs 147,957, gap 5).
    const { rows, comparison } = buildComparisonFromReadValues(c14Statement, [
      [36305, 35934],
      [20417, 18768],
      [43817, 39777],
      [39896, 33180],
      [14541, 5718],
      [18881, 14585],
      [173857, 147957],
    ]);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        {
          type: "done",
          result: {
            rows,
            comparison,
            fromCache: false,
            usedRepeat: false,
            modelCalls: 1,
          },
        },
      ]),
    );

    const { container } = render(
      <StatementView
        statement={c14Statement}
        source="fixture"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("One group does not add up")).toBeInTheDocument();
    });

    const verdict = container.querySelector('[data-verdict-band="true"]');
    expect(verdict).toHaveTextContent("7 proven");
    expect(verdict).toHaveTextContent("7 need your eye");
    expect(verdict).toHaveTextContent("0 not proven");
    expect(verdict).toHaveTextContent("Gap: 5");
    expect(verdict).toHaveTextContent("Matches SEC data: 13 of 14");

    // Mismatch bracket, warning mark on total, sum and gap shown
    expect(
      container.querySelectorAll('[data-proof-bracket="mismatch"]').length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('[data-proof-mark="mismatch-total"]').length,
    ).toBe(1);
    expect(screen.getByText("off by 5 in this group")).toBeInTheDocument();
    expect(screen.getAllByText(/lines add to/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/147,962/).length).toBeGreaterThan(0);

    // Left column cells are proven; right column cells are mismatch
    const table = screen.getByRole("table");
    const provenCells = within(table)
      .getAllByRole("cell")
      .filter((cell) => cell.getAttribute("data-proof-status") === "proven");
    const mismatchCells = within(table)
      .getAllByRole("cell")
      .filter((cell) => cell.getAttribute("data-proof-status") === "mismatch");
    expect(provenCells.length).toBe(7);
    expect(mismatchCells.length).toBe(7);
  });

  test("counts unread numbers under need your eye", async () => {
    const { rows, comparison } = buildComparisonFromReadValues(
      SAMPLE_STATEMENT,
      [[null, 35934]],
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        {
          type: "done",
          result: {
            rows,
            comparison,
            fromCache: false,
            usedRepeat: false,
            modelCalls: 1,
          },
        },
      ]),
    );

    const { container } = render(
      <StatementView
        statement={SAMPLE_STATEMENT}
        source="fixture"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("1 number needs your eye")).toBeInTheDocument();
    });

    const verdict = container.querySelector('[data-verdict-band="true"]');
    expect(verdict).toHaveTextContent("0 proven");
    expect(verdict).toHaveTextContent("1 need your eye");
    expect(verdict).toHaveTextContent("1 not proven");
  });

  test("E8: shows the slow screen when the repeat starts", async () => {
    const encoder = new TextEncoder();
    const controls: { emitDone?: () => void } = {};
    const { rows, comparison } = buildComparisonFromReadValues(
      SAMPLE_STATEMENT,
      [[36305, 35934]],
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "slow", strip: 2, totalStrips: 2, timeoutMs: 12000 })}\n`,
          ),
        );
        controls.emitDone = () => {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: "done",
                result: {
                  rows,
                  comparison,
                  fromCache: false,
                  usedRepeat: true,
                  modelCalls: 2,
                },
              })}\n`,
            ),
          );
          controller.close();
        };
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );

    render(
      <StatementView
        statement={SAMPLE_STATEMENT}
        source="fixture"
        pictureUrl="/api/company/320193/picture"
        slowMode
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Reading took too long")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/A model did not answer within 12 seconds/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing was guessed\./)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "What happened" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Strip 2 of 2 timed out.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Read it again" }),
    ).toBeInTheDocument();

    controls.emitDone?.();

    await waitFor(() => {
      expect(screen.getByText("0 of 2 numbers proven")).toBeInTheDocument();
    });
  });

  test("E9: shows an error with a Try again button and no ticks when the repeat also times out", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        { type: "slow", strip: 2, totalStrips: 2, timeoutMs: 12000 },
        {
          type: "error",
          code: "timeout",
          message:
            "A model did not answer within 12 seconds. Nothing was guessed.",
          strip: 2,
          totalStrips: 2,
        },
      ]),
    );

    const { container } = render(
      <StatementView
        statement={SAMPLE_STATEMENT}
        source="fixture"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Stopped: reading took too long"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "A model did not answer within 12 seconds. Nothing was guessed.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-proof-mark="proven"]')).toBeNull();
  });

  test("shows a plain error in place of the reading when GEMINI_API_KEY is missing, while keeping the picture visible", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "missing_key",
          error:
            "Reading is unavailable because GEMINI_API_KEY is not set on the server.",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(
      <StatementView
        statement={SAMPLE_STATEMENT}
        source="sec"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Reading is unavailable because GEMINI_API_KEY is not set on the server.",
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("img", { name: /Apple Inc\. balance sheet/i }),
    ).toBeInTheDocument();
  });
});
