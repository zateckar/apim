import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Action,
  AttentionList,
  DangerZone,
  EmptyState,
  Stepper,
  StatusChip,
  Term,
} from "../src/components.tsx";
import { HowView } from "../src/views/HowView.tsx";
import { Publish } from "../src/portal/apis.tsx";
import { Granted } from "../src/views/SubscribeWizard.tsx";
import { ALLOWED, permit } from "../src/lib/capabilities.ts";
import { GLOSSARY, REQUIRED_TERMS } from "../src/lib/glossary.ts";
import { releaseChip } from "../src/lib/status.ts";
import type { AttentionRow } from "../../shared/attention.ts";
import type { MarketListingDetail, Meta } from "../src/api.ts";

/**
 * What the components promise, rendered.
 *
 * `renderToStaticMarkup` does not run effects, so what is asserted here is deliberately the part
 * that does not depend on a fetch: the affordances the plan's §9.4 rules are about. Anything that
 * needs a live control plane is asserted in `test/` against the real one instead — D30 rules out
 * pretending a browser was driven.
 *
 * The publish wizard reads `?kind=` in a lazy initialiser — that is how the shell's **Publish API**
 * button opens it on MCP or A2A — and a lazy initialiser *does* run under a static render, so the
 * one browser global it needs is stubbed rather than the screen changed to suit the test.
 */

Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { search: "" },
});

const meta: Meta = {
  environments: [{ environment: "dev", instances: 1, liveInstances: 1 }],
  chain: ["dev", "test", "prod"],
  kinds: ["rest", "soap", "mcp", "a2a"],
  policyUnits: [],
  authProviders: ["dev"],
  publicUrl: "http://localhost:8080",
  telemetryRetentionHours: 48,
};

const user = {
  id: "u1",
  name: "Alice Novak",
  roles: ["publisher"],
  applications: ["application_platform"],
  isAdmin: false,
};

const session = {
  user,
  meta,
  applications: [{ id: "application_platform", name: "Platform Application", mine: true }],
  application: "application_platform",
  setApplication: () => {},
  applicationName: (id: string) => (id === "application_platform" ? "Platform Application" : id),
  environment: "dev",
  setEnvironment: () => {},
  reload: () => {},
  me: { user, applications: [], mustChangePassword: false, claimsStale: false, unmappedGroups: [] },
};

/** React escapes text nodes, so a definition with an apostrophe in it is not a substring as authored. */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function row(over: Partial<AttentionRow> = {}): AttentionRow {
  return {
    code: "no-route",
    severity: "blocker",
    subject: { kind: "resource", id: "res_1", name: "petstore v1" },
    environment: "dev",
    detail: "petstore v1 has no route in DEV, so no request can reach it.",
    href: "/apis/res_1/routing",
    ...over,
  };
}

describe("the components keep their promises", () => {
  test("an empty state names the next action", () => {
    const html = renderToStaticMarkup(
      <EmptyState
        title="No subscriptions yet"
        detail="Subscribing is what gives an application a key."
        action={<a href="/catalog">Find an API →</a>}
      />,
    );
    expect(html).toContain("No subscriptions yet");
    // A dead end on a first visit is where people give up, so an empty state carries a control.
    expect(html).toMatch(/<a [^>]*href="\/catalog"/);
  });

  test("an action the caller cannot perform is disabled, with the reason visible", () => {
    const refused = permit("edit", ["read"], { application: "Orders" });
    const html = renderToStaticMarkup(
      <Action permission={refused} onClick={() => {}}>
        Change this
      </Action>,
    );
    expect(html).toContain("disabled");
    // Not only in the tooltip: a title attribute is invisible to a reader who is not hovering.
    expect(html).toContain("action-reason");
    expect(html).toContain("the Orders application");
    expect(renderToStaticMarkup(<Action permission={ALLOWED} onClick={() => {}}>Go</Action>)).not.toContain(
      "disabled",
    );
  });

  test("an attention row shows its severity, its sentence and the screen that fixes it", () => {
    const html = renderToStaticMarkup(
      <AttentionList rows={[row(), row({ code: "key-older-than-90-days", severity: "info" })]} truncated={3} />,
    );
    expect(html).toContain("Not working");
    expect(html).toContain("Worth knowing");
    expect(html).toContain("no route in DEV");
    expect(html).toContain('href="/apis/res_1/routing"');
    expect(html).toContain("Set a route");
    // Every list is bounded, and says so rather than silently ending.
    expect(html).toContain("3 more not shown");
  });

  test("an attention list with nothing in it renders nothing", () => {
    expect(renderToStaticMarkup(<AttentionList rows={[]} />)).toBe("");
  });

  test("a status chip carries the underlying state in its title", () => {
    const html = renderToStaticMarkup(<StatusChip chip={releaseChip("stale")} />);
    expect(html).toContain("Needs confirming");
    expect(html).toContain("tone-stop");
    expect(html).toContain("stale");
  });

  test("a term carries its definition", () => {
    const html = renderToStaticMarkup(<Term name="quota" />);
    expect(html).toContain("<abbr");
    expect(html).toContain(GLOSSARY.quota!.definition.slice(0, 30));
  });

  test("a term the glossary has never heard of renders its children rather than nothing", () => {
    expect(renderToStaticMarkup(<Term name="wormhole">wormholes</Term>)).toBe("wormholes");
  });

  test("a stepper says where you are, what is behind and what is ahead", () => {
    const html = renderToStaticMarkup(<Stepper steps={["One", "Two", "Three"]} current={1} />);
    expect(html).toContain('class="done"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('class="todo"');
  });

  test("nothing destructive without typing the name back", () => {
    const html = renderToStaticMarkup(
      <DangerZone
        what="Delete petstore"
        name="petstore"
        consequence="Every gateway stops serving it."
        permission={ALLOWED}
        onConfirm={() => {}}
      />,
    );
    // Folded shut, so the button is never what a mis-aimed click lands on.
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Type <strong>petstore</strong>");
    // Disabled until the typed name matches, which it cannot on the first render.
    expect(html).toContain("disabled");
  });
});

describe("the wizards", () => {
  test("publishing has three steps and refuses to start empty-handed", () => {
    const html = renderToStaticMarkup(<Publish session={session as never} />);
    for (const label of ["Identify", "Define", "Route and sell"]) {
      expect(html, label).toContain(label);
    }
    expect(html).toContain('class="stepper"');
    // A fresh form, nothing typed: the primary control is disabled rather than producing a 400.
    expect(html).toContain("Next: Define");
    expect(html).toMatch(/<button type="submit" class="btn primary" disabled=""/);
    // And the reason is a sentence on the screen rather than a title attribute on the dead button.
    expect(html).toContain("Still needed: A name");
    // Everything past the first step is out of reach until the step before it is answered, and it is
    // disabled rather than hidden — so the shape of what is being asked is visible from screen one.
    expect(html.match(/class="step [^"]*"[^>]*disabled=""/g) ?? []).toHaveLength(2);
  });

  /**
   * A new version used to be a wizard of its own at `/apis/:id/version`. It is a dialog on the API
   * workspace now (`NewVersion` in `portal/apis.tsx`), opened from the screen it copies — so what is
   * left to assert here is the identifier it prefills and the path it derives, which is what the two
   * versions serving at once actually depend on. Both are asserted in `portal.test.tsx`.
   */
});

/**
 * Publishing has no end *screen* to assert: it is one transaction, and the caller is returned to
 * the API's workspace where the deployment is visible. What the wizard promises before the button —
 * the address a consumer will call — is asserted above and in `test/publish.test.ts` against the
 * same derivation the control plane validates with.
 */
describe("what a journey ends with", () => {
  test("subscribing ends with the key, a call that works, and where to go", () => {
    const listing = {
      id: "res_1",
      title: "petstore",
      apiVersion: "v1",
      kind: "rest",
      summary: null,
      description: null,
      tags: [],
      icon: null,
      docsUrl: null,
      applicationId: "application_platform",
      lifecycle: "active",
      endpoints: [{ environment: "dev", host: "gw.dev.internal", basePath: "/petstore/v1", live: true }],
      products: [],
      operations: [],
      versions: [],
      subscriptions: [],
    } as unknown as MarketListingDetail;
    const html = renderToStaticMarkup(
      <Granted
        keyValue="k_live_abc123"
        subscriptionId="sub_1"
        listing={listing}
        environment="dev"
        resourceId="res_1"
      />,
    );
    expect(html).toContain("only time the key is shown");
    expect(html).toContain("k_live_abc123");
    // A curl that names the real host and the real header, not a placeholder to be filled in.
    expect(html).toContain("https://gw.dev.internal/petstore/v1");
    expect(html).toContain("X-Api-Key: k_live_abc123");
    expect(html).toContain('href="/apis/res_1/try"');
    expect(html).toContain('href="/subscriptions/sub_1"');
  });
});

describe("how this works", () => {
  const html = renderToStaticMarkup(<HowView />);

  test("carries all six journeys", () => {
    for (const journey of [
      "Publish an API",
      "Promote it to the next environment",
      "Publish a new version",
      "Subscribe to an API",
      "Call it from here",
      "Run the platform",
    ]) {
      expect(html, journey).toContain(journey);
    }
  });

  test("states the two-tier model in the first card", () => {
    // The sentence is broken up by <Term> markup, so match the parts between the tooltips.
    expect(html).toContain("travels. Everything else stays where it is put.");
    expect(html).toContain("the contract itself — is what moves from DEV to TEST to PROD");
    expect(html).toContain("a key that works in DEV will not work in PROD");
  });

  test("renders the whole glossary from the same table the tooltips read", () => {
    for (const key of REQUIRED_TERMS) {
      const entry = GLOSSARY[key]!;
      expect(html, key).toContain(escapeHtml(entry.definition));
      expect(html, key).toContain(`id="term-${key.replace(/\s+/g, "-")}"`);
    }
  });
});
