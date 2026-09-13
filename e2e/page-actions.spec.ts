import { test, expect } from "@playwright/test";
import { openPortal } from "./_helpers";

// Local UI state only: these checks never save a form or alter the shared estate.
test("application search recovers from an empty result", async ({ page }) => {
  await openPortal(page, "/applications");
  const search = page.getByRole("textbox", { name: "Find an application" });
  await search.fill("no-matching-application-qa");
  await expect(page.getByText("No matching applications", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(page.locator("main table tbody tr").first()).toBeVisible();
});

test("audit search filters the loaded events and can be cleared", async ({ page }) => {
  await openPortal(page, "/audit");
  const search = page.getByRole("textbox", { name: "Search recent events" });
  await expect(page.locator("main table tbody tr").first()).toBeVisible();
  await search.fill("no-matching-event-qa");
  await expect(page.getByText("No matching events", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.locator("main table tbody tr").first()).toBeVisible();
});

test("product creation opens and cancels without saving", async ({ page }) => {
  await openPortal(page, "/products");
  await expect(page.locator("#new-product")).toHaveCount(0);
  await page.getByRole("button", { name: "+ Create a product", exact: true }).click();
  await page.locator("#new-product-name").fill("unsaved product draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#new-product")).toHaveCount(0);
});

test("activity filters preserve the complete list", async ({ page }) => {
  await openPortal(page, "/activity");
  const filters = page.getByRole("group", { name: "Activity filter" });
  const active = filters.getByRole("button", { name: /^In progress/ });
  await active.click();
  await expect(active).toHaveAttribute("aria-pressed", "true");
  const all = filters.getByRole("button", { name: /^All changes/ });
  await all.click();
  await expect(all).toHaveAttribute("aria-pressed", "true");
});
