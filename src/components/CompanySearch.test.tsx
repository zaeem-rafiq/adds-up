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
});
