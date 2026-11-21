import { expect, test } from "@playwright/test";

test("searches for Apple, picks the first match, and shows the company name", async ({
  page,
}) => {
  await page.goto("/");

  const searchBox = page.getByRole("combobox", {
    name: "Type a US public company",
  });
  await searchBox.fill("Apple");

  const options = page.getByRole("option");
  await expect(options.first()).toContainText("AAPL");
  await expect(options.first()).toContainText("Apple Inc.");

  await options.first().click();

  await expect(page).toHaveURL(/\/company\/320193$/);
  await expect(page.getByRole("heading", { name: "Apple Inc." })).toBeVisible();
});

test("shows the not-listed message for an unknown company (A6)", async ({
  page,
}) => {
  await page.goto("/");

  const searchBox = page.getByRole("combobox", {
    name: "Type a US public company",
  });
  await searchBox.fill("zzzz");

  await expect(
    page.getByText("zzzz is not in the SEC's list."),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Private and foreign companies do not file there. Pick a listed company, or upload a statement.",
    ),
  ).toBeVisible();
});

test("picks Apple Inc. from Try an example", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("link", { name: "Apple", exact: true }).click();

  await expect(page).toHaveURL(/\/company\/320193$/);
  await expect(page.getByRole("heading", { name: "Apple Inc." })).toBeVisible();
});

test("navigates search matches with arrow keys and Enter", async ({ page }) => {
  await page.goto("/");

  const searchBox = page.getByRole("combobox", {
    name: "Type a US public company",
  });
  await searchBox.fill("apple");

  const options = page.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Apple Inc.");
  await expect(options.nth(1)).toContainText("Apple Hospitality REIT, Inc.");

  await searchBox.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");

  await searchBox.press("Enter");
  await expect(page).toHaveURL(/\/company\/1418121$/);
  await expect(
    page.getByRole("heading", { name: "Apple Hospitality REIT, Inc." }),
  ).toBeVisible();
});

test("finds everyday company names like google and rejects invalid CIK paths with 404", async ({
  page,
  request,
}) => {
  await page.goto("/");

  const searchBox = page.getByRole("combobox", {
    name: "Type a US public company",
  });
  await searchBox.fill("google");

  const options = page.getByRole("option");
  await expect(options.first()).toContainText("GOOGL");
  await expect(options.first()).toContainText("Alphabet Inc.");

  const badPage = await request.get("/company/not-a-cik");
  expect(badPage.status()).toBe(404);

  const tooLongPage = await request.get("/company/12345678901");
  expect(tooLongPage.status()).toBe(404);

  const badApi = await request.get("/api/company/not-a-cik/statement");
  expect(badApi.status()).toBe(404);
});

test("renders the start screen at 375, 768 and 1440 pixels wide with no sideways scroll", async ({
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

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Adds Up" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Check a statement" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Test results" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Which company's balance sheet should we check?",
      }),
    ).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
