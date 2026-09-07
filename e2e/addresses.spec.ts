import { expect, test } from "@playwright/test";
import { expectNoErrors, openPortal, screenTitle, watchErrors } from "./_helpers";

/**
 * The addresses that are written somewhere other than the sidebar.
 *
 * A link in a screen, a route in the table and a shell that resolves the address are three separate
 * facts. When the third one disagrees the first two still look right: the link is there, the route
 * exists, and the reader lands on a list with their id quietly dropped — which reads as "there is
 * nothing here" rather than as a broken link. Only a browser catches that, and only by naming the
 * screen it expected to arrive at.
 *
 * Read-only, like the rest of the suite: both addresses are opened and asserted, and nothing is
 * saved, requested or withdrawn.
 */

test("the route table's address for the publish wizard opens the wizard", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page);

  // What "Publish an API" on How this works links to. The shell's own address is `/:app/publish`;
  // this is the older one, and it used to land on the API list.
  await page.goto("/apis/new");

  await expect(screenTitle(page)).toHaveText("Publish an API");
  // The wizard itself, not merely a titled page: three steps, with everything past the first out of
  // reach until it is answered. Nothing is typed and nothing is submitted.
  const steps = page.locator(".stepper .step");
  await expect(steps).toHaveText(["1Identify", "2Define", "3Route"]);
  await expect(steps.nth(1)).toBeDisabled();

  expectNoErrors(errors);
});

test("one subscription's address opens that subscription, not the list", async ({ page }) => {
  const errors = watchErrors(page);
  await openPortal(page);

  // Read the estate rather than invent an id: a spec that made one up would assert against a 404.
  const subscriptions = await (await page.request.get("/api/subscriptions")).json();
  const subscription = (subscriptions.items ?? [])[0];
  test.skip(!subscription, "the estate has no subscription to open");

  // What "Withdraw it →" on Products and "Manage this subscription" after subscribing both link to.
  await page.goto(`/subscriptions/${subscription.id}`);

  // The singular title is the whole point: "Subscriptions" here would mean the id was dropped and
  // the reader is looking at the list of everything instead of the one thing they asked for.
  await expect(screenTitle(page)).toHaveText("Subscription");
  await expect(page.locator("main.native-content")).not.toBeEmpty();

  expectNoErrors(errors);
});
