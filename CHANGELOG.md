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

## 1.2.4 - 08.09.2026

The APIs you call sit beside the APIs you publish, a key has an age, and a definition is checked
where it is written.

### Added

- **APIs**, **MCP Servers** and **A2A Agents** also list what this application subscribes to. A
  subscribed row names the publisher, says which products and environments the access covers, and
  opens the read-only catalogue listing rather than an editor that would refuse every control.
- A filter over published-here and subscribed appears on those screens when there is something on
  both sides of it.
- A subscription's keys show how old each one is and the date it stops working, and **either** key
  can be rotated — the primary used to be unreplaceable from the subscriptions list.
- A subscription key now expires. The portal asks for a rotation once it is a year old and the
  gateway stops accepting it at 600 days; an administrator can set both ages.
- Definitions are checked on the page where they are written. Problems appear in the workspace and
  in the publish wizard as you edit, with a one-click conversion from YAML to JSON.
- The API workspace's tabs can be moved through with the arrow keys, and its definition editor
  wraps long lines instead of scrolling sideways.

### Changed

- Publishing an API creates a product for it, named after the API, so the wizard no longer asks for
  one. A later version of the same API joins that product. Bundling several APIs into one is still
  on **Products**.
- The publish wizard's third step is **Route** rather than "Route and sell", and asks only where
  traffic goes.
- **Subscriptions** offers what each state actually allows: cancel a request that is still waiting,
  keys and revocation while it is active, subscribe again once it is over, and a sentence saying
  what is being waited on while the gateways catch up.
- Ending a request nobody has decided yet is called cancelling it, not withdrawing access that was
  never granted.
- What is in a product is chosen from a list of checkboxes instead of a multiple-selection box.
- A catalogue card says how far along the promotion chain an API has got.
- The catalogue heads an API by the name its publisher chose, not by whatever the title inside its
  definition says.
- Request timeouts accept 120 seconds by default and 240 at most.
- An application is provisioned from the group in your token rather than mapped by hand.
- The application picker stacks an application's name above its LeanIX id instead of running the
  two together.
- Dates and times read the same way across every screen.

### Fixed

- Buttons on sixteen screens drew as flat text, because two stylesheets disagreed about what a
  button is.
- A subscription could sit on **Revoking** for minutes. A replica that had been shut down rather
  than restarted still counted as one the change was waiting for, which was silently holding up
  publishing too.
- An API refuses a path its definition does not declare instead of forwarding it to the backend
  unchecked — and unvalidated, which was the same traffic nobody was checking.
- The base path an API is published at is removed before the backend is called.
- The API workspace opens a definition indented, and no longer counts a whitespace change as an
  edit you have to save.
- **MCP Servers** says "MCP server" where it used to say "API", and a single published version is
  no longer drawn as a control that does nothing.
- An empty certificate table is an empty state with an action rather than a bare heading.
- The subscribe dialog asks for the purpose the request has to carry, and stops promising a key it
  never had.
- Environments in a listing are ordered along the promotion chain.
- Adding a sign-in provider is a change to `.env` alone, and an empty value no longer defeats the
  default.
- A caller arriving over a dual-stack listener matches the IPv4 range that names it.

## 1.2.3 - 06.09.2026

Every state on every screen says what it means, in one set of colours.

### Changed

- Subscriptions, Approvals, Kafka and Activity name a state by what it means to you rather than by
  the word in the database. A change on its way out says **Rolling out** instead of "waiting for
  gateways", a request nobody has decided says **Awaiting approval** instead of "pending", and a new
  topic says **Creating** instead of "provisioning". Hovering any of them still shows the underlying
  value and a sentence explaining it.
- Those four screens now use the same status colours as the rest of the portal: in progress reads as
  in progress, finished as finished, and history as history. Eleven states that all looked identical
  are now told apart at a glance.

### Fixed

- **Subscriptions** no longer shows a request that is waiting for its publisher as **Revoked**. A
  pending request said the publisher had taken your access away while it was still sitting in their
  approvals queue.
- Status chips follow the dark theme instead of staying pale boxes on a dark page.

## 1.2.2 - 06.09.2026

Every section of every screen is the same box, drawn the same way.

### Fixed

- The line under a section's heading reaches both edges of the section it divides, instead of
  stopping twenty pixels short on each side. It was drawn that way on every panel in the portal.
- Sections that hold a table or a list of rows — Operations on an API, Traffic by API on the
  dashboard — let it reach the edges rather than floating it inside the padding.

## 1.2.1 - 06.09.2026

One catalog instead of two, and the same box in the same place on every screen.

### Changed

- **Catalog** in the sidebar is one screen now. It is the one that searches the contract itself —
  operation ids, MCP tool names, A2A skills — counts what each filter would return, files Kafka
  topics beside APIs in the same domains, and says so when the estate is larger than one ranking
  pass reads. Opening an API from it shows the read-only listing, with Getting started, Try it and
  the versions, and subscribing walks through the application, the environment and the rate limit
  and quota being agreed to. The address the old cross-application list answered on still works.
- APIs, MCP Servers and A2A Agents are unchanged: your own list, with the version picker, the
  environment chevrons, and the transfer and delete only an owner has.
- Every empty list on every screen now names something to do about it, rather than half of them.
  Boxes that were waiting for a request show a placeholder instead, and boxes that were explaining
  why a control cannot be used are notices.
- Warnings and errors look the same everywhere, follow the dark theme, and announce themselves.
- Filter and search boxes on the catalog and elsewhere are properly labelled for a screen reader.

### Fixed

- **New version** refuses an identifier the API already has, before publishing rather than after,
  and says which versions are taken. Case is not a difference: `V2` and `v2` are one version.

## 1.2.0 - 06.09.2026

One route table behind the whole portal, and the links that quietly went to the wrong place now
arrive.

### Changed

- Every screen says what it is for, in one line under its title.
- Switching application keeps you on the screen you were reading. A screen that is the same for
  everybody — Trust, the catalog, your account — stays put instead of sending you to a dashboard.
- Health Status, Gateways and Telemetry no longer repeat their own title inside the page.

### Fixed

- A link that names a panel of an API's workspace opens that panel. What needs your attention about
  a policy that will not compile, a missing route or a missing backend now lands where the fix is,
  instead of on the definition every time.
- **Try it from here instead**, at the end of subscribing, opens the playground.

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
- A client certificate can be renewed in place, keeping its name and every binding that names it.
  A certificate for a different subject is refused: that is a substitution, and it has to be made
  one binding at a time.
- This Change Log, reachable from the version in the top bar.

### Changed

- The catalog, the dashboard and the API workspace are back in the branded layout: domains that
  fold, one row per API family, and a version-and-environment picker on each.
- The count in the top bar is deployments in flight and opens Activity. What you have not read is
  the bell's job, next to it.

### Fixed

- Deleting an application no longer refuses forever because the portal's own LeanIX lookup counted
  as something the application still owns.
- A link to one subscription opens that subscription — its keys, what it may call and what it has
  spent — instead of the list of all of them with the name dropped.
- **Publish an API** on How this works opens the wizard rather than the list of APIs.

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
