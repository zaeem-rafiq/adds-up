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
      "Hide any ticked number on this balance sheet. Adds Up works out what it was.",
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

test("shows all three second-reader classes for numbers outside every total on the second fixture company at 375, 768 and 1440 pixels", async ({
  page,
  request,
}) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.url()} (${req.failure()?.errorText})`);
  });

  // Verify /api/company/[cik]/statement returns JSON with statement and source.
  const stmtRes = await request.get("/api/company/990001/statement");
  expect(stmtRes.status()).toBe(200);
  const stmtJson = (await stmtRes.json()) as {
    statement: { cik: string; companyName: string };
    source: string;
  };
  expect(stmtJson.source).toBe("fixture");
  expect(stmtJson.statement.companyName).toBe("Northstar Sample Corp");

  // 1) Agrees (0.97 default): numbers outside every total stay "not proven" with no question.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/company/990001");

  const verdictBand = page.locator('[data-verdict-band="true"]');
  await expect(verdictBand).toContainText("12 of 14 numbers proven");
  await expect(verdictBand.locator('[data-count="proven"]')).toHaveText(
    "12 proven",
  );
  await expect(verdictBand.locator('[data-count="need-your-eye"]')).toHaveText(
    "0 need your eye",
  );
  await expect(verdictBand.locator('[data-count="not-proven"]')).toHaveText(
    "2 not proven",
  );
  await expect(page.locator('td[data-second-reader="agrees"]')).toHaveCount(2);
  await expect(page.locator('[data-proof-mark="not-proven"]')).toHaveCount(2);

  // 2) Unsure (?unsure=Restricted cash -> 0.60): shows "Needs your eye" (amber) and counts under need your eye.
  await page.goto("/company/990001?unsure=Restricted+cash");
  await expect(verdictBand).toContainText("1 number needs your eye");
  await expect(verdictBand.locator('[data-count="proven"]')).toHaveText(
    "12 proven",
  );
  await expect(verdictBand.locator('[data-count="need-your-eye"]')).toHaveText(
    "1 need your eye",
  );
  await expect(verdictBand.locator('[data-count="not-proven"]')).toHaveText(
    "1 not proven",
  );
  await expect(page.locator('td[data-second-reader="unsure"]')).toHaveCount(1);
  await expect(page.locator('[data-proof-mark="needs-eye"]')).toHaveCount(1);
  await expect(page.locator('td[data-second-reader="agrees"]')).toHaveCount(1);

  // 3) Disagrees (?doubt=Deferred tax asset -> 0.10): shows "Needs your eye" marked in red, plus unsure on Restricted cash.
  await page.goto(
    "/company/990001?unsure=Restricted+cash&doubt=Deferred+tax+asset",
  );
  await expect(verdictBand).toContainText("2 numbers need your eye");
  await expect(verdictBand.locator('[data-count="proven"]')).toHaveText(
    "12 proven",
  );
  await expect(verdictBand.locator('[data-count="need-your-eye"]')).toHaveText(
    "2 need your eye",
  );
  await expect(verdictBand.locator('[data-count="not-proven"]')).toHaveText(
    "0 not proven",
  );
  await expect(page.locator('td[data-second-reader="unsure"]')).toHaveCount(1);
  await expect(page.locator('td[data-second-reader="disagrees"]')).toHaveCount(1);
  await expect(page.locator('[data-proof-mark="needs-eye"]')).toHaveCount(1);
  await expect(page.locator('[data-proof-mark="needs-eye-red"]')).toHaveCount(1);

  // Clicking the red disagreed cell shows the red "Needs your eye" badge in the selected panel.
  await page
    .locator('td[data-second-reader="disagrees"] button[data-cell-button]')
    .click();
  await expect(
    page.locator('[data-selected-badge="needs-eye-red"]'),
  ).toHaveText("Needs your eye");

  // Responsive check at 375, 768 and 1440 px wide with no sideways scroll.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(verdictBand).toContainText("2 numbers need your eye");
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("shows a total that adds up within rounding with the third mark, the note, the fourth count and no red at 375, 768 and 1440 pixels", async ({
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

  // Harbor Mill Sample Corp is in millions. Its current assets add to 7,100 and print 7,101.
  const note =
    "3 lines add to 7,100. Printed 7,101. Adds up within rounding, off by 1.";

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/company/990002");

  const band = page.locator('[data-verdict-band="true"]');
  await expect(band).toBeVisible();

  // The headline counts exact proofs only. The fourth count shows because it is not zero.
  await expect(band.getByText("26 of 30 numbers proven")).toBeVisible();
  await expect(band.locator('[data-count="proven"]')).toHaveText("26 proven");
  await expect(band.locator('[data-count="need-your-eye"]')).toHaveText(
    "0 need your eye",
  );
  await expect(band.locator('[data-count="not-proven"]')).toHaveText(
    "0 not proven",
  );
  await expect(band.locator('[data-count="within-rounding"]')).toHaveText(
    "4 within rounding",
  );

  // Nothing is red: no red mark, no red segment in the bar, no red headline, no "does not add up".
  await expect(page.locator('[data-proof-mark="mismatch-total"]')).toHaveCount(0);
  await expect(page.locator('[data-proof-mark="mismatch-member"]')).toHaveCount(0);
  await expect(band.locator('[class*="b53800"]')).toHaveCount(0);
  await expect(band.locator('[data-bar-segment="within-rounding"]')).toBeVisible();
  await expect(band.locator("p").first()).toHaveCSS("color", "rgb(20, 108, 67)");
  await expect(page.getByText(/not add up/i)).toHaveCount(0);

  // The third mark sits on the four numbers of the rounding group. The other 11 rows keep their ticks.
  const roundingMarks = page.locator('[data-proof-mark="within-rounding"]');
  await expect(roundingMarks).toHaveCount(4);
  await expect(roundingMarks.first()).toBeVisible();
  await expect(roundingMarks.first()).toHaveAttribute(
    "aria-label",
    "Adds up within rounding",
  );
  await expect(page.locator('[data-proof-mark="proven"]')).toHaveCount(11);
  const totalRow = page.locator('tr[data-row-kind="number"][data-row-index="3"]');
  await expect(totalRow.locator('[data-proof-mark="within-rounding"]')).toBeVisible();
  await expect(totalRow.locator('td[data-col="0"]')).toHaveAttribute(
    "data-proof-status",
    "within_rounding",
  );
  await expect(totalRow.locator('td[data-col="1"]')).toHaveAttribute(
    "data-proof-status",
    "proven",
  );

  // The note beside the total.
  await expect(totalRow.locator('[data-proof-note="rounding"]')).toContainText(note);

  // The side panel of a line in the group, and of the total.
  await page.locator('[data-cell-button="0-0"]').click();
  const panel = page.locator('[data-selected-panel="true"]');
  await expect(panel.locator('[data-selected-badge="within-rounding"]')).toHaveText(
    "Within rounding",
  );
  await expect(panel.locator('[data-rounding-note="true"]')).toContainText(
    "Sits inside Total current assets, which adds up within rounding, off by 1. The filing rounds each line.",
  );
  await page.locator('[data-cell-button="3-0"]').click();
  await expect(panel.locator('[data-rounding-note="true"]')).toContainText(
    "Total current assets adds up within rounding, off by 1. The filing rounds each line.",
  );

  // A number in the group cannot be hidden or changed, and no model call is made.
  await panel.getByRole("button", { name: "Hide it" }).click();
  await expect(page.locator('[data-hide-refusal="true"]')).toHaveText(
    "This number's group adds up only within rounding.",
  );
  await panel.getByRole("button", { name: "Change it" }).click();
  await expect(page.locator('[data-hide-refusal="true"]')).toHaveText(
    "This number's group adds up only within rounding.",
  );
  await expect(page.locator('[data-change-form="true"]')).toHaveCount(0);
  expect(modifyCalls).toBe(0);

  // Every width: no sideways scroll, the band and the note stay visible.
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(band.locator('[data-count="within-rounding"]')).toBeVisible();
    const noteLocator =
      width < 768
        ? page.locator('tr[data-mobile-proof-for="3"] [data-proof-note="rounding"]')
        : totalRow.locator('[data-proof-note="rounding"]');
    await expect(noteLocator).toBeVisible();
    await expect(noteLocator).toContainText(note);
    await expect(roundingMarks.first()).toBeVisible();
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
