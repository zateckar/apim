import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { accountChips, certificateExpiryChip } from "../src/lib/status.ts";
import { trafficDrillHref } from "../src/portal/dashboard.tsx";
import { ApplicationPicker } from "../src/portal/components/ApplicationPicker.tsx";
import { AccountView } from "../src/views/AccountView.tsx";
import { CredentialsView } from "../src/views/CredentialsView.tsx";
import { RemoveMembership } from "../src/views/UsersView.tsx";
import type { Session } from "../src/App.tsx";
import type { Me, User } from "../src/api.ts";

/**
 * The identity screens' decisions from the per-screen consistency pass: account, credentials,
 * applications and people, the dashboard's drill-down and the application picker.
 *
 * `renderToStaticMarkup` runs no effects, so a rendered screen here is its first frame — before any
 * request has answered — which is exactly the frame the loading-versus-empty rules are about.
 */

const member: User = {
  id: "usr_1",
  name: "Clara Consumer",
  roles: ["member"],
  applications: ["application_orders"],
  isAdmin: false,
  provider: "local",
  username: "clara",
  email: null,
  adminFrom: null,
};

describe("a certificate's remaining validity", () => {
  test("an expired one is a stop, not one more row", () => {
    // It was a `row-bad` class whose only rule was for table rows, on a list that is not a table.
    const chip = certificateExpiryChip({ expired: true, expiresInDays: 0, notAfter: "2026-01-01T00:00:00Z" });
    expect(chip.tone).toBe("stop");
    expect(chip.label).toBe("Expired");
  });

  test("within thirty days it warns and says how many are left; after that it is simply valid", () => {
    expect(certificateExpiryChip({ expired: false, expiresInDays: 12, notAfter: "2026-10-05T00:00:00Z" })).toMatchObject({ tone: "warn", label: "12 days left" });
    expect(certificateExpiryChip({ expired: false, expiresInDays: 1, notAfter: "2026-10-05T00:00:00Z" }).label).toBe("1 day left");
    expect(certificateExpiryChip({ expired: false, expiresInDays: 200, notAfter: "2027-04-01T00:00:00Z" }).tone).toBe("live");
  });
});

describe("what stands between an account and signing in", () => {
  test("is nothing at all for an account that can sign in", () => {
    expect(accountChips({ disabled: false, lockedUntil: null, mustChangePassword: false })).toEqual([]);
  });

  test("is worst first, in the tone vocabulary", () => {
    const chips = accountChips({ disabled: true, lockedUntil: "2026-09-23T10:00:00Z", mustChangePassword: true });
    expect(chips.map((chip) => chip.label)).toEqual(["Disabled", "Locked", "Must change password"]);
    expect(chips[0]!.tone).toBe("stop");
  });
});

describe("the dashboard's traffic drill-down", () => {
  test("opens the Logs panel for the window the dashboard is showing", () => {
    // It carried the tab and dropped the window (dashboard-health, "Make traffic drillable").
    const href = trafficDrillHref("orders", "res_1", 360);
    expect(href).toBe("/orders/apis/res_1?tab=logs&sinceMin=360");
  });
});

describe("the application picker with nothing to pick", () => {
  test("says so and points at the account page, instead of a disabled button", () => {
    const html = renderToStaticMarkup(<ApplicationPicker applications={[]} value="" onChange={() => {}} />);
    expect(html).toContain("You are not in an application yet");
    expect(html).toMatch(/<a [^>]*href="\/account"/);
    expect(html).not.toContain("disabled");
  });
});

describe("your own sessions", () => {
  test("are a skeleton until they arrive, not an empty table", () => {
    const me: Me = { user: member, applications: [], mustChangePassword: false, claimsStale: false, unmappedGroups: [] };
    const html = renderToStaticMarkup(<AccountView me={me} reload={() => {}} />);
    expect(html).toContain("Where you are signed in");
    expect(html).toContain("skeleton");
    expect(html).not.toContain("<th>Browser</th>");
  });
});

describe("the credentials screen", () => {
  const session = {
    user: member,
    application: "application_orders",
    environment: "dev",
  } as unknown as Session;
  const html = renderToStaticMarkup(<CredentialsView session={session} />);

  test("has one primary action", () => {
    expect(html.match(/btn primary/g) ?? []).toHaveLength(1);
  });

  test("says where issuers and token endpoints are in one sentence, not a paragraph", () => {
    expect(html).toContain("an administrator registers them");
    expect(html).not.toContain("are not oversights");
  });

  test("labels the environment the way every other screen does", () => {
    expect(html).toContain("in DEV");
  });
});

describe("removing somebody from an application", () => {
  const render = (fromIdp: boolean) =>
    renderToStaticMarkup(
      <RemoveMembership
        userId="usr_1"
        userName="Clara Consumer"
        applicationId="orders"
        applicationName="Orders"
        fromIdp={fromIdp}
        close={() => {}}
        onRemoved={() => {}}
      />,
    );

  test("names both sides and the consequence, and asks once without a typed name", () => {
    // platform-administration: not a typed confirmation, because Add grants it straight back.
    const html = render(false);
    expect(html).toContain("Remove Clara Consumer from Orders?");
    expect(html).toContain("can no longer publish or change what Orders owns");
    expect(html).not.toContain("to confirm");
  });

  test("warns, before the click, that a group membership comes back", () => {
    expect(render(true)).toContain("returns at their next claim refresh");
    expect(render(false)).not.toContain("returns at their next claim refresh");
  });
});
