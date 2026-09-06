import { expect, test } from "@playwright/test";
import { expectNoErrors, openPortal, screenTitle, watchErrors } from "./_helpers";

/**
 * The catalog: the screen a consumer arrives on, and the one that has to answer "what is here"
 * without anybody explaining it first.
 *
 * The assertions are about the *shape* of the answer — browsable by domain, searchable across
 * domains, a read-only listing that opens — rather than about any particular API, because the
 * estate this runs against is seeded differently from one machine to the next. An estate with
 * nothing published is a legitimate state and skips rather than fails.
 *
 * There used to be two of these screens under one title, one of them a client-side filter over the
 * resource list. `/discover` is now an address on this one, and the first test asserts it.
 */

const CARD = "article.listing";
/** Only the domains that hold something; the empty ones are drawn, disabled, on purpose. */
const OPENABLE = ".domain-head:not([disabled])";

test("the catalog browses by domain, and /discover arrives at the same screen", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/discover");
  await expect(screenTitle(page)).toHaveText("Catalog");

  const heads = page.locator(OPENABLE);
  if ((await heads.count()) === 0) {
    // Empty is a legitimate answer, and the screen says so with something to do about it rather
    // than rendering a blank list.
    await expect(page.getByRole("heading", { name: "Nothing is published yet" })).toBeVisible();
    expectNoErrors(errors);
    return;
  }

  // Closed until asked for: thirteen domains eagerly loading their contents is thirteen requests
  // nobody asked for, so the fold is what actually fetches.
  const head = heads.first();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`.domain-body ${CARD}`).first()).toBeVisible();

  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".domain-body")).toHaveCount(0);

  expectNoErrors(errors);
});

test("search crosses the domains, and clearing it puts them back", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/catalog");

  const heads = page.locator(OPENABLE);
  test.skip((await heads.count()) === 0, "nothing is published on this estate");

  // Browsing is by domain; searching is across them, because somebody typing an operation id is
  // asking a question the taxonomy has no opinion about.
  await page.getByLabel("Search", { exact: true }).fill("zzzz-nothing-matches-this");
  await expect(page.getByRole("heading", { name: "Nothing matches that" })).toBeVisible();
  await expect(page.locator(".domain-list")).toHaveCount(0);

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".domain-list")).toBeVisible();

  expectNoErrors(errors);
});

test("a card opens the read-only listing, not the publisher's editor", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/catalog");

  const heads = page.locator(OPENABLE);
  test.skip((await heads.count()) === 0, "nothing is published on this estate");
  await heads.first().click();

  const card = page.locator(`.domain-body ${CARD}`).first();
  await expect(card).toBeVisible();
  await card.locator("a").first().click();

  await expect(screenTitle(page)).toHaveText("API");
  // The consumer's questions, in the order they are asked — and none of the publisher's controls,
  // which is the whole point of the catalogue opening a listing rather than a workspace.
  for (const tab of ["Overview", "Getting started", "Try it", "Versions"]) {
    await expect(page.getByRole("button", { name: tab, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Subscribe", exact: true })).toBeVisible();
  // And it arrived at the catalogue's own address rather than at the owning application's
  // workspace, which is the failure this consolidation was about.
  expect(new URL(page.url()).pathname).toMatch(/^\/catalog\//);

  expectNoErrors(errors);
});
