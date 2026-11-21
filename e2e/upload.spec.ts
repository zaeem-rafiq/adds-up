import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const STATEMENT_FIXTURE = path.join(
  process.cwd(),
  "src/fixtures/uploads/statement-apple.png",
);
const HOLIDAY_FIXTURE = path.join(
  process.cwd(),
  "src/fixtures/uploads/holiday-photo.png",
);

test("uploads statement-apple.png from the start screen, proves 26 of 26 numbers without Matches SEC data, hides a number, and has no sideways scroll at 375, 768 and 1440 pixels", async ({
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

  await expect(
    page.getByRole("button", { name: "Upload a statement" }),
  ).toBeVisible();

  const fileInput = page.locator('input[data-upload-input="true"]');
  await fileInput.setInputFiles(STATEMENT_FIXTURE);

  await expect(page).toHaveURL(/\/upload\/[a-zA-Z0-9-]+$/);
  await expect(
    page.getByRole("heading", { name: "Your statement" }),
  ).toBeVisible();
  await expect(
    page.getByText("statement-apple.png · uploaded just now"),
  ).toBeVisible();

  const verdictBand = page.locator('[data-verdict-band="true"]');
  await expect(verdictBand).toContainText("26 of 26 numbers proven");
  await expect(verdictBand.locator('[data-count="proven"]')).toHaveText(
    "26 proven",
  );
  await expect(verdictBand.locator('[data-count="need-your-eye"]')).toHaveText(
    "0 need your eye",
  );
  await expect(verdictBand.locator('[data-count="not-proven"]')).toHaveText(
    "0 not proven",
  );

  // No SEC data comparison count or SEC value words on an upload.
  await expect(page.getByText(/Matches SEC data/i)).toHaveCount(0);
  await expect(page.getByText(/Matches the SEC/i)).toHaveCount(0);

  // Proven ticks and the uploaded picture are visible.
  await expect(page.locator('[data-proof-mark="proven"]')).toHaveCount(13);
  const picture = page.getByRole("img", {
    name: /Uploaded balance sheet picture/i,
  });
  await expect(picture).toBeVisible();
  const dimensions = await picture.evaluate((img: HTMLImageElement) => ({
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
  }));
  expect(dimensions.complete).toBe(true);
  expect(dimensions.naturalWidth).toBeGreaterThan(0);
  expect(dimensions.naturalHeight).toBeGreaterThan(0);

  // Check responsive layout at 375, 768 and 1440 px wide with no sideways scroll.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(verdictBand).toContainText("26 of 26 numbers proven");
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  // Hide Inventories (row index 4, left column 0) on the uploaded picture and verify rebuild.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-cell-button="4-0"]').click();
  const selectedPanel = page.locator('[data-selected-panel="true"]');
  await expect(selectedPanel).toContainText("Inventories");

  const modifyPromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/upload/") &&
      res.url().includes("/modify") &&
      res.request().method() === "POST",
  );
  await selectedPanel.getByRole("button", { name: "Hide it" }).click();
  expect((await modifyPromise).status()).toBe(200);

  await expect(verdictBand).toContainText("Rebuilt: 14,541");
  await expect(page.locator('[data-hidden-panel="true"]')).toContainText(
    "14,541",
  );

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("uploads dispute-apple.png where the two readers differ on one number and gives that number no tick", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // A file whose name starts with "dispute" makes the test-mode second reader change one number.
  await page.locator('input[data-upload-input="true"]').setInputFiles({
    name: "dispute-apple.png",
    mimeType: "image/png",
    buffer: readFileSync(STATEMENT_FIXTURE),
  });

  await expect(page).toHaveURL(/\/upload\/[a-zA-Z0-9-]+$/);
  const verdictBand = page.locator('[data-verdict-band="true"]');
  await expect(
    verdictBand.locator('[data-disputed-note="true"]'),
  ).toHaveText(
    "1 number was read differently by the two readers and got no tick.",
  );
  await expect(page.locator('[data-second-reader-note="true"]')).toHaveCount(0);
  await expect(verdictBand).not.toContainText("26 of 26 numbers proven");

  // The first left-hand number is the one that was changed: not read, no tick.
  const disputedCell = page.locator('tr[data-row-index="0"] td[data-col="0"]');
  await expect(disputedCell).toHaveAttribute("data-proof-status", "unread");
  await expect(disputedCell).toContainText("Not read");
  await expect(
    page.locator('tr[data-row-index="0"] [data-proof-mark="proven"]'),
  ).toHaveCount(0);

  await page.locator('[data-cell-button="0-0"]').click();
  const selectedPanel = page.locator('[data-selected-panel="true"]');
  await expect(selectedPanel).toContainText("Two readers disagree:");
  await expect(selectedPanel).toContainText("Needs your eye");

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      verdictBand.locator('[data-disputed-note="true"]'),
    ).toBeVisible();
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }
});

test("uploads holiday-photo.png and shows the no-statement screen from design/desktop-badupload.png at 375, 768 and 1440 pixels", async ({
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

  const fileInput = page.locator('input[data-upload-input="true"]');
  await fileInput.setInputFiles(HOLIDAY_FIXTURE);

  await expect(page).toHaveURL(/\/upload\/[a-zA-Z0-9-]+$/);
  await expect(
    page.getByRole("heading", {
      name: "We could not find a statement in this file",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("holiday-photo.png · uploaded just now"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Use one picture, PNG or JPEG, that shows a single balance sheet.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Drop a picture of one page here"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose a file" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Pick a company" }),
  ).toBeVisible();

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      page.getByRole("heading", {
        name: "We could not find a statement in this file",
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

test("refuses a PDF upload on the start screen with the plain PDF message and makes no request", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let uploadRequests = 0;

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
  });
  page.on("request", (req) => {
    if (req.url().includes("/api/upload")) uploadRequests += 1;
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const fileInput = page.locator('input[data-upload-input="true"]');
  await fileInput.setInputFiles({
    name: "statement-page-3.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\n"),
  });

  await expect(page.locator('[data-upload-error="true"]')).toHaveText(
    "Upload one page as a picture. A PDF is not read yet.",
  );
  expect(uploadRequests).toBe(0);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
