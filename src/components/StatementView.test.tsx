// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { StatementView } from "./StatementView";
import type { ReadingProgressEvent } from "@/lib/reading";
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

function makeNdjsonResponse(events: ReadingProgressEvent[]): Response {
  const payload = events.map((e) => `${JSON.stringify(e)}\n`).join("");
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
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

  test("shows the plain count line under the picture when reading finishes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        { type: "started", totalNumbers: 2, totalStrips: 1 },
        {
          type: "done",
          result: {
            rows: [
              {
                label: "Cash and cash equivalents",
                cells: [
                  { raw: "$ 36,305", number: 36305, hidden: false },
                  { raw: "$ 35,934", number: 35934, hidden: false },
                ],
              },
            ],
            comparison: {
              totalStatementNumbers: 2,
              readCount: 2,
              matchCount: 2,
              unreadCount: 0,
              rows: [],
            },
            fromCache: false,
            usedRepeat: false,
            modelCalls: 1,
          },
        },
      ]),
    );

    render(
      <StatementView
        statement={SAMPLE_STATEMENT}
        source="fixture"
        pictureUrl="/api/company/320193/picture"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("2 numbers read. 2 match the SEC's values."),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("img", { name: /Apple Inc\. balance sheet/i }),
    ).toBeInTheDocument();
  });

  test("E8: shows the slow screen when the repeat starts", async () => {
    const encoder = new TextEncoder();
    const controls: { emitDone?: () => void } = {};

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
                  rows: [],
                  comparison: {
                    totalStatementNumbers: 2,
                    readCount: 2,
                    matchCount: 2,
                    unreadCount: 0,
                    rows: [],
                  },
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
      expect(
        screen.getByText("2 numbers read. 2 match the SEC's values."),
      ).toBeInTheDocument();
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

    render(
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
    expect(screen.queryByText(/numbers read\./)).not.toBeInTheDocument();
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
