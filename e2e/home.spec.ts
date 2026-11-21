import { expect, test } from "@playwright/test";

test("shows the product name on the start page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Adds Up" })).toBeVisible();
});
