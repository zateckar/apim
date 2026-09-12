import { expect, test } from "@playwright/test";
import { applicationWithApis, expectNoErrors, openPortal, watchErrors } from "./_helpers";

/**
 * The API workspace — every tab, opened.
 *
 * This is the screen with the most behind it: a definition editor, a policy form, a playground, a
 * log search, a revision list. Each is lazily rendered, so a broken import or a fetch that throws
 * on one tab is invisible until somebody clicks it. Clicking all of them and asserting that nothing
 * threw is worth more here than any single assertion about what a tab contains.
 *
 * Read-only: nothing is saved.
 */

const TABS = [
  "definition",
  "properties",
  "policies",
  "subscriptions",
  "playground",
  "logs",
  "revisions",
  "history",
];

for (const width of [390, 1440]) test(`every tab of an API workspace renders at ${width}px`, async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page);
  await page.setViewportSize({ width, height: 900 });
  const application = await applicationWithApis(page);
  test.skip(application === null, "nothing this user's applications publish is on this estate");
  await page.goto(`/${application}/apis`);

  const rows = page.locator(".discover-item .di-name");
  await expect(rows.first()).toBeVisible();
  // On an application's own APIs the name opens the workspace; the read-only listing is what the
  // cross-application catalog offers instead, and that is asserted in `catalog.spec.ts`.
  await rows.first().click();
  await expect(page.getByRole("tab").first()).toBeVisible();

  for (const tab of TABS) {
    await page.getByRole("tab", { name: new RegExp(`^${tab}$`, "i") }).click();
    // Each panel is given a moment to do its own fetch; what is asserted is that the workspace is
    // still there afterwards rather than a blank frame where a thrown render used to be.
    await expect(page.getByRole("tab", { name: new RegExp(`^${tab}$`, "i") })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("main.native-content")).not.toBeEmpty();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    if (tab === "history") await expect(page.getByRole("heading", { name: "Deployment progress" })).toHaveCount(0);
  }

  expectNoErrors(errors);
});

test("the description is written as Markdown, and Preview renders it", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page);
  const application = await applicationWithApis(page);
  test.skip(application === null, "nothing this user's applications publish is on this estate");
  await page.goto(`/${application}/apis`);

  const rows = page.locator(".discover-item .di-name");
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await page.getByRole("tab", { name: /^properties$/i }).click();

  const editor = page.locator(".md-editor").first();
  await expect(editor).toBeVisible();

  const source = editor.locator("textarea");
  const before = await source.inputValue();
  // Type into the editor and render it. Nothing is saved — the Save button is never pressed — so
  // this leaves the estate exactly as it found it.
  await source.fill(`${before}\n\n## A heading from the smoke suite`);
  await editor.getByRole("button", { name: "Preview" }).click();
  await expect(editor.locator(".md-desc h2")).toHaveText("A heading from the smoke suite");

  expectNoErrors(errors);
});
