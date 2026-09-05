# Integration Portal Change Log

Every user-visible change ships here. This file is the single source of truth for the in-portal
Change Log — [`shared/changelog.ts`](shared/changelog.ts) parses it, the portal renders whatever
comes out, and the **newest heading is the portal's version number**. There is deliberately no
second copy of the version anywhere else for this one to disagree with.

Conventions, enforced by [`test/changelog.test.ts`](test/changelog.test.ts):

- Version headings are `## <version> - <DD.MM.YYYY>`. Both halves are required. Pre-release
  suffixes (`-rc.1`, `-beta`) are kept verbatim.
- Inside a version, every bullet sits under one of five headings: `### Added`, `### Changed`,
  `### Fixed`, `### Deprecated`, `### Removed`. `### Retired` is a synonym for Removed. Omit a
  category that has nothing in it rather than writing `(none)`.
- One bullet is one short sentence about something a person can **see or do** in the portal.
  Refactors, build changes, dependency bumps, container plumbing and internal test coverage belong
  in the commit message, not here.
- Newest version first.

## 1.1.0 - 05.09.2026

The surfaces the Azure-backed predecessor had, rebuilt on our own control plane and our own
gateways — with nothing Azure-shaped carried across.

### Added

- Request logs for an API, searched over an ELK index with a histogram, a status filter and the
  single request's own trace. Where the index is simulated the screen says so.
- Health Status is open to everybody and reads in three layers: a verdict per environment, an
  uptime strip per gateway, and the component matrix underneath. A gateway is two separate
  probes — what its own replicas report, and what an HTTP call from outside sees.
- The dashboard shows each figure against the previous window with a sparkline, and the traffic
  table opens the logs for the API you click.
- An API can change hands. The whole version family moves at once, products that sell only that
  family travel with it, and a product shared with other APIs refuses rather than splitting a
  subscriber off from what they bought.
- A revision can be rolled back from the Revisions tab, dry run first, with the plan shown before
  anything is released.
- Descriptions are written as Markdown, with a toolbar for the syntax and a Preview that renders
  exactly what the catalog will show.
- One documentation link per API — the wiki page, usually — offered as **Open wiki** wherever the
  API is read. A new version inherits it, along with the rest of the catalog card.
- A notifications bell, counting what you have not read, and a Mail screen with the message behind
  each headline. Delivery is simulated in this phase and every message says so.
- This Change Log, reachable from the version in the top bar.

### Changed

- The catalog, the dashboard and the API workspace are back in the branded layout: domains that
  fold, one row per API family, and a version-and-environment picker on each.
- The count in the top bar is deployments in flight and opens Activity. What you have not read is
  the bell's job, next to it.

### Fixed

- Deleting an application no longer refuses forever because the portal's own LeanIX lookup counted
  as something the application still owns.

## 1.0.0 - 04.09.2026

The portal on its own two planes: a control plane that owns every decision, and gateways that poll
it and apply one complete configuration document.

### Added

- Publish a REST, SOAP, MCP or A2A resource, promote it along `dev` → `test` → `prod`, and watch
  each deployment converge on every gateway.
- Products, subscriptions with two keys, and an approval flow with a purpose and a decision.
- Policy as a closed native vocabulary rather than XML, per environment, with a diff before
  anything is released.
- The playground, the certificate store, trust anchors, Kafka topics and the six external systems,
  each simulated and each marked as such.

### Changed

- Everything is owned by an **application** — APIs, products, certificates, Kafka topics — and
  membership of that application is the only thing that decides what you may change.
- An environment may hold several gateways, and an API says which of them it answers on.
- Every catalog item has a domain, and the domain is the first segment of its address while the
  version is the last.

### Removed

- Azure API Management, in every form: ARM shapes, policy XML, APIM revision semantics, Key Vault
  and tag-derived teams.
