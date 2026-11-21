// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CompanySearch } from "./CompanySearch";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe("CompanySearch component", () => {
  beforeEach(() => {
    pushMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("A7: typing nothing runs no search and shows no message", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<CompanySearch />);

    const input = screen.getByRole("combobox", {
      name: "Type a US public company",
    });
    fireEvent.change(input, { target: { value: "   " } });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("A6: typing 'zzzz' shows the not-listed message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ companies: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<CompanySearch />);

    const input = screen.getByRole("combobox", {
      name: "Type a US public company",
    });
    fireEvent.change(input, { target: { value: "zzzz" } });

    await waitFor(() => {
      expect(
        screen.getByText("zzzz is not in the SEC's list."),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Private and foreign companies do not file there. Pick a listed company, or upload a statement.",
      ),
    ).toBeInTheDocument();
  });

  test("Check it with an empty box shows a hint instead of doing nothing (QA)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<CompanySearch />);
    fireEvent.click(screen.getByRole("button", { name: "Check it" }));
    expect(
      screen.getByText("Type a company name or stock symbol first, such as Apple or AAPL."),
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a very long unknown name is shortened in the not-listed message (QA)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ companies: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<CompanySearch />);
    const input = screen.getByRole("combobox", {
      name: "Type a US public company",
    });
    fireEvent.change(input, { target: { value: "a".repeat(5000) } });
    await waitFor(() => {
      expect(
        screen.getByText(`${"a".repeat(60)}… is not in the SEC's list.`),
      ).toBeInTheDocument();
    });
  });

  test("arrow keys move through rows and Enter picks the marked row", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          companies: [
            { cik: "320193", ticker: "AAPL", name: "Apple Inc." },
            {
              cik: "1418121",
              ticker: "APLE",
              name: "Apple Hospitality REIT, Inc.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<CompanySearch />);

    const input = screen.getByRole("combobox", {
      name: "Type a US public company",
    });
    fireEvent.change(input, { target: { value: "apple" } });

    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/company/1418121");
  });

  test("shows a plain error message when search returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error:
            "Company search is unavailable because SEC_USER_AGENT is not set on the server.",
          companies: [],
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );

    render(<CompanySearch />);

    const input = screen.getByRole("combobox", {
      name: "Type a US public company",
    });
    fireEvent.change(input, { target: { value: "apple" } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Company search is unavailable because SEC_USER_AGENT is not set on the server.",
      );
    });
  });

  test("shows loading indicator while search is in flight", async () => {
    const deferred: { resolve?: (value: Response) => void } = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          deferred.resolve = resolve;
        }),
    );

    render(<CompanySearch />);

    const input = screen.getByRole("combobox", {
      name: "Type a US public company",
    });
    fireEvent.change(input, { target: { value: "apple" } });

    await waitFor(() => {
      expect(screen.getByText("Searching companies...")).toBeInTheDocument();
    });

    deferred.resolve?.(
      new Response(
        JSON.stringify({
          companies: [{ cik: "320193", ticker: "AAPL", name: "Apple Inc." }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await waitFor(() => {
      expect(screen.getByRole("option")).toHaveTextContent("Apple Inc.");
    });
  });

  test("renders the Upload a statement button after 'or' and refuses a PDF with no server call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { container } = render(<CompanySearch />);

    expect(screen.getByText("or")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upload a statement" }),
    ).toBeInTheDocument();

    const input = container.querySelector(
      'input[data-upload-input="true"]',
    ) as HTMLInputElement;
    const pdfFile = new File(["%PDF-1.7"], "statement.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Upload one page as a picture. A PDF is not read yet.",
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("shows Try again when company search fails and retries on click", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error:
              "Could not reach the SEC company list right now. Please try again.",
            companies: [],
          }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            companies: [{ cik: "320193", ticker: "AAPL", name: "Apple Inc." }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<CompanySearch />);

    const input = screen.getByRole("combobox", {
      name: "Type a US public company",
    });
    fireEvent.change(input, { target: { value: "apple" } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Try again" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByRole("option")).toHaveTextContent("Apple Inc.");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
