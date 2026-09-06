import type { ReactNode } from "react";
import type { Session } from "./App";
import { Card, Link, OperationList, Panel } from "./components";
import type { Match } from "./lib/routes";
import { Publish, Editor } from "./portal/apis";
import { Catalog } from "./portal/catalog";
import { Dashboard } from "./portal/dashboard";
import { Subscriptions, Approvals, Integrations, Kafka } from "./portal/processes";
import { Mailbox } from "./portal/notifications";
import { AccountView } from "./views/AccountView";
import { ApplicationsView, ApplicationView } from "./views/ApplicationsView";
import { AuditView } from "./views/AuditView";
import { GatewayAdminView } from "./views/GatewayAdminView";
import { GatewayView } from "./views/GatewayView";
import { GlobalPolicyView } from "./views/GlobalPolicyView";
import { HealthView } from "./views/HealthView";
import { HowView } from "./views/HowView";
import { MarketListing } from "./views/MarketListing";
import { MarketView } from "./views/MarketView";
import { ProductsView } from "./views/ProductsView";
import { SubscribeWizard } from "./views/SubscribeWizard";
import { SubscriptionView } from "./views/SubscriptionView";
import { TelemetryView } from "./views/TelemetryView";
import { TrustView } from "./views/TrustView";
import { UsersView, UserView } from "./views/UsersView";

/**
 * Which component answers which route id — the other half of `lib/routes.ts`, and the only place a
 * screen is chosen.
 *
 * This replaced two things that had to agree and did not: a `switch` here in `App.tsx` over the
 * route table, and a ternary ladder in the shell over its own list of sections. A screen existed in
 * both, in one, or in neither, and the difference was invisible until somebody followed a link. A
 * record keyed by route id cannot drift that way — `screens.test.ts` asserts it covers the table
 * exactly, so a new route without a screen and a screen without a route both fail the build.
 *
 * Every entry is one expression. Anything longer than that belongs in the component, not here.
 */

export interface ScreenContext {
  match: Match;
  /** The session, with `application` already resolved to the one the address named. */
  session: Session;
  /** Operations for the selected application, polled once by the shell and shared. */
  operations: any[];
  /** The shell's clock. A screen that has to re-read after somebody's action depends on it. */
  tick: number;
}

export const SCREENS: Record<string, (context: ScreenContext) => ReactNode> = {
  // ------------------------------------------------------------------ the selected application
  dashboard: ({ session, operations, tick }) => (
    <Dashboard session={session} operations={operations} tick={tick} />
  ),
  apis: ({ session, tick }) => <Catalog session={session} section="apis" tick={tick} />,
  mcp: ({ session, tick }) => <Catalog session={session} section="mcp" tick={tick} />,
  a2a: ({ session, tick }) => <Catalog session={session} section="a2a" tick={tick} />,
  api: ({ match, session, operations, tick }) => (
    <Editor
      // Remounted per API and per environment: everything on the workspace is per environment, and
      // a form that kept its state across the switch would show one environment's values under the
      // other one's heading.
      key={`${match.params.resourceId}:${session.environment}`}
      id={match.params.resourceId!}
      tab={match.params.tab}
      session={session}
      operations={operations}
      tick={tick}
    />
  ),
  publish: ({ session }) => <Publish session={session} />,
  products: ({ session }) => <ProductsView key={session.application} session={session} />,
  subscriptions: ({ session, tick }) => <Subscriptions session={session} tick={tick} />,
  subscription: ({ match }) => <SubscriptionView subscriptionId={match.params.subscriptionId!} />,
  approvals: ({ session, tick }) => <Approvals session={session} tick={tick} />,
  kafka: ({ session, tick }) => <Kafka session={session} tick={tick} proxyOnly={false} />,
  "kafka-proxy": ({ session, tick }) => <Kafka session={session} tick={tick} proxyOnly={true} />,
  certificates: ({ session }) => (
    <TrustView
      key={session.application}
      applicationId={session.application}
      meta={session.meta}
      user={session.user}
      environment={session.environment}
    />
  ),
  integrations: ({ session, tick }) => <Integrations session={session} tick={tick} fixme={false} />,
  mail: ({ session, tick }) => <Mailbox session={session} tick={tick} />,
  activity: ({ operations }) => (
    <Panel title="Changes and deployment progress">
      <OperationList items={operations} />
    </Panel>
  ),

  // ------------------------------------------------------------------ the same for everybody
  catalog: ({ session }) => <MarketView user={session.user} meta={session.meta} />,
  listing: ({ match, session }) => (
    <MarketListing
      resourceId={match.params.resourceId!}
      user={session.user}
      meta={session.meta}
    />
  ),
  subscribe: ({ match, session }) => (
    <SubscribeWizard resourceId={match.params.resourceId!} session={session} />
  ),
  fixme: ({ session, tick }) => <Integrations session={session} tick={tick} fixme={true} />,
  how: () => <HowView />,
  account: ({ session }) => <AccountView me={session.me} reload={session.reload} />,

  // ------------------------------------------------------------------ running the estate
  fleet: ({ session }) => (
    <>
      {/* Open to everybody: which environment is healthy decides whether a publisher promotes this
          afternoon, and a screen only admins could read made them ask in chat. The convergence
          detail below it is the part that stays gated. */}
      <HealthView user={session.user} />
      {session.user.isAdmin && <GatewayView user={session.user} meta={session.meta} />}
    </>
  ),
  gateways: ({ session }) =>
    session.user.isAdmin ? (
      <GatewayAdminView />
    ) : (
      <Panel title="Gateways">
        <p>
          Adding a gateway, publishing its hostname and minting a replica's token are administrator
          actions. What each gateway is currently serving is on Health Status, which is open to
          everybody.
        </p>
      </Panel>
    ),
  applications: ({ session }) => (
    <ApplicationsView user={session.user} unmappedGroups={session.me.unmappedGroups ?? []} />
  ),
  application: ({ match, session }) => (
    <ApplicationView applicationId={match.params.applicationId!} user={session.user} />
  ),
  users: ({ session }) => (
    <UsersView user={session.user} canCreate={session.meta.authProviders.includes("local")} />
  ),
  user: ({ match, session }) => <UserView userId={match.params.userId!} me={session.user} />,
  telemetry: ({ session }) => <TelemetryView meta={session.meta} />,
  "global-policy": ({ session }) => (
    <GlobalPolicyView
      meta={session.meta}
      user={session.user}
      environment={session.environment}
      onEnvironment={session.setEnvironment}
    />
  ),
  trust: ({ session }) => (
    <TrustView meta={session.meta} user={session.user} environment={session.environment} />
  ),
  audit: () => <AuditView />,

  // ------------------------------------------------------------------ and the address that is not
  "not-found": () => (
    <Card>
      <p className="muted">
        Nothing in the portal answers to that address. <Link to="/">Go back to the dashboard</Link>,
        or read <Link to="/how">How this works</Link>.
      </p>
    </Card>
  ),
};

/** The screen for a match, or the not-found card. Never null: an address always renders something. */
export function screenFor(context: ScreenContext): ReactNode {
  return (SCREENS[context.match.route.id] ?? SCREENS["not-found"]!)(context);
}
