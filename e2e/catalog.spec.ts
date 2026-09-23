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
/** Empty domains remain available inside a disclosure; browsing starts with populated domains. */
const OPENABLE = ".domain-head:not([disabled])";

test("the catalog browses by domain, and /discover arrives at the same screen", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/discover");
  await expect(screenTitle(page)).toHaveText("Catalog");

  const heads = page.locator(OPENABLE);
  if ((await heads.count()) === 0) {
    // Empty is a legitimate answer, and the screen says so with something to do about it rather
    // than rendering a blank list.
    await expect(page.getByText("Nothing is published yet", { exact: true })).toBeVisible();
    expectNoErrors(errors);
    return;
  }

  // A domain opens with its resources when one read holds the whole estate, and folds when it does
  // not — so the starting state depends on the estate, and what is asserted is that the head toggles
  // and that open means resources on screen.
  const head = heads.first();
  await expect(head).toHaveAttribute("aria-expanded", /true|false/);
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`.domain-body ${CARD}`).first()).toBeVisible();

  const opened = await page.locator(".domain-body").count();
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".domain-body")).toHaveCount(opened - 1);

  const unused = page.locator(".catalog-unused-domains");
  if (await unused.count()) {
    await expect(unused.locator(".domain-head").first()).toBeHidden();
    await unused.locator("summary").click();
    await expect(unused.locator(".domain-head").first()).toBeVisible();
    await expect(unused.locator(".domain-head").first()).toBeDisabled();
  }

  expectNoErrors(errors);
});

test("search crosses the domains, and clearing it puts them back", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/catalog");

  const heads = page.locator(OPENABLE);
  test.skip((await heads.count()) === 0, "nothing is published on this estate");

  // Browsing is by domain; searching is across them, because somebody typing an operation id is
  // asking a question the taxonomy has no opinion about.
  await page.getByLabel(/^Search resources/).fill("zzzz-nothing-matches-this");
  await expect(page.getByText("Nothing matches that", { exact: true })).toBeVisible();
  await expect(page.locator(".domain-list")).toHaveCount(0);
  // The search is in the address, so a reload or a pasted link asks the same question.
  await expect(page).toHaveURL(/[?&]q=zzzz-nothing-matches-this\b/);

  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await expect(page.locator(".domain-list")).toBeVisible();
  await expect(page).toHaveURL(/\/catalog$/);

  expectNoErrors(errors);
});

test("a card opens the read-only listing, not the publisher's editor", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page, "/catalog");

  const heads = page.locator(OPENABLE);
  test.skip((await heads.count()) === 0, "nothing is published on this estate");
  if ((await heads.first().getAttribute("aria-expanded")) === "false") await heads.first().click();

  const card = page.locator(`.domain-body ${CARD}`).first();
  await expect(card).toBeVisible();
  const name = (await card.locator(".catalog-result-title strong").first().textContent())!.trim();
  await card.locator("a").first().click();

  // The resource's own name, once loaded, rather than one generic title for every listing.
  await expect(screenTitle(page)).toContainText(name);
  // The consumer's questions, in the order they are asked — and none of the publisher's controls,
  // which is the whole point of the catalogue opening a listing rather than a workspace.
  for (const tab of ["Overview", "Getting started", "Try it"]) {
    await expect(page.getByRole("tab", { name: tab, exact: true })).toBeVisible();
  }
  // And it arrived at the catalogue's own address rather than at the owning application's
  // workspace, which is the failure this consolidation was about.
  expect(new URL(page.url()).pathname).toMatch(/^\/catalog\//);
  // The tab is in the address, so a reload lands on it.
  await page.getByRole("tab", { name: "Getting started", exact: true }).click();
  await expect(page).toHaveURL(/[?&]tab=start\b/);

  const subscribe = page.getByRole("link", { name: "New subscription", exact: true }).first();
  test.skip((await subscribe.count()) === 0, "the first listing is not in any product");
  await subscribe.click();
  await expect(screenTitle(page)).toContainText("New subscription");
  await expect(page.getByText(/^Subscribing as /)).toBeVisible();
  await expect(page.getByRole("group", { name: "Environment" })).toBeVisible();
  await expect(page.getByLabel("What will you use it for?")).toBeVisible();
  await expect(page.getByText("Create an application", { exact: true })).toHaveCount(0);

  expectNoErrors(errors);
});
