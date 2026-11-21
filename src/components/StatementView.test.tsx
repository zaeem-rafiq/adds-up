// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StatementView } from "./StatementView";
import appleFixture from "@/fixtures/apple-statement.json";
import northstarFixture from "@/fixtures/northstar-statement.json";
import type {
  ReadingComparison,
  ReadingProgressEvent,
  ReadRow,
  RowComparison,
} from "@/lib/reading";
import type { Statement } from "@/lib/statements";

const APPLE_STATEMENT = appleFixture as unknown as Statement;
const NORTHSTAR_STATEMENT = northstarFixture as unknown as Statement;

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
    expect(
      screen.getByText("Hydrogen is reading strip 1 of 1."),
    ).toBeInTheDocument();
    expect(screen.getByText("Re-add every total.")).toBeInTheDocument();
    expect(screen.getByText("Compare with SEC data.")).toBeInTheDocument();
  });

  test("loading screen and progress line count returning pictures using the real number of strips", async () => {
    const thirtyRowStatement: Statement = {
      cik: "320193",
      companyName: "Big Bank Corp.",
      form: "10-K",
      filingDate: "2026-11-03",
      title: "CONSOLIDATED STATEMENTS OF CONDITION",
      columns: ["Dec. 31, 2026", "Dec. 31, 2025"],
      unitLine: "USD ($) $ in Millions",
      rows: Array.from({ length: 30 }, (_, idx) => ({
        kind: "number" as const,
        label: `Line ${idx + 1}`,
        indent: 1,
        isTotal: false,
        values: [String((idx + 1) * 10), String((idx + 1) * 10)],
        numbers: [(idx + 1) * 10, (idx + 1) * 10] as [number, number],
      })),
    };

    const encoder = new TextEncoder();
    const controls: {
      emit?: (event: ReadingProgressEvent) => void;
      close?: () => void;
    } = {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controls.emit = (event) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        controls.close = () => controller.close();
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
        statement={thirtyRowStatement}
        source="sec"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    // Before the server even streams started, the real strip count (3) is shown, not 2.
    expect(screen.getByText("Reading: 0 of 60 numbers")).toBeInTheDocument();
    expect(
      screen.getByText("Hydrogen is reading strip 1 of 3."),
    ).toBeInTheDocument();

    controls.emit?.({ type: "started", totalNumbers: 60, totalStrips: 3 });
    controls.emit?.({
      type: "strip_done",
      strip: 3,
      completedStrips: 1,
      totalStrips: 3,
      numbersRead: 12,
      totalNumbers: 60,
    });

    await waitFor(() => {
      expect(screen.getByText("Reading: 12 of 60 numbers")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Hydrogen is reading strip 2 of 3."),
    ).toBeInTheDocument();

    controls.emit?.({
      type: "strip_done",
      strip: 1,
      completedStrips: 2,
      totalStrips: 3,
      numbersRead: 36,
      totalNumbers: 60,
    });

    await waitFor(() => {
      expect(screen.getByText("Reading: 36 of 60 numbers")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Hydrogen is reading strip 3 of 3."),
    ).toBeInTheDocument();

    controls.emit?.({
      type: "slow",
      strip: 2,
      totalStrips: 3,
      timeoutMs: 12000,
    });

    await waitFor(() => {
      expect(screen.getByText("Strip 2 of 3 timed out.")).toBeInTheDocument();
    });

    controls.close?.();
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

  test("auto-selects first proven left-column number, shows Hide it and Change it, and adds the verdict band prompt line", async () => {
    const numberPairs = APPLE_STATEMENT.rows
      .filter((r) => r.kind === "number")
      .map((r) => r.numbers);
    const { rows, comparison } = buildComparisonFromReadValues(
      APPLE_STATEMENT,
      numberPairs,
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
            modelCalls: 2,
          },
        },
      ]),
    );

    const { container } = render(
      <StatementView
        statement={APPLE_STATEMENT}
        source="saved"
        pictureUrl="/api/company/320193/picture"
        hasSecData={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("26 of 26 numbers proven")).toBeInTheDocument();
    });

    // Approved change #1: verdict band line below counts (including saved-copy & upload forms).
    const verdict = container.querySelector('[data-verdict-band="true"]');
    expect(verdict).toHaveTextContent(
      "Hide any number on this balance sheet. Adds Up works out what it was.",
    );

    // Approved change #2: first proven left-column number selected automatically with side panel buttons.
    const selectedPanel = container.querySelector('[data-selected-panel="true"]');
    expect(selectedPanel).not.toBeNull();
    expect(selectedPanel).toHaveTextContent("Cash and cash equivalents");
    expect(
      within(selectedPanel as HTMLElement).getByRole("button", {
        name: "Hide it",
      }),
    ).toBeInTheDocument();
    expect(
      within(selectedPanel as HTMLElement).getByRole("button", {
        name: "Change it",
      }),
    ).toBeInTheDocument();
  });

  test("hides Inventories, shows Rebuilt: 14,541 with math breakdown, updates What happened, and restores on Undo", async () => {
    const numberPairs = APPLE_STATEMENT.rows
      .filter((r) => r.kind === "number")
      .map((r) => r.numbers);
    const initial = buildComparisonFromReadValues(APPLE_STATEMENT, numberPairs);

    const hiddenPairs = numberPairs.map(
      (pair, idx) =>
        (idx === 4 ? [null, pair[1]] : pair) as [number | null, number | null],
    );
    const hiddenBuild = buildComparisonFromReadValues(
      APPLE_STATEMENT,
      hiddenPairs,
    );
    hiddenBuild.rows[4].cells[0].hidden = true;
    hiddenBuild.rows[4].cells[0].raw = "HIDDEN";
    hiddenBuild.comparison.rows[4].cells[0].hidden = true;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/modify")) {
        return makeNdjsonResponse([
          {
            type: "done",
            result: {
              rows: hiddenBuild.rows,
              comparison: hiddenBuild.comparison,
              fromCache: false,
              usedRepeat: false,
              modelCalls: 1,
            },
          },
        ]);
      }
      return makeNdjsonResponse([
        {
          type: "done",
          result: {
            rows: initial.rows,
            comparison: initial.comparison,
            fromCache: false,
            usedRepeat: false,
            modelCalls: 2,
          },
        },
      ]);
    });

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

    // Select Inventories (row index 4, left col 0) and click Hide it.
    const inventoriesCellBtn = container.querySelector(
      '[data-cell-button="4-0"]',
    ) as HTMLButtonElement;
    fireEvent.click(inventoriesCellBtn);

    fireEvent.click(screen.getByRole("button", { name: "Hide it" }));

    await waitFor(() => {
      expect(screen.getByText("Rebuilt: 14,541")).toBeInTheDocument();
    });

    const hiddenPanel = container.querySelector('[data-hidden-panel="true"]');
    expect(hiddenPanel).toHaveTextContent("The hidden number is");
    expect(hiddenPanel).toHaveTextContent("14,541");
    expect(hiddenPanel).toHaveTextContent("173,857");
    expect(hiddenPanel).toHaveTextContent("159,316");
    expect(hiddenPanel).toHaveTextContent(
      "The models saw a black box. Plain code did this sum.",
    );

    // What happened logs the hide and rebuild.
    expect(screen.getByText("You hid Inventories.")).toBeInTheDocument();
    expect(
      screen.getByText("Rebuilt 14,541 from the total."),
    ).toBeInTheDocument();

    // Undo / Reveal restores the unchanged statement.
    fireEvent.click(screen.getByRole("button", { name: "Reveal the number" }));
    await waitFor(() => {
      expect(screen.getByText("26 of 26 numbers proven")).toBeInTheDocument();
    });
  });

  test("D5 UI: refuses to hide a number outside every total and makes no modify request", async () => {
    const noGroupStatement: Statement = {
      cik: "999999",
      companyName: "Example Corp.",
      form: "10-K",
      filingDate: "2026-11-03",
      title: "BALANCE SHEET",
      columns: ["2026", "2025"],
      unitLine: "In millions",
      rows: [
        {
          kind: "number",
          label: "Standalone item",
          indent: 1,
          isTotal: false,
          values: ["10", "10"],
          numbers: [10, 10],
        },
        {
          kind: "number",
          label: "Other item",
          indent: 1,
          isTotal: false,
          values: ["25", "25"],
          numbers: [25, 25],
        },
      ],
    };

    const { rows, comparison } = buildComparisonFromReadValues(
      noGroupStatement,
      [
        [10, 10],
        [25, 25],
      ],
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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

    render(
      <StatementView
        statement={noGroupStatement}
        source="fixture"
        pictureUrl="/api/company/999999/picture"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("0 of 4 numbers proven")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Hide it" }));

    const refusal = screen.getByRole("alert");
    expect(refusal).toHaveTextContent(/outside every total/i);
    expect(refusal).toHaveTextContent(/cannot be hidden/i);
    // Only the initial /read call ran; no /modify call was made.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("refuses non-number change input without calling server, then shows gap immediately on valid change and appends cause sentence when it arrives", async () => {
    const numberPairs = APPLE_STATEMENT.rows
      .filter((r) => r.kind === "number")
      .map((r) => r.numbers);
    const initial = buildComparisonFromReadValues(APPLE_STATEMENT, numberPairs);

    const changedPairs = numberPairs.map(
      (pair, idx) =>
        (idx === 4 ? [15541, pair[1]] : pair) as [number | null, number | null],
    );
    const changedBuild = buildComparisonFromReadValues(
      APPLE_STATEMENT,
      changedPairs,
    );

    const causeControl: { resolve?: (sentence: string | null) => void } = {};
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/modify")) {
          return makeNdjsonResponse([
            {
              type: "done",
              result: {
                rows: changedBuild.rows,
                comparison: changedBuild.comparison,
                fromCache: false,
                usedRepeat: false,
                modelCalls: 1,
              },
            },
          ]);
        }
        if (url.includes("/cause")) {
          const sentence = await new Promise<string | null>((resolve) => {
            causeControl.resolve = resolve;
          });
          return new Response(
            JSON.stringify({ sentence, model: "gemini-4-carbon" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return makeNdjsonResponse([
          {
            type: "done",
            result: {
              rows: initial.rows,
              comparison: initial.comparison,
              fromCache: false,
              usedRepeat: false,
              modelCalls: 2,
            },
          },
        ]);
      });

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

    // Select Inventories (row 4, col 0) and open Change form.
    fireEvent.click(
      container.querySelector('[data-cell-button="4-0"]') as HTMLButtonElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change it" }));

    const input = screen.getByLabelText(/New value for Inventories/i);
    fireEvent.change(input, { target: { value: "not a number" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));

    expect(screen.getByText(/Enter a valid number/i)).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1); // No /modify call made!

    // Now enter valid changed value 15,541.
    fireEvent.change(input, { target: { value: "15,541" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));

    // Gap and headline appear IMMEDIATELY before /cause resolves!
    await waitFor(() => {
      expect(
        screen.getAllByText("Current assets are off by 1,000").length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(container.querySelector('[data-cause-sentence="true"]')).toBeNull();
    expect(screen.getByText("Gap: 1,000")).toBeInTheDocument();

    // Now resolve the async cause call and verify the sentence appears.
    causeControl.resolve?.(
      "The printed total still fits the rest of the statement, so one line in this group is off.",
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "The printed total still fits the rest of the statement, so one line in this group is off.",
        ),
      ).toBeInTheDocument();
    });
  });

  test("D6 UI: when a hidden number cannot be rebuilt, does not show Rebuilt headline and never guesses", async () => {
    const oneColGroupStmt: Statement = {
      cik: "320193",
      companyName: "Apple Inc.",
      form: "10-K",
      filingDate: "2026-11-03",
      title: "CONSOLIDATED BALANCE SHEETS",
      columns: ["Sep. 26, 2026", "Sep. 27, 2025"],
      unitLine: "In millions",
      rows: [
        {
          kind: "number",
          label: "Cash",
          indent: 1,
          isTotal: false,
          values: ["10", "10"],
          numbers: [10, 10],
        },
        {
          kind: "number",
          label: "Inventories",
          indent: 1,
          isTotal: false,
          values: ["20", "20"],
          numbers: [20, 20],
        },
        {
          kind: "number",
          label: "Total current assets",
          indent: 0,
          isTotal: true,
          values: ["30", "999"],
          numbers: [30, 999],
        },
      ],
    };

    const initial = buildComparisonFromReadValues(oneColGroupStmt, [
      [10, 10],
      [20, 20],
      [30, 999],
    ]);
    const hiddenBuild = buildComparisonFromReadValues(oneColGroupStmt, [
      [10, 10],
      [null, 20],
      [30, 999],
    ]);
    hiddenBuild.rows[1].cells[0].hidden = true;
    hiddenBuild.rows[1].cells[0].raw = "HIDDEN";
    hiddenBuild.comparison.rows[1].cells[0].hidden = true;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/modify")) {
        return makeNdjsonResponse([
          {
            type: "done",
            result: {
              rows: hiddenBuild.rows,
              comparison: hiddenBuild.comparison,
              fromCache: false,
              usedRepeat: false,
              modelCalls: 1,
            },
          },
        ]);
      }
      return makeNdjsonResponse([
        {
          type: "done",
          result: {
            rows: initial.rows,
            comparison: initial.comparison,
            fromCache: false,
            usedRepeat: false,
            modelCalls: 1,
          },
        },
      ]);
    });

    const { container } = render(
      <StatementView
        statement={oneColGroupStmt}
        source="fixture"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("One group does not add up")).toBeInTheDocument();
    });

    // Left col row 1 (Inventories, 20) is proven because left col adds up (10+20=30),
    // while right col has no group (10+20 != 999).
    fireEvent.click(
      container.querySelector('[data-cell-button="1-0"]') as HTMLButtonElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide it" }));

    await waitFor(() => {
      expect(
        screen.getByText("Could not rebuild the hidden number"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/^Rebuilt:/i)).not.toBeInTheDocument();
    expect(container.querySelector('[data-cannot-rebuild="true"]')).toHaveTextContent(
      /never guesses/i,
    );
  });

  test("shows ticks at once with not proven, then updates outside-total numbers when second reader answers with all three classes", async () => {
    const numberPairs = NORTHSTAR_STATEMENT.rows
      .filter((r) => r.kind === "number")
      .map((r) => r.numbers);
    const { rows, comparison } = buildComparisonFromReadValues(
      NORTHSTAR_STATEMENT,
      numberPairs,
    );

    const encoder = new TextEncoder();
    const controls: {
      emit?: (event: ReadingProgressEvent) => void;
      close?: () => void;
    } = {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controls.emit = (event) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        controls.close = () => controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );

    const { container } = render(
      <StatementView
        statement={NORTHSTAR_STATEMENT}
        source="fixture"
        pictureUrl="/api/company/990001/picture"
      />,
    );

    // Emit reading "done" first — second reader has NOT answered yet.
    controls.emit?.({
      type: "done",
      result: {
        rows,
        comparison,
        fromCache: false,
        usedRepeat: false,
        modelCalls: 1,
      },
    });

    // Result screen and ticks show IMMEDIATELY; both outside-total numbers start as "not proven".
    await waitFor(() => {
      expect(screen.getByText("12 of 14 numbers proven")).toBeInTheDocument();
    });
    const verdict = container.querySelector('[data-verdict-band="true"]');
    expect(verdict).toHaveTextContent("12 proven");
    expect(verdict).toHaveTextContent("0 need your eye");
    expect(verdict).toHaveTextContent("2 not proven");
    expect(
      container.querySelectorAll('[data-proof-mark="not-proven"]').length,
    ).toBe(2);

    // Now the second reader answers: row 6 unsure (0.60), row 7 disagrees (0.10).
    controls.emit?.({
      type: "recheck",
      recheck: {
        results: [
          {
            rowIndex: 6,
            colIndex: 0,
            probability: 0.6,
            verdict: "unsure",
            failed: false,
          },
          {
            rowIndex: 7,
            colIndex: 0,
            probability: 0.1,
            verdict: "disagrees",
            failed: false,
          },
        ],
        cutoffs: { upper: 0.9, lower: 0.3 },
        modelCalls: 1,
        fromCache: false,
        failedBatches: 0,
        rateLimited: false,
      },
    });
    controls.close?.();

    await waitFor(() => {
      expect(screen.getByText("2 numbers need your eye")).toBeInTheDocument();
    });
    // Ticks never change (still 12 proven); both move from not proven to need your eye.
    expect(verdict).toHaveTextContent("12 proven");
    expect(verdict).toHaveTextContent("2 need your eye");
    expect(verdict).toHaveTextContent("0 not proven");
    expect(container.querySelector('[data-proof-mark="needs-eye"]')).not.toBeNull();
    expect(
      container.querySelector('[data-proof-mark="needs-eye-red"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('td[data-second-reader="unsure"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('td[data-second-reader="disagrees"]'),
    ).not.toBeNull();
  });
});
