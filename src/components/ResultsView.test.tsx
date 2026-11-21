// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ResultsView } from "./ResultsView";
import { loadScores } from "@/lib/scores";

describe("ResultsView component", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders the empty state matching design/desktop-resultsempty.png", async () => {
    const state = await loadScores({ fixtureQuery: "empty", isTestMode: true });
    render(<ResultsView state={state} />);

    expect(
      screen.getByRole("heading", { name: "No test has run yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The test reads 50 filings that a script picks. Results appear here when it ends.",
      ),
    ).toBeInTheDocument();
  });

  test("renders the full results state with headline, comparison table, pass marks, approved labels, 4 re-check rows, and 2 failures", async () => {
    const state = await loadScores({ fixtureQuery: "full", isTestMode: true });
    render(<ResultsView state={state} />);

    expect(
      screen.getByRole("heading", {
        name: "Does it work on pages we did not pick?",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("9% to 18%")).toBeInTheDocument();
    expect(screen.getByTestId("headline-wrong-shown")).toHaveTextContent(
      "0.03%",
    );

    // Owner-approved change #1: second reader labels and accurate heading
    expect(
      screen.getByRole("heading", { name: "What the second reader decides" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "When it ticks, asks or stops" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("The second reader agrees")).toBeInTheDocument();
    expect(screen.getByText("at or above 95%")).toBeInTheDocument();
    expect(screen.getByText("The second reader is unsure")).toBeInTheDocument();
    expect(screen.getByText("in between")).toBeInTheDocument();
    expect(screen.getByText("The second reader disagrees")).toBeInTheDocument();
    expect(screen.getByText("below 20%")).toBeInTheDocument();

    // Owner-approved change #2: all four re-check rows
    expect(screen.getByText("90% or more")).toBeInTheDocument();
    expect(screen.getByText("70% to 90%")).toBeInTheDocument();
    expect(screen.getByText("30% to 70%")).toBeInTheDocument();
    expect(screen.getByText("Under 30%")).toBeInTheDocument();

    // Pass marks shown plainly as Met or Missed
    expect(screen.getAllByText("Met")).toHaveLength(3);
    expect(screen.getAllByText("Missed")).toHaveLength(1);

    // Owner-approved change #3: both failures shown with company, number, shown, and truth
    const failuresList = screen.getByRole("list", {
      name: "Recorded failures",
    });
    expect(failuresList).toHaveTextContent("Meridian Industrial Corp.");
    expect(failuresList).toHaveTextContent("Accrued liabilities (left column)");
    expect(failuresList).toHaveTextContent("4,820");
    expect(failuresList).toHaveTextContent("4,280");
    expect(failuresList).toHaveTextContent("Harborview Bancorp");
    expect(failuresList).toHaveTextContent("Total deposits (left column)");
    expect(failuresList).toHaveTextContent("Not rebuilt");
    expect(failuresList).toHaveTextContent("18,940");

    // Outside-totals line and limits from eval-spec
    expect(
      screen.getByText(/Numbers outside every total cannot be proven\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Scans, photos and original layouts are harder\./),
    ).toBeInTheDocument();
  });

  test("renders the running state with progress banner, 0 of N headline, and 'not run' for unrun steps", async () => {
    const state = await loadScores({
      fixtureQuery: "running",
      isTestMode: true,
    });
    render(<ResultsView state={state} />);

    expect(screen.getByText("The test is running.")).toBeInTheDocument();
    expect(
      screen.getByText(
        /32 of 50 filings scored so far\. The numbers below change until it ends\./,
      ),
    ).toBeInTheDocument();
    const progress = screen.getByRole("progressbar", {
      name: "Filings scored",
    });
    expect(progress).toHaveAttribute("aria-valuenow", "32");
    expect(progress).toHaveAttribute("aria-valuemax", "50");

    // Zero wrong numbers shown as right renders as "0 of N"
    expect(screen.getByTestId("headline-wrong-shown")).toHaveTextContent(
      "0 of 2,048",
    );

    // Unrun steps show "not run"
    expect(screen.getAllByText("not run").length).toBeGreaterThanOrEqual(4);
    expect(
      screen.getByText(
        /The test did not run on blurred or tilted copies, scans or photos\./,
      ),
    ).toBeInTheDocument();
  });

  test("shows truthful limits, proof line, and 'from memory' for sub-second readings on real scores", async () => {
    const state = await loadScores({ isTestMode: false });
    expect(state.kind).toBe("ready");
    render(<ResultsView state={state} />);

    expect(
      screen.getByText(
        "One plain model call also read every number right. The difference is proof: Adds Up shows the sum behind every tick.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "What the second reader decides" }),
    ).toBeInTheDocument();
    // The blurred-copies step has run on the real scores since the harder-pictures test,
    // so the page no longer says it did not run. The running fixture above still covers that sentence.
    expect(
      screen.queryByText(
        /The test did not run on blurred or tilted copies, scans or photos\./,
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/only a first look/i)).toBeInTheDocument();
    expect(screen.getAllByText("from memory").length).toBeGreaterThanOrEqual(1);
  });

  test("renders an error alert when the score file cannot be parsed", () => {
    render(
      <ResultsView
        state={{
          kind: "error",
          message:
            "The test results file could not be read because its JSON is not valid.",
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The test results file could not be read because its JSON is not valid.",
    );
  });
});
