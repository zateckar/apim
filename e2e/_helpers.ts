import { expect, type Page } from "@playwright/test";

/**
 * The two things every spec in this suite does, in one place.
 *
 * `watchErrors` is the guard that earns the suite its keep: a React tree that throws during a fetch
 * or a render leaves a page that *looks* like it is still loading, with no error anywhere near the
 * user. Nothing else this suite asserts would catch it, and a screenshot of an empty panel does not
 * tell you why. Every spec ends by asserting the list is empty.
 */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Chromium reports every failed subresource — a missing favicon, a 404 on an optional asset —
    // as a console error. Those are not what this guard is for, and including them made it fire on
    // every page in the portal while catching nothing. A request the portal *made* and could not
    // handle surfaces as a rendered error, which the specs assert on directly.
    if (message.text().startsWith("Failed to load resource")) return;
    errors.push(message.text());
  });
  return errors;
}

export function expectNoErrors(errors: string[]) {
  expect(errors, errors.join("\n")).toEqual([]);
}

/**
 * Open the portal on the first application the signed-in user has, and wait until the shell is up.
 *
 * The shell decides which application to show from `localStorage` and the address, so landing on
 * `/` and waiting for the sidebar is the honest way in — a spec that navigated straight to
 * `/<applicationId>/…` would be asserting against an id it invented rather than one the estate has.
 */
export async function openPortal(page: Page, path = "/"): Promise<string> {
  await page.goto(path);
  await expect(page.locator("aside.sidebar")).toBeVisible();
  const me = await (await page.request.get("/api/me")).json();
  const application = me.user?.applications?.[0];
  expect(application, "the signed-in user is in no application").toBeTruthy();
  return application as string;
}

/** Every screen in the shell has a title; this is where it is. */
export function screenTitle(page: Page) {
  return page.locator(".native-page-head h1");
}

/**
 * The signed-in user's application that actually publishes something, or `null`.
 *
 * Not `applications[0]`: membership order is alphabetical, and on the seeded estate the first
 * application a user is in is a consuming one that has published nothing — so a spec that took the
 * first would skip itself on a stack where there is plenty to look at.
 */
export async function applicationWithApis(page: Page): Promise<string | null> {
  const me = await (await page.request.get("/api/me")).json();
  const mine: string[] = me.user?.applications ?? [];
  const resources = await (await page.request.get("/api/resources")).json();
  const publishing = new Set<string>((resources.items ?? []).map((row: { applicationId: string }) => row.applicationId));
  return mine.find((application) => publishing.has(application)) ?? null;
}
