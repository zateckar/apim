import { Card, Link, Term } from "../components";
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
      "Import the definition — upload a file, give a URL, or point at an MCP server or A2A agent and let the portal read its card.",
      "Say where it answers: a host and a base path in this environment, and the backend it forwards to.",
      "Review, then release. The gateways pick it up at their next poll.",
    ],
    ends: "The API is live in DEV, with its address shown, and you can try it, add a policy, put it in a product, or promote it.",
    to: "/apis/new",
  },
  {
    title: "Promote it to the next environment",
    who: "It works in DEV and you want it in TEST, then PROD.",
    steps: [
      "Pick the revision and the environment to promote it into.",
      "Read the plan: what will be created, what is kept as it is, and anything that would block the promotion.",
      "Confirm. What is applied is exactly the plan you were shown.",
    ],
    ends: "That revision is live in the next environment. Its policies, route and backend there are that environment's own.",
    to: "/apis",
  },
  {
    title: "Publish a new version",
    who: "The contract has changed in a way that would break the callers you already have.",
    steps: [
      "Choose the new version identifier — v2 beside v1.",
      "Choose what to copy across: policies, routes, or nothing.",
      "Review. The old version keeps serving until you deprecate and retire it.",
    ],
    ends: "Two versions side by side, each with its own base path, subscribers and policies.",
    to: "/apis",
  },
  {
    title: "Subscribe to an API",
    who: "You want to call something somebody else publishes.",
    steps: [
      "Choose the application that will do the calling, or create one.",
      "Choose the environment. Keys are per environment, so a DEV key never works in PROD.",
      "Review the terms — the rate limit and quota you are agreeing to — and confirm.",
    ],
    ends: "The key, shown once, with a ready-made curl command and a link into the playground.",
    to: "/catalog",
  },
  {
    title: "Call it from here",
    who: "You want to see a real response before writing any code.",
    steps: [
      "Open the API, choose Try it, and pick an operation.",
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
      "Put them in a application. Membership is what lets somebody publish and change; it is not a label.",
      "A application can also be granted by an identity provider group, which the portal matches to it by name.",
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
      <Card
        title="The one thing worth knowing first"
        hint="Almost every surprise in this portal comes from getting this backwards."
      >
        <p>
          A <Term name="definition">definition</Term> travels. Everything else stays where it is put.
        </p>
        <p>
          When you <Term name="promote">promote</Term>, the <Term name="revision" /> — the contract
          itself — is what moves from DEV to TEST to PROD. Its{" "}
          <Term name="policy">policies</Term>, its <Term name="route" />, the{" "}
          <Term name="backend" /> it forwards to and every <Term name="subscription" /> to it belong
          to one <Term name="environment">environment</Term> and are edited there. That is why a
          promotion shows you a plan first: the things that do not travel are the things it has to
          create for you, and you should see the list before it happens.
        </p>
        <p className="muted">
          The practical consequence: a key that works in DEV will not work in PROD, and a rate limit
          you set in DEV is not the one PROD is running. Both are deliberate.
        </p>
      </Card>

      <Card
        title="The six things you can do here"
        hint="Each one is a guided flow that checks every step against the same rules the server would."
      >
        <div className="stack">
          {JOURNEYS.map((journey) => (
            <div key={journey.title} className="unit">
              <header>
                <h4>{journey.title}</h4>
                {journey.to && (
                  <Link to={journey.to} className="small">
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
      </Card>

      <Card
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
      </Card>
    </>
  );
}
