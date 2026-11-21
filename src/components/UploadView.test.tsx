// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import appleFixture from "@/fixtures/apple-statement.json";
import { UploadView } from "./UploadView";
import {
  formatStatementRowsAsReplyForTest,
  type ReadingProgressEvent,
} from "@/lib/reading-test-helpers";
import type { ReadRow } from "@/lib/reading";
import type { Statement } from "@/lib/statements";
import { PDF_REFUSAL_MESSAGE } from "@/lib/upload-validation";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const APPLE_STATEMENT = appleFixture as unknown as Statement;
const APPLE_READ_ROWS = formatStatementRowsAsReplyForTest(APPLE_STATEMENT.rows);

function makeNdjsonResponse(events: ReadingProgressEvent[]): Response {
  const payload = events.map((e) => `${JSON.stringify(e)}\n`).join("");
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("UploadView", () => {
  beforeEach(() => {
    pushMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("shows the loading screen while an uploaded picture is being read", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise(() => {}),
    );

    render(
      <UploadView
        uploadId="test-id-1"
        fileName="statement-apple.png"
        pictureUrl="/api/upload/test-id-1/picture"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Your statement" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("statement-apple.png · uploaded just now"),
    ).toBeInTheDocument();
    expect(screen.getByText("Reading your statement")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Working" })).toBeInTheDocument();
    expect(screen.getByText("Got your picture.")).toBeInTheDocument();
    expect(
      screen.getByText("Hydrogen is reading the picture."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(
      screen.queryByText(/Compare with SEC data/i),
    ).not.toBeInTheDocument();
  });

  test("shows the upload result screen without Matches SEC data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        { type: "started", totalNumbers: 0, totalStrips: 1 },
        {
          type: "done",
          result: {
            rows: APPLE_READ_ROWS,
            comparison: {
              totalStatementNumbers: 0,
              readCount: 26,
              matchCount: 0,
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

    const { container } = render(
      <UploadView
        uploadId="test-id-2"
        fileName="statement-apple.png"
        pictureUrl="/api/upload/test-id-2/picture"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("26 of 26 numbers proven")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("heading", { name: "Your statement" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("statement-apple.png · uploaded just now"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upload another" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Matches SEC data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bSEC\b/)).not.toBeInTheDocument();

    expect(
      container.querySelectorAll('[data-proof-mark="proven"]').length,
    ).toBe(13);
  });

  test("D7 UI: left 7, 5, 20, 32 and right no value, 5, 20, 25 -> Hide it and Change it on the 20 are both refused with the group reason and make no model call", async () => {
    const cell = (raw: string, number: number | null) => ({
      raw,
      number,
      hidden: false,
    });
    const rows: ReadRow[] = [
      { label: "Cash", cells: [cell("7", 7), cell("", null)] },
      { label: "Receivables", cells: [cell("5", 5), cell("5", 5)] },
      { label: "Inventories", cells: [cell("20", 20), cell("20", 20)] },
      {
        label: "Total current assets",
        cells: [cell("32", 32), cell("25", 25)],
      },
    ];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        { type: "started", totalNumbers: 0, totalStrips: 1 },
        {
          type: "done",
          result: {
            rows,
            comparison: {
              totalStatementNumbers: 0,
              readCount: 7,
              matchCount: 0,
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

    const { container } = render(
      <UploadView
        uploadId="test-id-d7"
        fileName="statement-d7.png"
        pictureUrl="/api/upload/test-id-d7/picture"
      />,
    );

    await waitFor(() => {
      expect(
        container.querySelector('[data-cell-button="2-0"]'),
      ).not.toBeNull();
    });

    const reason =
      "This number's group does not exist in both columns, so the page cannot rebuild it.";

    fireEvent.click(
      container.querySelector('[data-cell-button="2-0"]') as HTMLButtonElement,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide it" }));
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    expect(screen.queryByText(/^Rebuilt:/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change it" }));
    expect(screen.getByRole("alert")).toHaveTextContent(reason);
    expect(
      screen.queryByRole("button", { name: "Apply change" }),
    ).not.toBeInTheDocument();

    // Only the first reading ran. No /modify call was made.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("shows the desktop-badupload.png screen when reading returns fewer than three number rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        { type: "started", totalNumbers: 0, totalStrips: 1 },
        { type: "bad_upload", fileName: "holiday-photo.png", rowCount: 0 },
      ]),
    );

    render(
      <UploadView
        uploadId="test-id-3"
        fileName="holiday-photo.png"
        pictureUrl="/api/upload/test-id-3/picture"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: "We could not find a statement in this file",
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("holiday-photo.png · uploaded just now"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Use one picture, PNG or JPEG, that shows a single balance sheet.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Drop a picture of one page here"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose a file" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Pick a company" }),
    ).toHaveAttribute("href", "/");
  });

  test("shows a plain error and Try again button when reading fails twice", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        { type: "started", totalNumbers: 0, totalStrips: 1 },
        {
          type: "error",
          code: "failed",
          message: "Could not read this uploaded picture right now.",
        },
      ]),
    );

    render(
      <UploadView
        uploadId="test-id-4"
        fileName="statement-apple.png"
        pictureUrl="/api/upload/test-id-4/picture"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("Could not read this statement"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("Could not read this uploaded picture right now."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Uploaded balance sheet picture/i }),
    ).toBeInTheDocument();
  });

  test("refuses a PDF selected from Upload another without calling the server", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeNdjsonResponse([
        { type: "started", totalNumbers: 0, totalStrips: 1 },
        { type: "bad_upload", fileName: "holiday-photo.png", rowCount: 0 },
      ]),
    );

    const { container } = render(
      <UploadView
        uploadId="test-id-5"
        fileName="holiday-photo.png"
        pictureUrl="/api/upload/test-id-5/picture"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: "We could not find a statement in this file",
        }),
      ).toBeInTheDocument();
    });

    const input = container.querySelector(
      'input[data-upload-input="true"]',
    ) as HTMLInputElement;
    const pdfFile = new File(["%PDF-1.7"], "annual-report.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByText(PDF_REFUSAL_MESSAGE)).toBeInTheDocument();
    });
    // Only the initial /read call happened; no /api/upload call was sent for the PDF.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
