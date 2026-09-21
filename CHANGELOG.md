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
- Two inline forms reach the screen: `**bold**` for a screen, a setting or a feature by name, and
  `` `code` `` for a key, a path or a header. Nothing else is interpreted — a link written in a
  bullet arrives as its brackets. This preamble is not an entry, so it may use whatever it likes.
- Newest version first.

## 1.4.0 - 21.09.2026

An application keeps its own credentials, a backend is allowed unless a rule forbids it, and the
gateway is measured in fractions of a millisecond.

### Added

- **Credentials**, a new screen under Other. The passwords, API keys and HMAC pairs an
  application's APIs need are added, rotated and deleted here, per environment, without an
  administrator — they used to live in a file on the control plane's disk that only an operator
  could edit and only a restart could reload.
- A credential is encrypted the moment it arrives and is never shown again, to anybody. Losing one
  means rotating it, which every policy that names it survives untouched.
- Every reference field in the policy editor is now a picker rather than a free-text box, with the
  application's own credentials and the administrator-registered names in two labelled groups. A
  reference that no longer resolves is kept, marked and warned about rather than silently reset.
- **Blocked backends**, a new section on Trust. An administrator forbids a backend host or address
  range there with a reason, and the rule is checked both when a backend is written and again at
  every configuration build — so it reaches backwards: a route that has served for months stops
  within one poll, and its owner reads the reason on the dashboard where they already look.
- **Server-Timing**, a gateway setting that makes every answer carry
  `Server-Timing: gw;dur=…, backend;dur=…`. It is off by default, takes effect on a running gateway
  with no republish and no restart, and omits the backend segment entirely when no backend was
  reached rather than reporting a zero.
- Subscribing to an API from its own workspace, offered in the Subscriptions panel's head and from
  its empty state, with only the products that contain that API. The answer to "how do I get a key
  for this" used to be a trip to the Catalog to search for the thing already on screen.
- A promotion chooses which of the destination environment's gateways the API lands on, and
  previews the addresses it will answer at there. The only way to narrow it used to be promoting
  onto every gateway and then taking some away.
- An icon on every navigation entry, declared in the route table beside the label it belongs to.

### Changed

- A **client certificate is a credential**, and lives with the rest of what an application holds.
  Uploading, renewing and retiring one happens on Credentials, beside the passwords and the keys,
  with its subject, issuer and expiry on the row; Trust keeps the administrator's reading of the
  same list. `/certificates` still opens, so a link in a ticket lands on the screen that now
  answers the question.
- A policy unit set for a whole environment **cannot be taken off one API**. Its card says so and
  its remove control is disabled; give the API its own value to override it, or change it for
  everybody on Global policy. Removing the card used to look like it worked, and a save from any
  panel quietly detached that API from the environment's defaults for good.
- The API workspace's **Properties** panel is three headed sections rather than three cards inside
  the workspace's own card, each group of fields on one tinted surface. The derived public path now
  looks derived, and the gateway chooser lists the **final** addresses once — it used to print every
  URL twice, bare above and with the path appended below.
- The **version selector** sits in the workspace head beside New version, sized to its value,
  instead of stretching across the page among the API's properties.
- Wherever a screen's panel holds something that is a panel on its own page — the workspace's
  Playground, Logs and Revisions panels, Health's component groups — the inner one is drawn as a
  section rather than as a box inside a box.
- **Health Status** groups every probe under one panel instead of four, and the rate-limit
  arithmetic is a collapsed aside rather than a card competing with the status above it.
- **Products** states once, at the top, what publishing a product entitles you to. It used to
  repeat the same two sentences under every product's subscriber table.
- The environment switcher does not offer a stage the API on screen has not reached. The stages it
  is not in are disabled and say that a version arrives by being promoted into it from the one
  before; the whole chain is still drawn, so an estate does not look like it has fewer stages.
- Everything that starts a subscription is called **New subscription**, wherever it appears. It
  said "Subscribe to this API", which names the one thing the model denies — a subscription is
  held against a product, which is what the dialog then asks you to choose.
- The Subscriptions panel offers one subscribe control, not two. The empty state already names the
  next step, so the button above it was a second control doing the same thing.
- Deleting a credential a policy still names is refused, naming each route and the policy unit
  that names it.
- A **JWT issuer** and an **OAuth 2 token endpoint** are still registered by an administrator, and
  the editor now says so instead of offering an empty box. Both resolve to a URL the gateway itself
  calls; everything else is only a secret.
- The **request and response header** policies are edited as a list of rules, each saying what it
  does — remove, overwrite, append, or set if missing. All four were always in the document; three
  of them were only reachable through the raw JSON, under a sentence reading "remove → set →
  append → skip, in that order".
- The **Definition** panel puts the document and the operations it declares side by side, and the
  editor is capped and scrolls within itself instead of growing to the length of whatever is
  pasted into it.
- A subscription is one line — product, state, holder and purpose read across it — rather than
  four.
- A backend no longer has to be registered anywhere before an API may use it. Egress is allowed by
  default and forbidden by rule; the address ranges the platform refuses outright stay in the
  operator's file, where nothing clickable can widen them.
- Latency is measured below a millisecond. The histogram started at 1 ms, so a gateway whose own
  work costs a few hundred microseconds could only ever be reported as "1 ms"; there are now three
  buckets under one, durations are kept at microsecond resolution, and every figure derived from
  them says it is approximate.
- The **Catalog** is one compact row per resource — name, kind, version, publisher, summary, live
  environments, and whether you are subscribed or may subscribe — with one clear action to open the
  listing. Domain grouping stays for browsing; a search, a filter or a chosen sort shows one flat
  scannable list instead, and the publisher and tag filters sit behind a single disclosure.
- The Catalog is about resources, not just APIs: REST and SOAP APIs, MCP servers and A2A agents are
  listed, and Kafka topics are counted in the domain figures and linked to Kafka.
- Subscribing from the Catalog is one form rather than a wizard, for the application selected in
  the main menu. There is no application picker and no inline application creation, not even for an
  administrator, and the environment defaults to the one being viewed.
- An application's own **APIs** list is flat and ordered by name, each row carrying its domain and
  at most one line of description as plain text. It used to be folded into domain groups, which
  bought a screenful of four APIs for a reader who owns them and knows their names.
- The **Playground** offers a gateway's own published address ahead of any replica address, and
  shows the whole URL it is about to call rather than a bare path.
- The gateway forwards every header the caller sent. Only the ones it owns are overridden — the
  hop-by-hop headers, `Host` and `Content-Length`, the credential the route authenticated with, and
  the forwarding and trace headers — so a backend feature that depends on a header of the
  consumer's own is no longer quietly lost on the way through.
- An idle portal stops asking. The shell's clock slows by an order of magnitude while nothing is
  reaching the gateways, speeds back up while a promotion converges, and stops altogether in a
  hidden tab, refreshing once when you return to it.
- Primary buttons are mint with dark-green text, and the brand row runs continuously with the
  topbar above the sidebar.

### Fixed

- The empty Subscriptions panel no longer explains the stage you are standing in by naming a
  different one. It said an application subscribed in DEV has nothing here until it subscribes in
  this one too — read in DEV, which is where it is most often read.
- The **Public path** in the New version dialog is derived and read-only, as it is everywhere else.
  It was a text box, so a version could be published at a path outside its own domain — an address
  that contradicts the catalog it is filed under.
- The **Change Log** dialog reads with real emphasis. A screen's name and a setting's key were
  written as Markdown in the file and rendered as one plain string, so every line of every entry
  carried visible asterisks and backticks.
- A backend URL written with an IPv6 literal host — `http://[::1]:9000` — is refused outright. The
  platform's address check is IPv4-only by construction, so such a URL would have walked straight
  past a denied loopback range.

### Removed

- The **Deployment progress** table no longer appears on every panel of an API workspace. It is on
  History, where it belongs; the other panels carry one sentence saying how many changes are still
  reaching the gateways, and the bell says when one lands.
- `egressAllowlist`. A configuration file that still declares it now fails startup, naming the key
  and the screen that replaced it: an operator trusting a list nothing reads is worse off than one
  who knows there is no list.

## 1.3.1 - 11.09.2026

A gateway is its name and where it is, not a word from a list.

### Removed

- The **Kind** field is gone from the Gateways screen. `Managed`, `On-premise` and `Other` had to
  be chosen when a gateway was added, could never be changed afterwards, and nothing in the portal
  ever read the answer — no routing, no policy, no promotion, no icon.
- With it goes the only thing it reached: gateways were listed with the managed ones first. They
  are now listed by name, everywhere they appear.

### Changed

- A gateway now says what it is with the two fields that mean something: its **name**, which a
  publish travels under, and its **Locality**, which is where the deployment physically is.

## 1.3.0 - 10.09.2026

What a gateway enforces is set in the portal, for the fleet, an environment or one gateway.

### Added

- **Gateway settings**, a new administration screen. The concurrency ceilings, the request body
  cap, the validation pool and buffer budget, the response and artifact cache sizes, the JWKS
  refetch floor, the telemetry bounds and the access log are set here — for every gateway, for one
  environment, or for a single gateway, with the most specific value winning for each setting on
  its own.
- Each setting shows the value in force, the layer it came from, the bounds it accepts and the
  environment variable it replaced, so an upgrade is a transcription rather than a search.
- Saved values reach every replica on its next poll, within seconds and without restarting
  anything. A change is saved as one set or refused as one.
- Health Status reports the settings a replica is actually enforcing, which is how a replica that
  refused a change is told apart from one that has not received it yet.

### Changed

- Turning the access log off is now a typed confirmation and a named audit entry. It is still the
  only thing that can be done to it: nothing thins the lines.
- A replica whose container cannot honour a centrally-set concurrency ceiling refuses the whole
  configuration, keeps serving what it had, and says why on Health Status. Lowering the setting is
  enough to recover it — nothing has to be restarted.

### Removed

- Sixteen environment variables on the gateway. A container that still sets one refuses to start
  and names it, together with the setting that replaced it. **Set the values on the new screen
  before rolling gateways** — see Upgrading in `README.md`.

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
