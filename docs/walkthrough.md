# Walking the Integration Portal

Two ways to see whether this works: by hand, through the interface, with this file closed; and with
`curl`, against a running gateway.

The first is the one that matters. `scripts/demo.ps1` walks every journey through the API, and the
interface's own test suite asserts that each guided sequence's steps exist, that a fresh account
sees every primary control either enabled or disabled with a reason, and that each completion panel
names the next action. **None of those is a person using the portal.** This is the list to work
through when you want to know whether one can be.

---

## Contents

1. [Getting a stack up](#1-getting-a-stack-up)
2. [The seven journeys, by hand](#2-the-seven-journeys-by-hand)
3. [The things that are easy to get right in a demo](#3-the-things-that-are-easy-to-get-right-in-a-demo)
4. [Calling it with curl](#4-calling-it-with-curl)
5. [The scripted tour](#5-the-scripted-tour)

---

## 1. Getting a stack up

```bash
bun install
```

```bash
pwsh -File scripts/stack.ps1 -Up -Rebuild
```

That seeds the database, mints one token per gateway, and starts nine processes:

| | | |
|---|---|---|
| petstore backend | `:9080` | REST + SOAP + SSE + WebSocket, simulated latency, deterministic under a seed |
| petstore backend 2 | `:9081` | a second copy, so a pool has two members that can be told apart |
| MCP server | `:9085` | a real MCP server — initialize, list tools, call tools, sessions |
| A2A agent | `:9086` | a real agent — its own card, send, and a streaming method |
| control plane | `:8080` | API, interface, job runner, contract compiler, telemetry and quota aggregation |
| `dev-1`, `dev-2` | `:8081`, `:8082` | two gateways in DEV, so `calls × instances` is visible |
| `test-1` | `:8083` | |
| `prod-1` | `:8084` | |

The three upstreams know nothing about this platform. That is the point: publishing them must not
require changing them.

```bash
pwsh -File scripts/stack.ps1 -Status
```

```bash
pwsh -File scripts/stack.ps1 -Down
```

The interface is at <http://localhost:8080>. Build it with `bun run build:ui`, or run
`bun run dev:ui` for the dev server on `:5173`.

The seed writes `AUTH_PROVIDERS=dev` into `.env.local`, so the sign-in screen offers the development
bypass — one click to become Alice (administrator), Pavel (publisher) or Clara (consumer). It is
behind a warning on that screen, and it is not a default: no deployment gets it without asking for
it by name. To try the real sign-in paths locally instead, set `AUTH_PROVIDERS=local` in `.env.local`
along with a bootstrap administrator, and restart the stack.

**Configuration changes need a full down-and-up cycle**, not a restart of one process.

---

## 2. The seven journeys, by hand

The claim being checked is the one in the plans: **a person who has never seen this can complete each
journey without being told anything.** If a step needs an explanation that is not on the screen, that
is the finding.

Start on **How this works** — the last item in the sidebar — and read the first card. Everything
below assumes only that.

| | Journey | Do this | It has worked when |
|---|---|---|---|
| 1 | **Publish** | Sidebar → **My APIs** → *Publish an API*. Kind `rest`, name `checkout`, version `v1`. Paste a definition or give a URL. Host `*`, base path `/checkout/v1`, backend `http://127.0.0.1:9080/v2`. Review, publish | The last panel names the address and offers four things to do next — and says nobody can subscribe until it is in a product |
| 2 | **Promote** | On the API → **Publish** tab → promote to TEST | Step 2 shows the plan in words *before* anything happens, and refuses with a named blocker if TEST has no route yet. What is applied is what was shown |
| 3 | **Version** | On the API, *New version* in the header (top right) → `v2`, choose what to carry over | Two versions appear side by side under one family in **My APIs**, each with its own base path and its own live-in pills |
| 4 | **Subscribe** | Sign in as Clara → **Catalog** → the API → *Subscribe*. Create an application if you have none | The key is shown once, with a `curl` that already has the host and the header in it, and three links out |
| 5 | **Call it** | On the listing → **Try it**. Pick the operation, press send | A real response, a request echoed back **without** the key, and an entry in *Your calls* below |
| 6 | **Operate** | Sign in as Alice → **Trust** → *Certificate authorities* → upload a CA PEM. Then **Gateways**, then **Audit** | The preview says what the PEM is before it is trusted, the anchor lists the environments it is live in, and Gateways shows every instance's digest against the fleet's |
| 7 | **Let somebody in** | As Alice → **Users** → create a local account. Then **Teams** → put them in one. Then sign in as them | The new account must choose a password before it can do anything else, and what it may then do changes with the team it is in — not with a permission somewhere |

Journey 7 is worth walking twice, once each way:

- **Create an account and do not give it a team.** Sign in as it. The catalog is readable, every API
  is readable, and the owner screens say *you are not in a team yet* and name who can fix it — rather
  than being empty, or absent, or throwing.
- **Give a team a source group.** On the team, set the identity-provider group that fills it. Nothing
  changes for local accounts, and the Teams screen starts reporting any group names that arrive and
  match no team — which is the failure mode of every group-mapped system, made visible.

---

## 3. The things that are easy to get right in a demo

...and wrong in a product.

- **Every screen states its purpose.** One line under the title, on every screen, including the ones
  you reach by accident.
- **Which environment am I in.** The switcher is above the title, and the sentence under it says
  what that choice does and does not decide.
- **Nothing you cannot do is hidden.** Sign in as Clara and open an API owned by another team: the
  controls are there, greyed, each with the reason beside it rather than in a tooltip.
- **Nothing destructive is one click away.** Every delete, revoke and withdraw is folded shut and
  wants the object's name typed back, with a sentence saying what stops working.
- **Every empty state offers the next step.** A brand-new account should never reach a screen that
  only says "nothing here".
- **Errors land where the decision was made.** Try to promote into an environment with no route: the
  refusal is on the step, in the server's own words, with a link to the screen that fixes it.
- **Every word of jargon is defined.** Hover any underlined term. It should be a sentence, not a
  restatement, and the same sentence the glossary on *How this works* shows.
- **Provenance is on the row.** On a user, every team membership says whether it came from a group
  or was granted here, by whom and when. On a team, every member says the same.
- **You cannot lock everybody out.** As the only administrator, try to remove your own administrator
  role. The refusal says you are the last one and that the way forward is to make somebody else an
  administrator first — not "ask another administrator", which would be advice to talk to somebody
  who does not exist.

---

## 4. Calling it with curl

After `scripts/demo.ps1` has run, `petstore v1` is published in all three environments with a key
requirement, a header check and a rate limit of 3 calls per 10 seconds. Reveal a key in the interface
under **Products**, then:

```bash
curl -i http://localhost:8081/petstore/v1/store/inventory
```

`401` — a subscription key is required.

```bash
curl -i -H "X-Api-Key: $KEY" http://localhost:8081/petstore/v1/store/inventory
```

`403` — the key is fine, but the `X-Request-Origin` precondition failed. The body is the one the
policy configured.

```bash
curl -i -H "X-Api-Key: $KEY" -H "X-Request-Origin: skoda-portal" http://localhost:8081/petstore/v1/store/inventory
```

`200`, proxied to the backend. Run it four times in ten seconds and the fourth is `429` with
`Retry-After`. Run the fourth against `:8082` instead and it is `200`: rate limiting is per instance,
so the fleet ceiling is `calls × instances`, and the interface states that arithmetic.

`v1` is deprecated, so every response for it — including the rejections above — carries
`Deprecation: true` and `Sunset: Wed, 30 Jun 2027 00:00:00 GMT`.

### Validation

```bash
curl -i -X POST http://localhost:8081/petstore/v2/pet -H "X-Api-Key: $KEY" -H "X-Request-Origin: skoda-portal" -H "Content-Type: application/json" --data '{"name":42}'
```

`400`, naming the failing JSON pointers — `/photoUrls` is required and `/name` is not a string —
before the backend is called. No validation unit is attached to that route: **the absence of the
unit is not "off", it is "at the defaults"**, and the default is blocking.

### SOAP

```bash
curl -i -X POST http://localhost:8081/petstore-soap -H "Content-Type: text/xml" -H "SOAPAction: \"urn:apim:petstore:GetPet\"" -H "X-Api-Key: $KEY" --data-binary "<?xml version=\"1.0\"?><soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body><tns:GetPetRequest xmlns:tns=\"urn:apim:petstore\"><tns:petId>1</tns:petId></tns:GetPetRequest></soap:Body></soap:Envelope>"
```

`200` with a `GetPetResponse`. Change the `SOAPAction` to `AddPet` and it is `400` — the declared
action disagrees with the body, which is a routing and authorization bypass, and the answer is a
**SOAP Fault** carrying the real HTTP status, not JSON. Send a `petId` the WSDL's inline schema says
is not an integer and it is also a fault. Drop the key and it is `401`, again as a fault.

### MCP

```bash
curl -i -X POST http://localhost:8081/petstore-mcp -H "X-Api-Key: $KEY" -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

`200`, and the response carries the server's `Mcp-Session-Id`. Send it back on a tool call and the
tool runs. Call a tool the server never declared and the answer is JSON-RPC `-32601`; pass arguments
its own declared schema rejects and it is `-32602`, before the server is reached. Drop the key and
the `401` is **a JSON-RPC error, not a problem document** — an MCP client cannot read one, and a
gateway that answers in it has broken the protocol it claims to speak.

### A2A

```bash
curl -s http://localhost:8081/shelter/.well-known/agent-card.json
```

The card is served without a key, because discovery has to be, and its `url` is **the gateway** —
not the origin the agent advertised. Its security schemes are the gateway's too, so an agent that
follows this card brings a subscription key and arrives at every policy on the route. That rewrite
is the whole reason publishing an agent is different from proxying one.

---

## 5. The scripted tour

```bash
pwsh -File scripts/demo.ps1
```

Two acts.

**Act one proves the gateway** — promotion, two live versions, SOAP, validation, backend pools and
the breaker, the global policy tier, MCP, A2A, streaming, the catalog, telemetry and revocation.

**Act two proves the portal** — the journeys the interface names on *How this works*, walked in that
order through exactly the endpoints the screens call: publish, promote, version, subscribe, call it
from the portal's own console, and run the platform. It ends by starting a throwaway TLS backend
whose certificate comes from an authority no public store has heard of, showing the call fail with
`502`, registering that authority as a DEV trust anchor, and showing the same call succeed one poll
later — **with no TLS exception, and with TEST untouched**. Then it reads the console's own calls
back out of telemetry, history and audit.

It is re-runnable: it deletes its own objects first, detaches the global unit it attached, removes
the trust anchor it registered, and uses throwaway processes for the revocation and TLS steps, so it
never leaves the fleet degraded.
