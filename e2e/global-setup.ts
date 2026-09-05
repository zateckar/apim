import { chromium, request, type FullConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Sign in once, and hand every spec the session.
 *
 * Which method is used is asked of the estate rather than assumed: `GET /api/auth/providers` says
 * what is enabled, and a local stack (`AUTH_PROVIDERS=dev`) and a deployment behind a password
 * (`local`) are both ordinary things to point this suite at. OIDC is not automated — a redirect to
 * somebody's identity provider is not something a smoke suite should be teaching itself to drive —
 * so pointing at an OIDC-only estate fails here with the reason rather than in every spec with a
 * screenshot of a sign-in page.
 *
 * Failing in setup is deliberate: twelve specs each reporting "expected the sidebar, got the
 * sign-in screen" hides the one fact that matters, which is that nothing is running on `baseURL`.
 */

const STATE = ".data/playwright-session.json";

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL ?? "http://localhost:8080";
  const user = process.env.E2E_USER ?? "alice";
  const password = process.env.E2E_PASSWORD;

  const api = await request.newContext({ baseURL });
  let providers: string[];
  try {
    const response = await api.get("/api/auth/providers");
    if (!response.ok()) throw new Error(`${response.status()} ${response.statusText()}`);
    providers = (await response.json()).providers ?? [];
  } catch (err) {
    throw new Error(
      `Nothing answered at ${baseURL}. The smoke suite runs against a running stack: ` +
        `\`pwsh -File scripts/stack.ps1 -Up\`, or set E2E_BASE_URL. (${String(err)})`,
    );
  }

  if (providers.includes("dev")) {
    const response = await api.post("/api/auth/dev-login", { data: { userId: user } });
    if (!response.ok()) {
      throw new Error(`dev sign-in as "${user}" failed: ${response.status()} ${await response.text()}`);
    }
  } else if (providers.includes("local")) {
    if (!password) {
      throw new Error(
        `${baseURL} signs in with a username and password. Set E2E_USER and E2E_PASSWORD.`,
      );
    }
    const response = await api.post("/api/auth/login", { data: { username: user, password } });
    if (!response.ok()) {
      throw new Error(`sign-in as "${user}" failed: ${response.status()} ${await response.text()}`);
    }
  } else {
    throw new Error(
      `${baseURL} only offers ${providers.join(", ") || "no"} sign-in. The smoke suite needs ` +
        "`dev` or `local`; it does not drive an identity provider's redirect.",
    );
  }

  mkdirSync(".data", { recursive: true });
  await api.storageState({ path: STATE });
  await api.dispose();

  // The session cookie is set for the origin, and Playwright's request context stores it in the
  // same format a browser context reads — so one round trip here is worth twelve sign-ins later.
  // Opening a browser once proves the state is usable before any spec depends on it.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL, storageState: STATE });
  const page = await context.newPage();
  await page.goto("/");
  const me = await page.request.get("/api/me");
  const body = await me.json();
  await browser.close();
  if (!body.user) {
    throw new Error(`signed in as "${user}", but the browser session is anonymous — check PUBLIC_URL on the control plane`);
  }
}
