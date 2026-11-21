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

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
