import { Panel, Link, Term } from "../components";
import { define, GLOSSARY, type GlossaryEntry } from "../lib/glossary";

/**
 * "How this works" (plan §9.5).
 *
 * One page rather than a tour: D30 rules out anything that claims to have watched a person use the
 * portal, and a page can be read in any order, linked to from an error message, and kept honest by
 * the same test that keeps the tooltips honest. The glossary at the bottom is rendered from
 * `glossary.ts` — the same table `<Term>` reads — so the page and the tooltips cannot drift.
 */

const JOURNEYS: Array<{ title: string; who: string; steps: string[]; ends: string; to?: string }> = [
  {
    title: "Publish an API",
    who: "You have a definition and you want other applications to be able to call it.",
    steps: [
      "Identify the API: choose its name, type, version and domain to preview its published path.",
      "Define its contract by uploading, pasting or importing a definition.",
      "Choose the backend and gateways in Route, review their URLs, then publish to the first environment.",
    ],
    ends: "The API is live in DEV, with its address shown, and in a product of its own that consumers can subscribe to. You can try it, add a policy, bundle it with other APIs, or promote it.",
    to: "/apis/new",
  },
  {
    title: "Promote it to the next environment",
    who: "It works in DEV and you want it in TEST, then PROD.",
    steps: [
      "Save changes in the source environment, then choose Promote to the next environment.",
      "Supply the target backend URL for its first promotion; existing target backend settings are retained unless you replace them.",
      "Promote, then follow deployment progress in Activity.",
    ],
    ends: "That revision is live in the next environment. Its policies, route and backend there are that environment's own.",
    to: "/apis",
  },
  {
    title: "Publish a new version",
    who: "The contract has changed in a way that would break the callers you already have.",
    steps: [
      "Choose the new version identifier — v2 beside v1.",
      "Review the new path and choose its product. The definition on screen, saved backends, gateways and policies are copied.",
      "Publish to the first environment. The old version keeps serving.",
    ],
    ends: "Two versions with separate paths. Versions in the same product share its subscriptions.",
    to: "/apis",
  },
  {
    title: "Subscribe to a resource",
    who: "You want to call something somebody else publishes.",
    steps: [
      "Catalog uses the application selected in the main menu for your subscription.",
      "Choose the environment. Keys are per environment, so a DEV key never works in PROD.",
      "Describe what you will use it for, check the product and limits if needed, and subscribe.",
    ],
    ends: "A pending or activating subscription. Open the subscription to reveal its key after access becomes active.",
    to: "/catalog",
  },
  {
    title: "Call it from here",
    who: "You want to see a real response before writing any code.",
    steps: [
      "Open the resource, choose Try it, and pick an operation.",
      "Choose the subscription to call with. The key is added by the portal and never reaches your browser.",
      "Send. The request goes through the gateway like any other call.",
    ],
    ends: "A response, and an entry in your own history you can send again or compare with another environment.",
    to: "/subscriptions",
  },
  {
    title: "Run the platform",
    who: "You are an administrator.",
    steps: [
      "Register the certificate authority that signed your internal backends, once per environment, so the gateways verify them instead of skipping the check.",
      "Attach a policy unit to a whole environment when every API in it should have the same control.",
      "Mint or revoke a gateway instance, and read what each one is running.",
    ],
    ends: "The change, and what it will do at the next poll of every gateway in that environment.",
    to: "/trust",
  },
  {
    title: "Let somebody in",
    who: "You are an administrator and a new colleague needs access.",
    steps: [
      "If they sign in through the identity provider, they get an account here the first time they arrive — you do not create one.",
      "Put them in an application. Membership is what lets somebody publish and change; it is not a label.",
      "An application can also be granted by an identity provider group, which the portal matches to it by name.",
    ],
    ends: "They can act on that application's APIs at their very next request — nobody has to sign out and back in.",
    to: "/users",
  },
];

const GROUP_LABEL: Record<GlossaryEntry["group"], string> = {
  publishing: "Publishing",
  consuming: "Consuming",
  policy: "Policy",
  operating: "Operating",
  identity: "Who you are",
};

export function HowView() {
  return (
    <>
      <Panel
        title="The one thing worth knowing first"
        hint="Almost every surprise in this portal comes from getting this backwards."
      >
        <p>
          Publishing and promotion deploy an API. Subscriptions grant an application access to a product in one environment.
        </p>
        <p>
          When you <Term name="promote">promote</Term>, the saved API configuration is used to deploy
          into the next <Term name="environment">environment</Term>. Review the target backend
          carefully: it is required for the first promotion, and existing target backend settings
          are retained unless replaced. Follow Activity to see when deployment finishes.
        </p>
        <p className="muted">
          The practical consequence: a key that works in DEV will not work in PROD, and a rate limit
          configured in DEV does not prove what PROD is running. Check the target environment's settings.
        </p>
      </Panel>

      <Panel
        title={`${JOURNEYS.length} things you can do here`}
        hint="Each one is a guided flow that checks every step against the same rules the server would."
      >
        <div className="journey-grid">
          {JOURNEYS.map((journey, index) => (
            <div key={journey.title} className="unit journey">
              <header>
                <h4><span className="journey-number">{index + 1}</span>{journey.title}</h4>
                {journey.to && (
                  <Link to={journey.to} className="btn sm">
                    Start →
                  </Link>
                )}
              </header>
              <p className="desc">{journey.who}</p>
              <ol className="small" style={{ margin: "0 0 8px", paddingLeft: 20, lineHeight: 1.6 }}>
                {journey.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <p className="small muted" style={{ margin: 0 }}>
                <strong>Ends with:</strong> {journey.ends}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Every word this portal uses"
        hint="The same definitions the tooltips show — hover any underlined word anywhere in the portal."
      >
        {(Object.keys(GROUP_LABEL) as Array<GlossaryEntry["group"]>).map((group) => {
          const entries = Object.entries(GLOSSARY)
            .filter(([, entry]) => entry.group === group)
            .sort(([a], [b]) => a.localeCompare(b));
          return (
            <div key={group} style={{ marginBottom: 18 }}>
              <h4 style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--muted)" }}>
                {GROUP_LABEL[group]}
              </h4>
              <dl className="glossary">
                {entries.map(([key, entry]) => (
                  <div key={key} style={{ display: "contents" }}>
                    <dt id={`term-${key.replace(/\s+/g, "-")}`}>{entry.term}</dt>
                    <dd>
                      {entry.definition}
                      {entry.see && entry.see.length > 0 && (
                        <span className="muted small">
                          {" "}
                          See also: {entry.see.map((other) => define(other)?.term ?? other).join(", ")}.
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </Panel>
    </>
  );
}
