import { test, expect } from "@playwright/test";
import { openPortal, watchErrors, expectNoErrors } from "./_helpers";

// Drafts and intercepted responses only; no changes reach the shared estate.
test("published URLs follow gateway selection and are absent from Identify", async ({ page }) => {
  const errors = watchErrors(page);
  await page.route("**/api/meta", async route => {
    const response = await route.fetch();
    const meta = await response.json();
    meta.environments[0].localities = [
      { name: "managed", addresses: [{ network: "internet", url: "https://managed.example.test" }] },
      { name: "onprem", addresses: [{ network: "intranet", url: "http://onprem.example.test" }] },
    ];
    await route.fulfill({ json: meta });
  });
  await openPortal(page, "/publish");
  await page.getByRole("textbox", { name: "API name", exact: true }).fill(`logic-qa-${Date.now()}`);
  await page.getByLabel("Domain", { exact: true }).selectOption("IT");
  await expect(page.getByText("Published path", { exact: true })).toBeVisible();
  await expect(page.locator(".publish-flow .url-list")).toHaveCount(0);
  await page.getByRole("button", { name: "Next: Define" }).click();
  await page.getByRole("radio", { name: "Import from URL" }).check();
  await page.getByLabel("Definition URL", { exact: true }).fill("https://example.test/openapi.json");
  await page.getByRole("button", { name: "Next: Route" }).click();
  await expect(page.getByLabel("DEV backend URL", { exact: true })).toBeVisible();
  const choices = page.locator(".publish-flow .pick-option input[type=checkbox]");
  const count = await choices.count();
  expect(count).toBe(2);
  await expect(page.locator(".publish-flow .url-list li").first()).toBeVisible();
  for (let index = 0; index < count; index++) await choices.nth(index).check();
  const allUrls = await page.locator(".publish-flow .url-list li").count();
  for (let index = 1; index < count; index++) await choices.nth(index).uncheck();
  await expect(choices.first()).toBeDisabled();
  expect(await page.locator(".publish-flow .url-list li").count()).toBeLessThan(allUrls);
  await expect(page.locator(".publish-flow .url-list li").first()).toBeVisible();
  expectNoErrors(errors);
});

test("copying policy requires a new preview after changing source", async ({ page }) => {
  await page.route("**/api/policy/global/copy-from?*", async route => {
    expect(route.request().postDataJSON().dryRun).toBe(true);
    await route.fulfill({ json: { changes: [{ unitKey: "timeoutMs", before: 1000, after: 2000 }] } });
  });
  await openPortal(page, "/policy");
  const card = page.locator("section.card").filter({ has: page.getByRole("heading", { name: "Copy from another environment", exact: true }) });
  const source = card.locator("select");
  test.skip(await source.locator("option").count() < 2, "two source environments required");
  await card.getByRole("button", { name: "Show what would change" }).click();
  await expect(card.getByRole("button", { name: "Apply 1 change", exact: true })).toBeVisible();
  await source.selectOption({ index: 1 });
  await expect(card.getByRole("button", { name: /^Apply/ })).toHaveCount(0);
});

test("gateway inheritance previews the parent and a separate switch preserves drafts", async ({ page }) => {
  const source = (value: number | boolean, scope: string | null) => ({ value, scope });
  await page.route("**/api/gateway-settings", async route => {
    if (route.request().method() === "PATCH") {
      expect(route.request().postDataJSON().values).toEqual({ accessLog: true });
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({ json: {
      defs: {
        maxConcurrentRequests: { label: "Concurrency", purpose: "Request ceiling", kind: "number", default: 10, min: 1, max: 100, env: "OLD_LIMIT" },
        accessLog: { label: "Access log", purpose: "Record requests", kind: "flag", default: true, sensitive: true, env: "OLD_LOG" },
      },
      scopes: ["fleet", "environment", "gateway"], environments: ["dev"],
      gateways: [{ id: "gw1", name: "managed", environment: "dev", label: null }],
      overrides: [{ scope: "gateway", scopeId: "gw1", key: "maxConcurrentRequests", value: 30, setBy: "qa", setAt: "2026-09-12T00:00:00Z" }],
      effective: {
        fleet: { maxConcurrentRequests: source(10, null), accessLog: source(false, "fleet") },
        environments: { dev: { maxConcurrentRequests: source(20, "environment"), accessLog: source(false, "fleet") } },
        gateways: { gw1: { maxConcurrentRequests: source(30, "gateway"), accessLog: source(false, "fleet") } },
      },
    } });
  });
  await openPortal(page, "/gateway-settings");
  await page.getByLabel("Applies to", { exact: true }).selectOption("gateway:gw1");
  const number = page.getByRole("spinbutton", { name: "Concurrency", exact: true });
  await expect(number).toHaveAttribute("placeholder", "inherit 20");
  await number.fill("40");
  await page.getByRole("button", { name: "Turn access log back on" }).click();
  await expect(number).toHaveValue("40");
  await expect(page.getByRole("button", { name: "Save 1 change", exact: true })).toBeEnabled();
});

test("changing environment closes a Kafka creation draft", async ({ page }) => {
  await openPortal(page, "/kafka");
  await page.getByRole("button", { name: "Create topic", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Topic name", exact: true }).fill("unsaved-topic");
  // The shell is outside the modal's focus trap; a programmatic click exercises its context update.
  const environments = page.locator('.native-page-head [aria-label="Environment"] button');
  test.skip(await environments.count() < 2, "multiple environments required");
  await environments.nth(1).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Create topic", exact: true }).first().click();
  await expect(page.getByRole("textbox", { name: "Topic name", exact: true })).toHaveValue("");
  await expect(page.getByRole("spinbutton", { name: /^Partitions/ })).toHaveValue("3");
});

test("approval review names its scope and excludes resolved access", async ({ page }) => {
  const events = [
    { id: "dev-pending", state: "pending", environment: "dev", name: "Dev product" },
    { id: "test-pending", state: "pending", environment: "test", name: "Test topic" },
    { id: "dev-cancelled", state: "cancelled", environment: "dev", name: "Cancelled product" },
  ];
  await page.route("**/api/integration-events?*", route => route.fulfill({ json: { items: events.map(entry => ({
    id: entry.id, integration: "skonet", kind: "subscription.request", state: "awaiting-decision",
    payload: { consumer: "consumer", purpose: "Process orders" }, approval: entry,
  })) } }));
  await openPortal(page, "/approvals");
  await page.locator('.native-page-head [aria-label="Environment"]').getByRole("button", { name: "DEV", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review request" })).toHaveCount(1);
  await expect(page.getByText("Test topic", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Review request" }).click();
  await expect(page.getByRole("dialog")).toContainText("Dev product · consumer · DEV");
});

test("a changed search cannot display results from the previous query", async ({ page }) => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/catalog?*", async route => {
    const query = new URL(route.request().url()).searchParams.get("q") ?? "";
    if (query === "second") await gate;
    await route.fulfill({ json: { total: 1, truncated: false, items: [{
      id: "qa", title: query === "second" ? "Second result" : "First result", apiVersion: "v1", kind: "rest", tags: [],
      environments: ["dev"], operationCount: 1, subscriberCount: 0, lifecycle: "active", domain: "IT",
    }] } });
  });
  await openPortal(page, "/catalog");
  const search = page.getByRole("textbox", { name: /^Search resources/ });
  await search.fill("first");
  await expect(page.getByText("First result", { exact: true })).toBeVisible();
  await search.fill("second");
  await expect(page.getByText("First result", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Searching…", { exact: true })).toBeVisible();
  release();
  await expect(page.getByText("Second result", { exact: true })).toBeVisible();
});
