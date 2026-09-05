import { defineConfig, devices } from "@playwright/test";

/**
 * The smoke suite, run against a **running stack**.
 *
 * There is deliberately no `webServer` block. `scripts/stack.ps1 -Up` already brings up the control
 * plane, the gateways and the local upstreams together, and a second definition of "the estate"
 * inside this file would be one more thing to keep in step with `docker-compose.<plane>.yml`. So
 * the contract is the one `CLAUDE.md` states: bring the stack up, then run this.
 *
 * These specs are **read-only**. They sign in, navigate, and assert what is on the screen — nothing
 * here publishes, promotes, subscribes or deletes. The reason is that the stack they run against is
 * usually shared, and a smoke suite that mutates a shared estate is a suite people stop running.
 * Behaviour that needs to change something is asserted in `test/`, against a control plane the test
 * owns outright.
 *
 * Sign-in happens once, in `e2e/global-setup.ts`, and every spec starts from the saved session.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./e2e",
  outputDir: ".data/playwright",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // The stack is shared, and the specs do not mutate it, so they may all run at once.
  fullyParallel: true,
  // A smoke test that passes on the second attempt has told you something is slow, not that it
  // works. Locally that is worth knowing immediately; on CI one retry absorbs a cold start.
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["list"], ["html", { open: "never", outputFolder: ".data/playwright-report" }]] : [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    storageState: ".data/playwright-session.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: isCI ? "off" : "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
