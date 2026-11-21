import { expect, test } from "@playwright/test";

test("opens Apple Inc. in test mode and shows the balance sheet picture, form and filing date", async ({
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

  const pictureResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/company/320193/picture") &&
      res.request().method() === "GET",
  );

  await page.goto("/company/320193");

  const pictureResponse = await pictureResponsePromise;
  expect(pictureResponse.status()).toBe(200);
  expect(pictureResponse.headers()["content-type"]).toContain("image/png");

  await expect(
    page.getByRole("heading", { name: "Apple Inc." }),
  ).toBeVisible();
  await expect(page.getByText(/10-K/)).toBeVisible();
  await expect(page.getByText(/Nov 3, 2026/)).toBeVisible();
  await expect(page.getByText("Picture sent to the models")).toBeVisible();

  // Wait for the page's own finished state before checking picture and viewports.
  await expect(page.getByText("26 of 26 numbers proven")).toBeVisible();

  const picture = page.getByRole("img", {
    name: /Apple Inc\. balance sheet/i,
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

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(picture).toBeVisible();
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("proves Apple Inc. balance sheet in test mode and shows the verdict band, counts, ticks and brackets at 375, 768 and 1440 pixels", async ({
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
  const readResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/company/320193/read") &&
      res.request().method() === "POST",
  );

  await page.goto("/company/320193");

  const readResponse = await readResponsePromise;
  expect(readResponse.status()).toBe(200);

  // Wait for the page's own verdict band state.
  await expect(page.getByText("26 of 26 numbers proven")).toBeVisible();

  const verdictBand = page.locator('[data-verdict-band="true"]');
  await expect(verdictBand.locator('[data-count="proven"]')).toHaveText(
    "26 proven",
  );
  await expect(verdictBand.locator('[data-count="need-your-eye"]')).toHaveText(
    "0 need your eye",
  );
  await expect(verdictBand.locator('[data-count="not-proven"]')).toHaveText(
    "0 not proven",
  );
  await expect(verdictBand.locator('[data-sec-match="true"]')).toHaveText(
    "Matches SEC data: 26 of 26",
  );

  // Ticks on proven numbers, brackets on groups, and no mark on heading rows.
  const provenMarks = page.locator('[data-proof-mark="proven"]');
  await expect(provenMarks).toHaveCount(13);
  await expect(provenMarks.first()).toBeVisible();
  await expect(
    page.locator('[data-proof-bracket="proven"]').first(),
  ).toBeVisible();
  await expect(
    page.locator('tr[data-row-kind="heading"] [data-proof-mark]'),
  ).toHaveCount(0);

  // Check responsive layout at 375, 768 and 1440 pixels with no sideways scroll.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText("26 of 26 numbers proven")).toBeVisible();
    await expect(provenMarks.first()).toBeVisible();
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("shows the slow screen when ?slow=1 is used in test mode", async ({
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
  await page.goto("/company/320193?slow=1");

  // Wait for the page's own slow-screen state when the first call exceeds the test timeout.
  await expect(page.getByText("Reading took too long")).toBeVisible();
  await expect(
    page.getByText(/A model did not answer within 12 seconds/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What happened" }),
  ).toBeVisible();
  await expect(page.getByText("Strip 2 of 2 timed out.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Read it again" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Change company" }),
  ).toBeVisible();

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  // Repeat finishes and transitions to the proven result screen.
  await expect(page.getByText("26 of 26 numbers proven")).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
