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

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });

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

    // Wait for the fast test-mode read to finish so the next viewport navigation
    // does not abort an in-flight fetch.
    await expect(
      page.getByText("26 numbers read. 26 match the SEC's values."),
    ).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("reads Apple Inc. balance sheet in test mode and shows the count line", async ({
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

  await expect(
    page.getByText("26 numbers read. 26 match the SEC's values."),
  ).toBeVisible();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
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

  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/company/320193?slow=1");

    // Slow screen appears when the first call exceeds the shortened test timeout.
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

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    // Repeat finishes and shows the count line.
    await expect(
      page.getByText("26 numbers read. 26 match the SEC's values."),
    ).toBeVisible();
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
