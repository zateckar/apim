import { test, expect } from "@playwright/test";
import { openPortal } from "./_helpers";

// Draft-only checks: no publish, create, save or request is submitted to the estate.
test("publishing checks existing names and version syntax before advancing", async ({ page }) => {
  await openPortal(page, "/publish");
  const resources = (await (await page.request.get("/api/resources")).json()).items;
  const existing = resources[0];
  test.skip(!existing, "no resource to check for a duplicate");
  await page.goto(`/${existing.applicationId}/publish`);
  const name = page.getByRole("textbox", { name: "API name", exact: true });
  await name.fill(existing.name);
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("link", { name: `Open ${existing.name} workspace →` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next: Define" })).toBeDisabled();
  await name.fill(`draft-qa-${Date.now()}`);
  const version = page.getByRole("textbox", { name: "Version", exact: true });
  await version.fill("XXX");
  await expect(version).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Domain", { exact: true }).selectOption({ index: 1 });
  await expect(page.getByRole("button", { name: "Next: Define" })).toBeDisabled();
  await version.fill("v2");
  await expect(page.getByRole("button", { name: "Next: Define" })).toBeEnabled();
  await expect(page.getByRole("radio", { name: "REST", exact: true })).toBeChecked();
  await expect(page.getByRole("radio", { name: "SOAP", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /MCP|A2A/ })).toHaveCount(0);
});

test("taxonomy makes prerequisites clear and resets a dependent choice", async ({ page }) => {
  await openPortal(page, "/publish");
  const domain = page.getByLabel("Domain", { exact: true });
  const subdomain = page.getByLabel("Sub-domain (optional)", { exact: true });
  await expect(subdomain).toBeDisabled();
  await domain.selectOption("Aftersales");
  await subdomain.selectOption({ index: 1 });
  await domain.selectOption("IT");
  await expect(subdomain).toHaveValue("");
  await expect(page.getByText("Options belong to IT. Changing the domain clears this choice.")).toBeVisible();
});

for (const kind of ["mcp", "a2a"]) test(`${kind} publishing keeps its type fixed`, async ({ page }) => {
  await openPortal(page, `/publish?kind=${kind}`);
  await expect(page.getByRole("textbox", { name: kind === "mcp" ? "MCP server name" : "A2A agent name", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /REST|SOAP/ })).toHaveCount(0);
});

test("product name format and numeric overrides block invalid saves", async ({ page }) => {
  await openPortal(page, "/products");
  await page.getByRole("button", { name: "+ Create a product", exact: true }).click();
  await page.locator("#new-product-name").fill("Wrong Name");
  await expect(page.locator("#new-product-name")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "Create product", exact: true })).toBeDisabled();
  await page.goto("/gateway-settings");
  const number = page.locator('main input[type="number"]').first();
  await number.fill("-1");
  await expect(number).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: /^Save .*change/ })).toBeDisabled();
});
