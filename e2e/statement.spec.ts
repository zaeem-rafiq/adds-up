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

test("hides Inventories on Apple Inc., rebuilds 14,541, and restores the unchanged statement", async ({
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
  await page.goto("/company/320193");

  await expect(page.getByText("26 of 26 numbers proven")).toBeVisible();
  await expect(
    page.getByText(
      "Hide any number on this balance sheet. Adds Up works out what it was.",
    ),
  ).toBeVisible();

  // First proven left-column number is selected automatically with Hide it and Change it visible.
  const selectedPanel = page.locator('[data-selected-panel="true"]');
  await expect(selectedPanel).toContainText("Cash and cash equivalents");
  await expect(
    selectedPanel.getByRole("button", { name: "Hide it" }),
  ).toBeVisible();
  await expect(
    selectedPanel.getByRole("button", { name: "Change it" }),
  ).toBeVisible();

  // Pick Inventories (row index 4, left column 0) and hide it.
  await page.locator('[data-cell-button="4-0"]').click();
  await expect(selectedPanel).toContainText("Inventories");

  const modifyResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/company/320193/modify") &&
      res.request().method() === "POST",
  );
  await selectedPanel.getByRole("button", { name: "Hide it" }).click();

  const modifyResponse = await modifyResponsePromise;
  expect(modifyResponse.status()).toBe(200);

  // The same words also show in the side panel and the history, so look in the verdict band.
  const rebuiltBand = page.locator('[data-verdict-band="true"]');
  await expect(rebuiltBand).toContainText("Rebuilt: 14,541");
  const hiddenPanel = page.locator('[data-hidden-panel="true"]');
  await expect(hiddenPanel).toContainText("The hidden number is");
  await expect(hiddenPanel).toContainText("14,541");
  await expect(hiddenPanel).toContainText("173,857");
  await expect(hiddenPanel).toContainText("159,316");
  await expect(page.getByText("You hid Inventories.")).toBeVisible();
  await expect(page.getByText("Rebuilt 14,541 from the total.")).toBeVisible();

  // Check responsive layout at 375, 768 and 1440 px with no sideways scroll.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(rebuiltBand).toContainText("Rebuilt: 14,541");
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  // Return to unchanged statement and verify we can pick another number.
  await page.getByRole("button", { name: "Reveal the number" }).click();
  await expect(page.getByText("26 of 26 numbers proven")).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("changes Inventories on Apple Inc. to 15,541, marks the group with a gap of 1,000, and shows the cause sentence", async ({
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
  await page.goto("/company/320193");

  await expect(page.getByText("26 of 26 numbers proven")).toBeVisible();

  // Select Inventories (row index 4, left column 0) and open Change form.
  await page.locator('[data-cell-button="4-0"]').click();
  const selectedPanel = page.locator('[data-selected-panel="true"]');
  await selectedPanel.getByRole("button", { name: "Change it" }).click();

  const input = page.getByLabel(/New value for Inventories/i);

  // Refuse non-number input with a plain message.
  await input.fill("not-a-number");
  await page.getByRole("button", { name: "Apply change" }).click();
  await expect(page.locator('[data-change-error="true"]')).toBeVisible();

  // Submit 15,541 and wait for modify + cause responses.
  const modifyPromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/company/320193/modify") &&
      res.request().method() === "POST",
  );
  const causePromise = page.waitForResponse(
    (res) =>
      res.url().includes("/api/company/320193/cause") &&
      res.request().method() === "POST",
  );

  await input.fill("15,541");
  await page.getByRole("button", { name: "Apply change" }).click();

  expect((await modifyPromise).status()).toBe(200);
  expect((await causePromise).status()).toBe(200);

  // Verdict headline repeats side panel heading; gap and cause sentence are visible.
  const verdictBand = page.locator('[data-verdict-band="true"]');
  await expect(verdictBand).toContainText("Current assets are off by 1,000");
  await expect(verdictBand.locator('[data-verdict-gap="true"]')).toHaveText(
    "Gap: 1,000",
  );

  const changedPanel = page.locator('[data-changed-panel="true"]');
  await expect(changedPanel).toContainText("Current assets are off by 1,000");
  await expect(changedPanel).toContainText("174,857");
  await expect(changedPanel).toContainText("173,857");
  await expect(changedPanel.locator('[data-cause-sentence="true"]')).toBeVisible();
  await expect(
    changedPanel.locator('[data-cause-sentence="true"]'),
  ).toContainText(/printed total/i);

  await expect(page.getByText("You changed Inventories.")).toBeVisible();
  await expect(page.getByText("Current assets stopped adding up.")).toBeVisible();

  // Check responsive layout at 375, 768 and 1440 px with no sideways scroll.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(
      changedPanel.locator('[data-cause-sentence="true"]'),
    ).toBeVisible();
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  // Undo back to the unchanged statement.
  await page.getByRole("button", { name: "Undo my change" }).click();
  await expect(page.getByText("26 of 26 numbers proven")).toBeVisible();

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("refuses to hide a number outside every total with a plain reason", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let modifyCalls = 0;

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
  });
  page.on("request", (req) => {
    if (req.url().includes("/modify")) modifyCalls += 1;
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  // Tesla's saved copy in test mode has numbers outside every total (not_proven).
  await page.goto("/company/1318605");

  await expect(
    page.locator('[data-verdict-band="true"]'),
  ).toBeVisible();

  // Pick the first cell marked not_proven in the table.
  const notProvenCellButton = page
    .locator('td[data-proof-status="not_proven"] button[data-cell-button]')
    .first();
  await expect(notProvenCellButton).toBeVisible();
  await notProvenCellButton.click();

  const selectedPanel = page.locator('[data-selected-panel="true"]');
  await selectedPanel.getByRole("button", { name: "Hide it" }).click();

  await expect(page.locator('[data-hide-refusal="true"]')).toBeVisible();
  await expect(page.locator('[data-hide-refusal="true"]')).toContainText(
    /outside every total/i,
  );
  expect(modifyCalls).toBe(0);

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
