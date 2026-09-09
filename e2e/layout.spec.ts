import { test, expect } from "@playwright/test";
import { openPortal, watchErrors, expectNoErrors } from "./_helpers";

// Read-only cross-page checks: shared CSS regressions often spare the dashboard but break a table.
for (const width of [390, 820, 1440]) {
  for (const theme of ["light", "dark"]) {
    test(`navigation pages fit ${width}px in ${theme} mode`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator("main h1")).toBeVisible();
      const errors = watchErrors(page);
      await page.evaluate((value) => localStorage.setItem("portal-theme", value), theme);
      const destinations = await page.locator("nav a").evaluateAll((links) =>
        links.map((link) => ({ path: link.getAttribute("href")!, name: link.textContent! })),
      );
      for (const destination of destinations) {
        await test.step(destination.name, async () => {
          await page.goto(destination.path);
          await expect(page.locator("main h1")).toBeVisible();
          await expect(page.locator("main .skeleton")).toHaveCount(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth), destination.path).toBeLessThanOrEqual(width + 1);
          if (width === 390) {
            await expect(page.locator("aside.sidebar")).toBeHidden();
          }
        });
      }
      expectNoErrors(errors);
    });
  }
}

test("mobile navigation closes with Escape and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("main h1")).toBeVisible();
  const menu = page.getByRole("button", {name:"Toggle navigation"});
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("aside.sidebar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(page.locator("aside.sidebar")).toBeHidden();
});

test("Telemetry follows the shell environment", async ({ page }) => {
  await openPortal(page, "/telemetry");
  const environments = page.getByRole("group", {name:"Environment", exact:true});
  await expect(environments).toHaveCount(1);
  const buttons = environments.getByRole("button");
  const last = buttons.last();
  const environment = (await last.innerText()).toLowerCase();
  await last.click();
  await expect(last).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".card-head h3").first()).toContainText(environment);
});
