import { expect, test } from "@playwright/test";
import { expectNoErrors, openPortal, screenTitle, watchErrors } from "./_helpers";

/**
 * The catalog: the screen a consumer arrives on, and the one that has to answer "what is here"
 * without anybody explaining it first.
 *
 * The assertions are about the *shape* of the answer — grouped by domain, one row per family,
 * search that narrows, a listing that opens — rather than about any particular API, because the
 * estate this runs against is seeded differently from one machine to the next. An estate with
 * nothing published is a legitimate state and skips rather than fails.
 */

const GROUP = ".discover-card";
const ROW = ".discover-item";

test("the catalog opens by domain and every group folds", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/discover");
  await expect(screenTitle(page)).toHaveText("Catalog");

  const rows = page.locator(ROW);
  if ((await rows.count()) === 0) {
    // Empty is a legitimate answer, and the screen says so with something to do about it rather
    // than rendering a blank list.
    await expect(page.locator(".empty")).toBeVisible();
    expectNoErrors(errors);
    return;
  }

  const groups = page.locator(GROUP);
  expect(await groups.count()).toBeGreaterThan(0);

  const first = groups.first();
  const head = first.locator(".discover-card-head");
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const before = await first.locator(ROW).count();
  expect(before).toBeGreaterThan(0);

  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(first.locator(ROW)).toHaveCount(0);

  // And the fold is the reader's, not the screen's: it comes back.
  await head.click();
  await expect(first.locator(ROW)).toHaveCount(before);

  expectNoErrors(errors);
});

test("search narrows the list, and clearing it puts everything back", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/discover");

  const rows = page.locator(ROW);
  const all = await rows.count();
  test.skip(all === 0, "nothing is published on this estate");

  const search = page.getByLabel("Search the catalog");
  await search.fill("zzzz-nothing-matches-this");
  await expect(rows).toHaveCount(0);
  await expect(page.getByText("Nothing matches those filters.")).toBeVisible();

  await page.getByRole("button", { name: "Clear them" }).click();
  await expect(rows).toHaveCount(all);

  expectNoErrors(errors);
});

test("a catalog row says who owns it, where it answers, and opens a listing", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/discover");

  const rows = page.locator(ROW);
  test.skip((await rows.count()) === 0, "nothing is published on this estate");

  const first = rows.first();
  // The two facts a row carries before you open anything: whose it is, and what its address is.
  await expect(first.locator(".di-owner-legend")).toContainText("Owner");
  await expect(first.locator(".di-path")).not.toBeEmpty();

  await first.locator(".di-name").click();
  const dialog = page.getByRole("dialog").first();
  await expect(dialog).toBeVisible();
  // What it does, and where it answers — the two questions a listing exists for.
  await expect(dialog.getByRole("button", { name: /operations/i })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /endpoints/i })).toBeVisible();
  await dialog.getByRole("button", { name: /operations/i }).click();

  expectNoErrors(errors);
});
