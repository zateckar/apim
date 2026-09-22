import { expect, test } from "@playwright/test";
import { expectNoErrors, openPortal, screenTitle, watchErrors } from "./_helpers";

/**
 * The shell: what is on every screen, and the two things it offers from the top bar.
 *
 * `ui/test/portal.test.tsx` already asserts that every navigable route is linked, over the source.
 * What it cannot assert is that the link *arrives* somewhere — a route in the table, a link in the
 * sidebar and a screen that renders are three separate facts, and only a browser can check the
 * third against a real control plane.
 */

test("the portal loads with a title, a purpose and the estate's own chrome", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page);

  await expect(screenTitle(page)).toHaveText("Dashboard");
  // The one honesty statement the chrome carries: the six external systems are simulated in this
  // phase, and the shell says so on every screen rather than each screen saying it separately.
  await expect(page.getByText("External systems simulated")).toBeVisible();

  expectNoErrors(errors);
});

test("every application tab in the sidebar opens a screen that renders", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page);

  // Taken from the sidebar rather than from a list written here: a tab that leaves the shell should
  // make this spec shorter, not make it fail on an address nobody offers any more.
  const tabs = await page.locator("aside.sidebar nav .nav-item").evaluateAll((nodes) =>
    nodes.map((node) => ({ href: node.getAttribute("href")!, label: node.textContent!.trim() })),
  );
  expect(tabs.length).toBeGreaterThan(8);

  for (const tab of tabs) {
    await page.goto(tab.href);
    await expect(screenTitle(page), tab.href).not.toBeEmpty();
    // And its one-line purpose, which comes from the same table as the title — so a screen that
    // reached the sidebar without one fails here rather than shipping with a blank line under it.
    await expect(page.locator(".native-page-purpose"), tab.href).not.toBeEmpty();
    // Not a blank page pretending to be a screen: the shell's main region has something in it.
    await expect(page.locator("main.native-content"), tab.href).not.toBeEmpty();
  }

  expectNoErrors(errors);
});

test("the version in the top bar opens the change log", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page);

  const version = page.getByRole("button", { name: /^Portal version/ });
  await expect(version).toBeVisible();
  await version.click();

  const dialog = page.getByRole("dialog", { name: "What changed in the portal" });
  await expect(dialog).toBeVisible();
  // At least one release, each with a version and a date, and at least one categorised bullet —
  // the three things a malformed CHANGELOG.md would silently drop.
  await expect(dialog.locator(".changelog-entry").first()).toBeVisible();
  await expect(dialog.locator(".changelog-version").first()).toHaveText(/^v\d/);
  await expect(dialog.locator(".changelog-date").first()).toHaveText(/^\d{2}\.\d{2}\.\d{4}$/);
  await expect(dialog.locator(".changelog-tag").first()).toBeVisible();

  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await expect(dialog).toBeHidden();

  expectNoErrors(errors);
});

test("switching environment keeps you on the screen you were reading", async ({ page }) => {
  const errors = watchErrors(page);
  const application = await openPortal(page);
  await page.goto(`/${application}/subscriptions`);
  await expect(screenTitle(page)).toHaveText("Subscriptions");

  const environments = page.locator('[role="group"][aria-label="Environment"] button');
  const count = await environments.count();
  expect(count).toBeGreaterThan(1);
  await environments.nth(1).click();

  await expect(environments.nth(1)).toHaveClass(/active/);
  await expect(screenTitle(page)).toHaveText("Subscriptions");

  expectNoErrors(errors);
});
