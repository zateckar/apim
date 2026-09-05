import { expect, test } from "@playwright/test";
import { expectNoErrors, openPortal, screenTitle, watchErrors } from "./_helpers";

/**
 * Health Status, which is the screen that decides whether somebody promotes this afternoon.
 *
 * Every probe on it reaches something real — the database, the gateway addresses, the log index —
 * so this is the one spec in the suite that is genuinely end-to-end: the control plane has to be
 * able to see its own estate for it to pass.
 */

test("each environment gets a verdict, and the components behind it are named", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/fleet");
  await expect(screenTitle(page)).toHaveText("Health Status");

  const cards = page.locator(".health-env-card");
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    // A verdict is a word, not a colour: the same fact has to survive a screenshot in greyscale.
    await expect(card.locator(".health-env-verdict")).toHaveText(
      /Healthy|Degraded|Down|Not deployed/,
    );
    await expect(card.locator(".env-tag")).not.toBeEmpty();
  }

  // The matrix underneath, which is what a verdict is made of. Every row says what it is, whether
  // it answered, and — for anything simulated — that it is simulated.
  const rows = page.locator(".health-row");
  await expect(rows.first()).toBeVisible();
  await expect(rows.first().locator(".health-label")).not.toBeEmpty();

  expectNoErrors(errors);
});

test("the uptime strip has a range you can change", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/fleet");

  const panel = page.locator(".synthetics-panel");
  await expect(panel).toBeVisible();

  const ranges = panel.locator(".uptime-range-btn");
  const count = await ranges.count();
  expect(count).toBeGreaterThan(1);

  await ranges.nth(count - 1).click();
  await expect(ranges.nth(count - 1)).toHaveClass(/active/);
  // Either a strip or a sentence saying why there is none. What must not happen is a panel that
  // renders neither and leaves the reader unable to tell "no data" from "still loading".
  await expect(panel.locator(".uptime-bars, .card-body .empty").first()).toBeVisible();

  expectNoErrors(errors);
});
