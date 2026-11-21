import { expect, test } from "@playwright/test";

test("shows the full test results with headline figure, comparison table, pass marks, and two failures at 375, 768 and 1440 pixels", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/results?scores=full");

  await expect(
    page.getByRole("link", { name: "Test results" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", {
      name: "Does it work on pages we did not pick?",
    }),
  ).toBeVisible();
  await expect(page.getByText("9% to 18%")).toBeVisible();
  await expect(page.getByTestId("headline-wrong-shown")).toHaveText("0.03%");

  // Comparison table against one plain model call
  const comparisonSection = page.getByRole("region", {
    name: "Against one plain model call",
  });
  await expect(comparisonSection).toBeVisible();
  await expect(
    comparisonSection.getByText("Numbers read correctly"),
  ).toBeVisible();
  await expect(
    comparisonSection.getByText("Wrong numbers shown as right"),
  ).toBeVisible();
  await expect(
    comparisonSection.getByText("Clean pages flagged by mistake"),
  ).toBeVisible();
  await expect(
    comparisonSection.getByText("Hidden numbers rebuilt"),
  ).toBeVisible();
  await expect(
    comparisonSection.getByText("Changed numbers caught"),
  ).toBeVisible();
  await expect(
    comparisonSection.getByText("Same test on blurred, tilted copies"),
  ).toBeVisible();
  await expect(comparisonSection.getByText("91.0%")).toBeVisible();
  await expect(comparisonSection.getByText("98.9%")).toBeVisible();
  await expect(comparisonSection.getByText("9.00%")).toBeVisible();
  await expect(comparisonSection.getByText("Does not apply")).toBeVisible();
  await expect(comparisonSection.getByText("49 of 50")).toBeVisible();
  await expect(comparisonSection.getByText("50 of 50")).toBeVisible();

  // Pass marks shown as met or missed
  const passMarksSection = page.getByRole("region", { name: "Pass marks" });
  await expect(passMarksSection.getByText("Met", { exact: true })).toHaveCount(3);
  await expect(
    passMarksSection.getByText("Missed", { exact: true }),
  ).toHaveCount(1);

  // Approved second-reader heading and labels
  await expect(
    page.getByRole("heading", { name: "What the second reader decides" }),
  ).toBeVisible();
  await expect(page.getByText("The second reader agrees")).toBeVisible();
  await expect(page.getByText("at or above 95%")).toBeVisible();
  await expect(page.getByText("The second reader is unsure")).toBeVisible();
  await expect(page.getByText("The second reader disagrees")).toBeVisible();
  await expect(page.getByText("below 20%")).toBeVisible();

  // All four re-check rows
  const recheckSection = page.getByRole("region", {
    name: "How sure is the re-check?",
  });
  await expect(recheckSection.getByText("90% or more")).toBeVisible();
  await expect(recheckSection.getByText("70% to 90%")).toBeVisible();
  await expect(recheckSection.getByText("30% to 70%")).toBeVisible();
  await expect(recheckSection.getByText("Under 30%")).toBeVisible();

  // Two failures listed plainly under "Where it still fails"
  const failuresList = page.getByRole("list", { name: "Recorded failures" });
  await expect(failuresList).toContainText("Meridian Industrial Corp.");
  await expect(failuresList).toContainText("Accrued liabilities (left column)");
  await expect(failuresList).toContainText("4,820");
  await expect(failuresList).toContainText("4,280");
  await expect(failuresList).toContainText("Harborview Bancorp");
  await expect(failuresList).toContainText("Total deposits (left column)");
  await expect(failuresList).toContainText("Not rebuilt");
  await expect(failuresList).toContainText("18,940");

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("shows the running state with progress banner and unrun steps at 375, 768 and 1440 pixels", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/results?scores=running");

  await expect(page.getByText("The test is running.")).toBeVisible();
  await expect(page.getByText(/32 of 50 filings scored so far/)).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Filings scored" }),
  ).toHaveAttribute("aria-valuenow", "32");
  await expect(page.getByTestId("headline-wrong-shown")).toHaveText(
    "0 of 2,048",
  );
  await expect(
    page.getByRole("region", { name: "How sure is the re-check?" }).getByText("not run").first(),
  ).toBeVisible();

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("shows the empty state when scores are empty at 375, 768 and 1440 pixels", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("link", { name: "Test results" }).click();
  await expect(page).toHaveURL(/\/results$/);
  // The repository now holds the real results in data/scores.json, so the plain page shows them.
  // A missing file is covered by the unit tests in src/lib/scores.test.ts.
  await expect(
    page.getByRole("heading", { name: "Does it work on pages we did not pick?" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "One plain model call also read every number right. The difference is proof: Adds Up shows the sum behind every tick.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What the second reader decides" }),
  ).toBeVisible();
  // The blurred-copies step has run on the real scores, so the page shows its "first look" sentence.
  await expect(page.getByText(/only a first look/i)).toBeVisible();
  // At 1440 the filings show as a table. At 375 they show as cards.
  await expect(
    page.getByRole("cell", { name: "from memory" }).first(),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 900 });
  await expect(page.getByText("from memory").first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/results?scores=empty");
  await expect(
    page.getByRole("heading", { name: "No test has run yet" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The test reads 50 filings that a script picks. Results appear here when it ends.",
    ),
  ).toBeVisible();

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
