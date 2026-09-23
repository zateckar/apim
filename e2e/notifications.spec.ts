import { expect, test } from "@playwright/test";
import { expectNoErrors, openPortal, screenTitle, watchErrors } from "./_helpers";

/**
 * The bell and the mailbox.
 *
 * The one property here that only a browser can check is that "read" survives a reload: it lives in
 * `localStorage` rather than on the control plane, so a unit test can assert the hook's arithmetic
 * but not that the entry is actually written, keyed the way both surfaces read it, and still there
 * on the next page load. That is exactly the kind of thing that works in a test and not in a tab.
 */

test("the bell opens, and marking everything read survives a reload", async ({ page }) => {
  const errors = watchErrors(page);
  const application = await openPortal(page);

  // Start from a browser that has read nothing, whatever a previous run left behind.
  await page.evaluate(() => localStorage.removeItem("portal-notifications-read"));
  await page.reload();

  const bell = page.getByRole("button", { name: /^Notifications/ });
  await expect(bell).toBeVisible();
  await bell.click();

  const popover = page.getByRole("dialog", { name: "Notifications" });
  await expect(popover).toBeVisible();

  const items = popover.locator(".notif-item");
  const count = await items.count();
  if (count === 0) {
    // Nothing has happened to this application yet, which the popover says rather than showing an
    // empty box — and there is nothing to mark read.
    await expect(popover.locator(".empty")).toBeVisible();
    expectNoErrors(errors);
    return;
  }

  // Unread until read: the badge counts, and the rows are marked.
  await expect(bell).toHaveAccessibleName(/\d+ unread/);
  expect(await popover.locator(".notif-item.is-unread").count()).toBeGreaterThan(0);

  await popover.getByRole("button", { name: "Mark all read" }).click();
  await expect(popover.locator(".notif-item.is-unread")).toHaveCount(0);
  await expect(bell).toHaveAccessibleName("Notifications");

  await page.reload();
  await expect(page.getByRole("button", { name: /^Notifications/ })).toHaveAccessibleName(
    "Notifications",
  );

  // …and the mailbox, which reads the same state, agrees rather than showing them unread again.
  const loaded = page.waitForResponse(response => response.url().includes("/api/notifications?") && response.ok());
  await page.goto(`/${application}/mail`);
  await (await loaded).json();
  await expect(screenTitle(page)).toHaveText("Mail");
  await expect(page.locator(".notif-item.is-unread")).toHaveCount(0);

  expectNoErrors(errors);
});

test("the mailbox opens a message with its addressee", async ({ page }) => {
  const errors = watchErrors(page);
  const application = await openPortal(page, "/");
  const loaded = page.waitForResponse(response => response.url().includes("/api/notifications?") && response.ok());
  await page.goto(`/${application}/mail`);
  const feed = await (await loaded).json();

  const items = page.locator(".notif-item");
  test.skip(feed.items.length === 0, "no mail for this application yet");

  await items.first().click();
  const message = page.locator(".notif-message").first();
  await expect(message).toBeVisible();
  await expect(message.getByText("To", { exact: true })).toBeVisible();
  // The outbox kind is not shown: the subject line already says what the message is about.
  await expect(message.getByText("About", { exact: true })).toHaveCount(0);

  // The transport is simulated in this phase, and the screen says so rather than implying that
  // somebody's inbox has this message in it.
  await expect(page.getByText(/simulated/i).first()).toBeVisible();

  expectNoErrors(errors);
});
