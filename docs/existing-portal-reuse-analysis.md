# Existing portal reuse and native redesign

Updated 2026-09-05. This document supersedes the earlier compatibility-layer proposal and follows the application ownership, integration mocking and simple publishing requirements supplied by the user.

## Agreed direction

Reuse the old portal's visual system and useful interaction components. Adapt them to the new native model and APIs; build the remaining parts afresh. Change the control-plane wherever its current model prevents the desired experience.

There will be no legacy API facade, Azure DTO translation, team-to-application aliases, hidden compatibility products, or parallel old/new domain models. External integration interfaces are native service boundaries with mock implementations for now, not an old-portal compatibility layer.

Preserve the familiar application picker, navigation, catalog, API editors, environment controls, styling and feedback. Necessary product selection and approval status should fit that design. Reuse does not mean preserving Azure-specific implementation details or every old field.

## One ownership concept: Application

An application publishes and consumes. An OIDC-authenticated developer can act on behalf of applications for which they have rights. Remove Teams from the target domain, APIs, authorization, administration screens and vocabulary.

| Native object | Ownership and meaning |
|---|---|
| Application | The publishing and consuming identity, with its developer memberships and business metadata. |
| Application membership | User, application, granted capabilities and identity source; OIDC-derived rights remain authoritative. |
| API/resource | Owned by one application, with native protocol kind and environment-specific configuration. |
| Product | Owned by one application; explicitly groups that application's APIs for subscription. |
| Subscription | A consumer application's access to a publisher's product in an environment, including purpose, approval and provisioning status. |
| Certificate / Kafka topic / related resource | Owned by an application. Environment-specific material stays scoped to its environment. |
| Operation / audit event | Records the human actor and the application on whose behalf they acted. |

Platform-wide infrastructure such as fleet instances and global trust settings remains platform administration, not a second user ownership hierarchy.

Authorization must verify application membership and the required action on every server request. Selecting an application in the browser is context, not proof of authority. OIDC refresh/revocation must update effective rights without relying on a stale application picker. Any local administrative access stays explicitly separate from OIDC application membership.

Every API must belong to a product before it can be subscribed to. The publish form should offer an existing owned product or inline product creation, so the ordinary publishing flow satisfies this rule. Products are first-class and visible, not generated compatibility objects. An API may belong to multiple products if needed; each product can contain only its owner's APIs. This ownership constraint is a proposed default for the native design.

Users may subscribe on behalf of an application to its own products or another application's products. The relationship is consumer application -> subscription -> publisher product -> APIs. Catalog discovery may show APIs, but Subscribe selects a product that contains the API and clearly states the access being requested. Expanding a product changes its subscribers' entitlement; membership changes must be authorized, audited and reconciled.

Do not move APIs between application owners merely by updating a display field: ownership transfer affects products, subscriptions, certificates and authorization and needs a deliberate native command if offered.

## Subscription and approval workflow is real

Mock the SkoNET transport, not the subscription lifecycle. Persist requests, decisions, delivery attempts and resulting access in the control-plane.

Proposed default consistent with the old experience: subscriptions to an application's own products are automatically approved; subscriptions to another application's products require publisher approval. Record automatic decisions as well as human ones. Model this as an explicit approval rule so changing that default does not require rebuilding the workflow.

1. The developer selects the acting application, product, environment and purpose.
2. The control-plane verifies rights and product availability and persists the request.
3. For cross-application access, an outbox job submits an approval request to mocked SkoNET. The UI shows Pending approval and its request reference.
4. The mock can deliver approval, rejection, delay or failure. Decisions use the same validated, idempotent command path that a real integration will use. Mock decision controls are restricted to an explicit simulation environment.
5. Approval starts access provisioning; the UI shows Activating until the gateway has applied the entitlement. Only then report Active.
6. Rejection creates no usable access. Revocation withdraws the entitlement automatically and reports Revoking until applied. Consumer cancellation while pending is a separate valid transition.

Separate business approval state from delivery/provisioning state: an approved request can still be awaiting gateway application, and a pending request can have a retrying SkoNET delivery. Duplicate/out-of-order callbacks cannot resurrect rejected, cancelled or revoked access. An approval must identify the original immutable application/product/environment request.

Never distribute pending credentials to the gateway or expose them as usable access. Preserve two-key rotation and consumer-only key access; publishers may approve/reject/revoke access to their products without reading another application's keys. Purpose, requester, approver, timestamps and external reference belong in the native model, not encoded names.

Email failures retry independently and must not undo an approval. Notifications describe the real workflow state. The same event and authorization model should support Kafka access requests, while provisioning is delegated to the mock Kafka implementation.

## All six integrations are wired in with mocks

Mocks are stateful service implementations behind native interfaces. Normal screens and commands exercise them; no empty-list placeholders or frontend-only success messages. Persist workflow state and deterministic fixtures so refreshes and restarts do not erase processes. A later real implementation replaces the transport, not the domain workflow.

| Integration | Wired process and mock behavior |
|---|---|
| Kafka | Topic create/edit/delete, discovery, access requests, ACL provisioning, REST proxy configuration and playground. Simulate topic metadata, ACL state and bounded message produce/consume results. Show that execution is simulated; do not suggest a real broker was contacted. |
| SkoNET | Submit requests, return tracking references, deliver correlated approval/rejection events, simulate timeout/retry and duplicate callbacks. Pending approval must remain observable rather than instantly auto-succeeding. |
| Email | Durable notification outbox, template rendering, recipients, delivery status and retry; capture messages in a mock mailbox without sending externally. Trigger on requests, decisions and relevant operation results. |
| LdapWS | Directory/contact lookup for requesters, approvers and support; simulate missing records and outages. OIDC application rights remain the authorization source. Any needed supplemental directory capability must be explicit. |
| FixMe | Start a scoped diagnostic/repair operation, report steps, history and outcome; simulate progress/failure and recovery without executing infrastructure repairs. |
| LeanIX | Application metadata, business identifiers, descriptions and owner contacts, available in picker/details and approval forms; include missing-data behavior. |

Use explicit integration configuration selecting mock implementations. Mark simulated outcomes in the UI. Real credentials are not needed for these six integrations during this phase. Mock callbacks must not become a production bypass.

Detailed request logs and synthetics are separate from these six integrations. Preserve relevant UI components, but implement real native data collection or explicitly modeled simulation where agreed; aggregate telemetry cannot truthfully populate individual request logs. Do not silently treat this requirement as permission to omit those screens or fabricate real observations.

## Simple publishing, configuration and promotion

The ordinary user journey is:

1. Choose an application, select/create a product, supply an API definition and backend address, and click **Publish to DEV**.
2. Configure the API using familiar properties and policy forms, then click **Save**. The system applies changes automatically.
3. Click **Promote to TEST**. Supply a target backend or certificate only where a valid environment setting is missing, then submit once.
4. Click **Promote to PROD** using the same interaction.

Do not require users to create routes, bindings, revisions or release plans, inspect digests, invoke reconciliation, or confirm a second technical plan. Version and history views can remain useful optional tools, but routine edits automatically create any immutable internal snapshots required.

Native domain commands own the full operation. Proposed API shapes are ordinary publish, configure, promote and operation-status endpoints; these are new native capabilities, not wrappers that reproduce old BFF contracts. Each command authorizes, validates, commits desired state and queues durable work atomically. The browser submits one business action rather than coordinating a sequence of low-level writes.

Internal revisions, compiled artifacts, config digests, polling and fleet acknowledgements remain useful implementation mechanisms. Preserve them where they fit. Replace the current user-reviewed `planId` requirement rather than making the frontend secretly call dry-run/confirm.

### Predictable environment behavior

Proposed defaults:

- Publishing starts on DEV. TEST is promoted from DEV; PROD from TEST.
- Promotion captures the source's accepted definition and portable API configuration at submission. A concurrent source edit belongs to a later operation and cannot silently change the submitted promotion.
- The native service manages internal route and deployment details. Environment-specific backend addresses, credentials, certificates and hostnames are retained in an existing target. Missing required values appear in the simple promotion form before acceptance; do not guess TEST/PROD endpoints from DEV strings.
- First promotion seeds portable settings from the source. Later promotions replace portable settings with the captured source settings while preserving explicit environment overrides. The UI identifies overrides in normal settings; it does not expose a per-policy-unit merge plan.
- Certificates/secrets are not blindly copied across environments. Resolve existing authorized target references, or collect missing settings before acceptance.
- If the source is still applying, a valid promotion may wait automatically for that captured source state to reach the fleet. A business status explains the wait. No bypass of DEV -> TEST -> PROD is necessary for routine work.
- Editing DEV never changes TEST or PROD until promotion. Saving settings on a selected environment applies only there.

These defaults simplify the implementation and user model together. They need native concurrency tests, not just revised labels.

## Automatic eventual consistency and honest progress

Persist desired state and observed state separately. Every accepted operation carries an ID, acting application, actor, captured input/generation and durable status. It survives page closure and process restart and appears in the API's environment status and activity feed.

Suggested user-facing statuses: Queued, Applying, Waiting for gateways, Retrying, Complete, and Blocked. Approval workflows also show Pending approval and Rejected. Keep technical detail available for operators without requiring it for normal publishing.

The reconciler must:

- Retry transient failures with bounded exponential backoff and jitter, and continue later through a periodic reconciliation pass. A per-attempt retry limit must not abandon desired state.
- Recover jobs after restart using leases and idempotent steps. Avoid partial desired-state writes and duplicate subscriptions/releases.
- Re-evaluate transient deployment conditions automatically instead of returning a terminal stale-plan task to the user.
- Serialize or order work per affected resource/environment and compose concurrent environment changes into complete configurations. Prevent old work from overwriting newer desired state; report superseded operations distinctly.
- Verify fleet acknowledgements against the relevant applied generation/configuration before reporting completion. An offline required gateway remains visible as pending/degraded and catches up automatically on return; do not claim full completion after a database write.
- Keep last known good gateway configuration during failed deployment and continue toward desired state when dependencies recover.
- Reconcile subscription grants, revocations, product membership and certificate references as well as API definitions.

Automatic convergence assumes valid desired state and eventual dependency recovery. Reject known invalid inputs before accepting the operation. For persistent infrastructure/configuration failures, report Blocked and alert an operator while retaining desired state; do not ask the publishing user to rerun technical steps or endlessly display success. Normal reconciliation never requires a manual retry click.

Existing `control-plane/src/jobs.ts` has a useful durable queue and leases, but currently uses `MAX_ATTEMPTS = 3` and can terminate releases as failed or stale. That behavior must change. Current promotion planning in `promotion.ts` and `api/promotion.ts` must be redesigned around captured user intent and automatic execution.

## Reuse / adapt / build

| Area | Decision |
|---|---|
| Old `src/styles.css`, icons, fonts, visual assets | Reuse the established design, including light and dark themes. |
| Sidebar, topbar, application picker, breadcrumbs, editor tabs | Reuse presentation; adapt context directly to native applications and memberships. |
| Markdown, code editors, operation rendering, search controls, dialogs | Reuse components where their behavior fits; native validation stays authoritative. |
| Catalog, workspace, publish/configure forms, MCP/A2A views | Adapt directly to native types and business commands; add visible product participation. |
| Old policy editor | Reuse useful card/form appearance. Replace Azure XML parsing, serialization and section-order assumptions with native policy types. Build missing controls from scratch; no XML translation runtime. |
| Entity cache and feedback components | Reuse patterns; adapt invalidation to native objects and operation completion. |
| Authentication client and capability checks | Adapt to one server-owned session and OIDC application membership. Remove team and legacy auth-mode assumptions. |
| Subscriptions, approval history, integration activity | Build native stateful workflows; reuse suitable old layouts. |
| Product management | Adapt native functionality into the old portal's visual system. Products remain explicit to publishers and consumers. |
| Certificates | Adapt native ownership/storage and build missing renewal/upload behavior; discard APIM/Key Vault assumptions. |
| Backend resources/catalog/auth/principals | Refactor ownership to applications throughout persistence, APIs, validation, audit, telemetry and authorization. |
| Normalizers, validators, compiler, gateway pipeline, cryptography | Reuse and extend where necessary; test native protocol behavior rather than recreate Azure internals. |
| Publish/promote orchestration and operation tracking | Build native business commands using existing compiler/reconciliation mechanisms where sound. |
| Old Express backend and Azure client/cache machinery | Reference for process behavior only; do not ship as a facade. |
| Tests and specifications | Reuse journey/visual expectations, rewrite contracts for the new domain, and replace Azure-dependent tests with native/mocked integration tests. |

Both frontends already use React 18.3.1 and TypeScript/Vite. Bring necessary browser dependencies into the maintained frontend rather than copying the old mixed frontend/backend package wholesale. Use one native set of contracts; no legacy DTO model or namespace remains alongside it.

## Implementation sequence

1. **Application ownership foundation:** change schema, memberships, OIDC claims handling, authorization, API/product/certificate ownership and audit context. Remove Teams from maintained UI and native contracts. Update seed/configuration and regression tests. Existing databases need an explicit upgrade/reset strategy before implementation; do not retain a permanent alias model to avoid this decision.
2. **Native workflow core:** implement product-based requests/approvals, operation state, outbox and application-scoped integration interfaces. Wire all six mock integrations into real command paths with deterministic failure cases.
3. **Publishing and convergence:** implement atomic publish/configure/promote commands, automatic snapshots, captured promotion intent, continuous reconciliation and fleet-based completion. Include entitlement changes in this mechanism.
4. **Portal reuse:** bring over the visual system and useful components, adapt direct native calls, and build product/approval/progress views. Keep all required integration processes reachable in the familiar shell.
5. **Complete native journeys:** cover REST, SOAP, MCP/A2A, certificate handling, Kafka simulation, metadata, notifications and FixMe simulation. Close remaining behavior gaps with new native functionality.

Acceptance must demonstrate:

- One developer can publish and consume for application A but cannot mutate or reveal keys for application B without membership; a membership removal takes effect server-side.
- APIs are subscribed through explicit products; own-product and cross-application subscriptions both work.
- Cross-application requests stay pending until a valid decision; approval provisions access, rejection does not, and revocation reaches gateways.
- Kafka, SkoNET, email, LdapWS, FixMe and LeanIX are all exercised through normal UI processes, including delayed/failing mocks.
- A user publishes to DEV, saves configuration, promotes to TEST and PROD without dealing with internal configuration objects or release plans.
- Restart, duplicate callbacks, temporary integration failure, concurrent edits and a returning offline gateway converge automatically without duplicate effects or manual reconciliation.
- Familiar layout/navigation and responsive behavior are verified visually, while real native gateway calls verify authorization and protocol behavior.

## Implementation status

Updated 2026-09-05. The five sequence steps above are built except where this section says otherwise. `bun test` and `bun run typecheck` both pass across the control plane, data plane, shared code and UI.

| Step | State | Where |
|---|---|---|
| 1. Application ownership foundation | Done | `control-plane/migrations/schema-006.sql` renames `team` to `application` and folds the old consumer table into it; memberships, OIDC claims, authorization, resource/product/certificate ownership and audit context follow. Teams are gone from the maintained UI and native contracts. |
| 2. Native workflow core | Done | `control-plane/src/operations.ts` (operation state), `integrations.ts` (durable outbox and all six mocks), `kafka.ts` (topics, ACLs, playground). Approvals run through the same validated, idempotent command path a real integration would use. |
| 3. Publishing and convergence | Done | `POST /api/publish`, `/configure`, `/promote` accept one business action each; `runOperations` reconciles continuously and reports complete only against fleet acknowledgement. The old `MAX_ATTEMPTS = 3` termination is gone. |
| 4. Portal reuse | Done | `ui/src/portal/` carries the visual system, application picker, editors and operation rendering; the shell covers every screen the route table declares navigable, held there by `ui/test/portal.test.tsx`. |
| 5. Complete native journeys | Mostly done, three gaps below | REST, SOAP, MCP/A2A, certificates, Kafka simulation, metadata, notifications and FixMe are all reachable through the shell. |

The acceptance list is demonstrated by `test/native-workflows.test.ts`, including the four convergence cases the sections above insist on: a restart across a queued operation, a duplicate approval callback, a temporary integration failure that retries rather than disappearing, and a gateway that was offline for a change and catches up on its own. A concurrent source edit is shown to belong to a later operation rather than silently changing a submitted promotion.

### Known gaps

These are the parts of step 5 that are not built. None is blocked; each is a decision that has not been made yet.

- **Individual request logs.** Only aggregate telemetry is collected, and the section above rules out using it to populate per-request views. The data plane writes a per-request access line to stdout and nothing collects it. Either native per-request collection is built, or the screen is dropped deliberately — it must not be filled with aggregates.
- **Certificate renewal in place.** Upload, listing, expiry warnings and delete exist and are application-owned. Renewing means uploading a second certificate, repointing each binding that names the old one, and deleting it; there is no single renewal command that carries the bindings across.
- **Email is a mock mailbox inside the integration activity list.** Delivery status, retry, recipients and rendered body are all persisted and visible, but under Integrations rather than as a mailbox of its own, and no notification reaches the user outside that screen.

Smaller than the above, and noted so it is not rediscovered: `lib/routes.ts` still classifies screens with an old-shell `section` field that only the route tests read.

## Scope of this update

This is the revised source-backed design and reuse assessment. The previous compatibility recommendation is replaced, not an alternative implementation path.
