# Manual test checklist

Written 2026-09-05, against the portal shell in `ui/src/portal/`. Work through it in a browser, as a
user, with the source closed. Every section that changes something ends by **calling the gateway**,
because a control plane that accepted a change and a gateway that is serving it are two different
claims.

`docs/walkthrough.md` describes the shell this one replaced (My APIs, Teams, a publish wizard) and is
stale. Use this file.

---

## Read this before you start

Two things worth knowing before the first call confuses you:

- **A freshly published API has no `rewrite` unit**, so the gateway forwards the base path to the
  backend: `/checkout/v1/store/inventory` arrives at the backend as `/checkout/v1/store/inventory`,
  which the petstore does not serve. [§4](#4-policies) attaches `rewrite` and the call starts
  working. This is the first thing that will look broken and is not.
- **Nothing is synchronous.** Publish, Save changes and Promote all return an *operation*. The bell in
  the top bar counts the ones in flight; **Activity** lists them. A change is only on the gateway when
  its operation reads `complete`, which needs *both* DEV gateways to have polled. Give it a few
  seconds and refresh — never conclude from the first call.

---

## 0. Getting a stack up

```bash
bun install
```

```bash
bun run build:ui
```

`stack.ps1 -Up` does not return — start it in a background terminal and confirm with `-Status`:

```bash
pwsh -File scripts/stack.ps1 -Up -Rebuild
```

```bash
pwsh -File scripts/stack.ps1 -Status
```

- [ ] Nine pieces report `up`: `backend` `:9080`, `backend-2` `:9081`, `mcp` `:9085`, `a2a` `:9086`,
      `control` `:8080`, `dev-1` `:8081`, `dev-2` `:8082`, `test-1` `:8083`, `prod-1` `:8084`.

**Configuration changes need a full `-Down` then `-Up`**, not a restart of one process.

| | |
|---|---|
| Portal | <http://localhost:8080> |
| Sign-in | development bypass — one click as Alice, Pavel or Clara |
| **Alice Admin** | administrator, member of both applications |
| **Pavel Publisher** | member of **Platform APIs** (`application_platform`) |
| **Clara Consumer** | member of **Orders** (`application_orders`) |
| REST upstream | `http://127.0.0.1:9080/v2` — `/store/inventory`, `/pet/findByStatus`, `/echo`, `POST /pet` |
| Second REST upstream | `http://127.0.0.1:9081/v2` — every response carries `x-backend-instance` |
| SOAP upstream | `http://127.0.0.1:9080/soap/petstore`, WSDL at `?wsdl` |
| MCP upstream | `http://127.0.0.1:9085/mcp` |
| A2A upstream | `http://127.0.0.1:9086` |

The three upstreams know nothing about this platform. Publishing them must not require changing them.

In PowerShell use **`curl.exe`** — bare `curl` is an alias for `Invoke-WebRequest` and takes different
arguments.

---

## 1. The shell

Sign in as **Pavel**.

- [ ] The address becomes `/application_platform/dashboard`. The sidebar shows the application picker
      reading **Platform APIs**, then **API**, **Kafka**, **Other**, **Global**.
- [ ] The top bar carries a chip reading **Integrations simulated**. It is there on every screen.
- [ ] Dashboard shows three counts (Published APIs, Subscriptions, Changes in progress), recent
      activity and a card about the application.
- [ ] The environment segmented control reads **DEV / TEST / PROD**, DEV selected.
- [ ] **No Administration group.** Pavel is not an admin.
- [ ] Type `/telemetry` into the address bar. It is refused or empty — but reachable, not a blank page.
- [ ] Toggle the theme button (**Dark** / **Light**). Reload — the choice survives.
- [ ] Narrow the window to phone width. The sidebar collapses behind **☰** and the toggle opens it.

Sign out, sign in as **Alice**.

- [ ] An **Administration** group appears: Applications, People, Telemetry, Global policy, Trust, Audit.
- [ ] The application picker offers **both** Platform APIs and Orders.
- [ ] Every link in **Global** and **Administration** opens a screen with a title and a one-line
      purpose under it. None 404s, none is blank.

---

## 2. Publish a REST API

As **Pavel**, application **Platform APIs**. Sidebar → **APIs** → **Publish API**.

- [ ] **API name** `checkout`. Try `Checkout` first — the field rejects capitals.
- [ ] **Type** `REST`. **Version** is pre-filled `v1`; leave it (§9 uses the other path to a version).
- [ ] **Product** → *Create a product*, **New product name** `checkout-product`.
- [ ] **DEV backend URL** `http://127.0.0.1:9080/v2`.
- [ ] **Public path** — leave blank and watch the placeholder read `/checkout`.
- [ ] **Definition source** → *Upload or paste definition*, and paste:

```yaml
openapi: 3.0.0
info: { title: checkout, version: 1.0.0 }
paths:
  /store/inventory:
    get:
      operationId: getInventory
      responses: { "200": { description: ok } }
  /pet:
    post:
      operationId: addPet
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, photoUrls]
              properties:
                name: { type: string }
                photoUrls: { type: array, items: { type: string } }
      responses: { "200": { description: ok } }
```

- [ ] **Publish to DEV**. The browser lands on the API workspace.
- [ ] The **Operations** card under the definition lists `getInventory` and `addPet`.
- [ ] **Deployment progress** shows one operation. Within a few seconds it reads **complete** — not
      before both DEV gateways have polled.
- [ ] **Activity** in the sidebar lists the same operation. So does the bell.
- [ ] The header line names the application, the kind and **Products: checkout-product**.

### Call it

```bash
curl.exe -i http://localhost:8081/checkout/store/inventory
```

- [ ] **401** — a subscription key is required. The default policy attaches `auth.subscriptionKey`.
- [ ] `curl.exe -i http://localhost:8082/checkout/store/inventory` — the *other* DEV gateway answers
      the same. Both are serving; the fleet is not one process.

### The failure that is not a failure

- [ ] `curl.exe -i http://localhost:8083/checkout/store/inventory` → **404**. TEST has never had this
      API. Editing DEV did not touch TEST. Keep this in mind for §6.

---

## 3. Subscribe to your own product

Still Pavel. Sidebar → **APIs** → the **Subscribe** button on the `checkout` row.

- [ ] The dialog says who it is requesting on behalf of, and in which environment.
- [ ] **Product** offers `checkout-product`. **Purpose** refuses fewer than 3 characters.
- [ ] Submit. The result panel shows a status of **activating**, not *active* — the entitlement has
      not reached a gateway yet.
- [ ] Sidebar → **Subscriptions**. The row reads **activating**, then **active** a few seconds later.
- [ ] **Show keys** reveals a primary and a secondary key. Copy the primary.
- [ ] **Rotate secondary key**, then reveal again — the secondary changed and the primary did not.

```bash
$key = "<paste the primary key>"
```

```bash
curl.exe -i -H "X-Api-Key: $key" http://localhost:8081/checkout/store/inventory
```

- [ ] **404 from the backend**, not 401. The key worked; the *path* did not — the gateway forwarded
      `/checkout/store/inventory` and the petstore serves `/v2/store/inventory`. §4 fixes it.

---

## 4. Policies

The API workspace → **policies** tab.

### The form

- [ ] **API access** → *Public access*. **Save changes**. Wait for complete.
- [ ] `curl.exe -i http://localhost:8081/checkout/store/inventory` → no longer 401.
- [ ] Set it back to **Require subscription key**, save, and confirm 401 returns.
- [ ] **Rate limit** → *Limit each subscription*. Set **Calls per gateway** `3`, **Period** `10`. Save.
- [ ] **Backend timeout** — set `1`, save, call with the key, and see the gateway give up. Set it back
      to `30000`.

### Advanced settings

Expand **Advanced settings** and edit the JSON directly. Replace it with:

```json
{
  "auth.subscriptionKey": { "in": "header", "name": "X-Api-Key", "forwardCredentials": false },
  "rewrite": { "stripBasePath": true },
  "rateLimit": { "calls": 3, "periodSec": 10, "per": "instance", "by": "subscription", "scope": "route", "emitHeaders": true },
  "preconditions": [
    {
      "requireHeader": { "name": "X-Request-Origin", "equals": "skoda-portal" },
      "deny": { "status": 403, "reason": "Forbidden - missing or invalid X-Request-Origin header" }
    }
  ]
}
```

- [ ] The form controls above update to match — they read the same document.
- [ ] Put a syntax error in the JSON. The form is replaced by *Correct the advanced settings JSON to
      use these controls*, and **Save changes** reports the failure rather than swallowing it.
- [ ] Fix it and save. Wait for complete.

### Call it at each rung

```bash
curl.exe -i http://localhost:8081/checkout/store/inventory
```
- [ ] **401**, no key.

```bash
curl.exe -i -H "X-Api-Key: $key" http://localhost:8081/checkout/store/inventory
```
- [ ] **403**, and the body carries the reason the policy configured — not a generic refusal.

```bash
curl.exe -i -H "X-Api-Key: $key" -H "X-Request-Origin: skoda-portal" http://localhost:8081/checkout/store/inventory
```
- [ ] **200**, proxied. `rewrite` stripped the base path, so the backend saw `/v2/store/inventory`.
- [ ] Run it four times inside ten seconds → the fourth is **429** with `Retry-After`.
- [ ] Run that fourth call against **`:8082`** instead → **200**. Rate limiting is per instance, so the
      fleet ceiling is `calls × instances`. Check the portal says so where it configures it.

### Validation is on by default

```bash
curl.exe -i -X POST http://localhost:8081/checkout/pet -H "X-Api-Key: $key" -H "X-Request-Origin: skoda-portal" -H "Content-Type: application/json" --data '{"name":42}'
```

- [ ] **400** before the backend is called, naming the failing pointers: `/photoUrls` is required and
      `/name` is not a string. **No validation unit is attached** — absence is not "off", it is "at the
      defaults", and the default is blocking.
- [ ] Add `"validate": { "request": "warning", "response": "disabled" }` to Advanced settings and save.
      It is **refused**: a downgrade needs a reason.
- [ ] Add `"downgradeReason": "INT-4412: the vendor posts an undeclared field"` and save. The same call
      now returns **200**.
- [ ] As **Alice** → **Global policy** or **Trust**, find the downgrade listed with its reason.
- [ ] Remove the `validate` unit and confirm the **400** comes back.

---

## 5. Cross-application subscription and approval

Sign in as **Clara** (Orders). Sidebar → **Catalog**.

- [ ] `checkout` is listed even though Clara does not own it, with Platform APIs named as its owner.
- [ ] **Subscribe** → product `checkout-product`, purpose `Order processing`. Submit.
- [ ] The status is **pending**, not activating. The panel says publisher approval is required through
      simulated SkoNET.
- [ ] **Subscriptions** shows the row as **pending** with no **Show keys** button.

```bash
curl.exe -i -H "X-Api-Key: <a key that does not exist>" http://localhost:8081/checkout/store/inventory
```

- [ ] **401.** A pending request has produced no usable credential. Confirm in the portal that no key
      is revealable while pending.

Sign in as **Pavel**. Sidebar → **Approvals**.

- [ ] The request is listed, showing Orders as the consumer and the purpose Clara typed.
- [ ] **Review request** → **Reject** with a reason. The row becomes rejected.
- [ ] As Clara, request again with a different purpose — allowed, and the rejected row is still there
      with its decision. History is not overwritten.
- [ ] As Pavel, **Approve** this one.
- [ ] As Clara, the row goes **activating** → **active**. Only now does **Show keys** appear.
- [ ] Reveal the key and call the gateway with it — **200** (with the origin header).
- [ ] As **Pavel**, open the same subscription. He can **Revoke** it and *cannot* reveal its keys — a
      publisher ends the relationship without reading it.
- [ ] Revoke. The row reads **revoking**, then **revoked**.
- [ ] Call the gateway with Clara's key again → **401**. The revocation reached the gateway on its own.

---

## 6. Promotion: DEV → TEST → PROD

As **Pavel**, on the `checkout` workspace with **DEV** selected.

- [ ] **Promote to TEST**. The dialog asks for a TEST backend URL and says it is required for the
      first promotion. Submit it empty → refused, in the server's words.
- [ ] Enter `http://127.0.0.1:9080/v2` and promote.
- [ ] The environment switches to TEST. Deployment progress shows the promotion.
- [ ] Wait for **complete**, then call TEST:

```bash
curl.exe -i -H "X-Request-Origin: skoda-portal" http://localhost:8083/checkout/store/inventory
```

- [ ] **401** — the policy travelled with the API. TEST keys are different from DEV keys.
- [ ] Subscribe in TEST (switch the environment control first) and call again → **200**.
- [ ] **You were never shown a plan to confirm, a release, a revision, a digest or a `planId`.** One
      button, one form, one submission.

### The environments are independent

- [ ] Switch to **DEV**, **properties** tab, change the backend URL to `http://127.0.0.1:9081/v2`, save.
- [ ] Call DEV → responses now carry a different `x-backend-instance`. Call TEST → unchanged.
- [ ] Switch to **TEST** → **Promote to PROD**, backend `http://127.0.0.1:9080/v2`.
- [ ] Call `:8084` once complete. PROD serves; DEV and TEST are untouched.
- [ ] On **DEV**, the promote button offers TEST; on **PROD** there is no next environment and no button.

### Promotion captures its source

- [ ] On DEV, edit the definition (add a path), and **immediately** — before it completes — switch to
      TEST and promote.
- [ ] What lands in TEST is what DEV had **when you pressed promote**, not the edit still in flight.
      Check the definition on TEST after both operations complete.

---

## 7. Client certificates

As **Pavel** → sidebar → **Certificates** (this is the Trust screen scoped to your application).

Generate a throwaway pair to upload — any self-signed pair will do:

```bash
bun -e "const {generateCertificate}=await import('./test/x509.ts');const c=generateCertificate({cn:'checkout-client'});await Bun.write('.data/client.crt',c.certPem);await Bun.write('.data/client.key',c.keyPem);console.log('written to .data/')"
```

- [ ] **Client certificates** is the tab you land on, and it lists only **your application's**
      certificates.
- [ ] **Upload a certificate**: Application is read-only and pre-filled; Environment is read-only and
      follows the environment switcher. Name it `checkout-client`, paste the cert and the key.
- [ ] Upload a cert with a **mismatched key** → refused at upload, not at first handshake.
- [ ] The row shows subject, issuer, expiry as a day count, thumbprint, and **Used by: nothing**.
- [ ] The private key is **never** shown back anywhere on the screen.

### Attach it

- [ ] API workspace → **properties** → **Client certificate** offers `checkout-client`. Select it, save.
- [ ] Back on **Certificates**, the row's **Used by** now names `checkout` and its environment.
- [ ] Try to delete it → the danger zone refuses and says how many bindings name it.
- [ ] Switch the environment control to **TEST**. The certificate list is empty — certificates are
      environment-scoped material and DEV's does not exist in TEST.
- [ ] On the TEST workspace → properties, the certificate is **not** offered. Promotion did not copy it.
- [ ] Detach it on DEV (select *No client certificate*), save, then delete it. The danger zone wants
      the name typed back.

### The handshake, against a backend that actually demands one

Everything above would pass whether or not the gateway presents anything. This part is the one that
can fail. Start a petstore that refuses any client it cannot verify:

```bash
bun run tools/backend/server.ts --port=9099 --mtls
```

It generates two separate authorities and prints where it put them: `.data/backend-ca.pem` is the CA
that signed **its** certificate, and `.data/backend-client.crt` / `.data/backend-client.key` are the
client identity **you** upload.

- [ ] Confirm the backend really refuses an anonymous client:
      `curl.exe -i --cacert .data/backend-ca.pem https://localhost:9099/v2/store/inventory`
      → no HTTP status at all, exit code 55. The connection is refused, not the request.
- [ ] The same call with `--cert .data/backend-client.crt --key .data/backend-client.key` → **200**,
      carrying `x-backend-mtls: verified`.

Now do it through the gateway.

- [ ] As **Alice** → **Trust** → *Certificate authorities* → register `.data/backend-ca.pem` for
      **DEV**. The preview names the CA before it is trusted. Do **not** add a TLS exception.
- [ ] As **Pavel**, on the `checkout` workspace in DEV → **properties** → set the backend to
      `https://localhost:9099/v2`. Save, wait for complete.
- [ ] Call it → **502**. The gateway verifies the backend fine; the backend will not accept *us*.
- [ ] **Certificates** → upload `.data/backend-client.crt` and `.data/backend-client.key` as
      `gateway-client`.
- [ ] **properties** → **Client certificate** → `gateway-client`. Save, wait for complete.
- [ ] Call it → **200**, with `x-backend-mtls: verified` in the response. Mutual TLS, with **no TLS
      exception anywhere** — verification in both directions, not a hole in it.
- [ ] Detach the certificate again, save, and confirm the **502** comes back. That is the assertion:
      the setting is falsifiable.
- [ ] Switch to **TEST** and confirm it never saw any of this — no anchor, no certificate, and the
      TEST backend unchanged.

`test/trust-anchors.test.ts` runs this same sequence headlessly if you want it in CI.

---

## 8. Load balancing and the circuit breaker

On the `checkout` workspace in **DEV** → **properties**. Put the backend back to
`http://127.0.0.1:9080/v2` first if §7 left it on the mTLS port.

- [ ] The backend field is a **list** headed *DEV backends*, with one row and an **Add backend**
      button — one member reads as one field, and the second appears only when asked for.
- [ ] **Add backend** → `http://127.0.0.1:9081/v2`.
- [ ] **When there is more than one backend** → *Round-robin — spread calls across them*. A weight box
      appears on each row, and a line explains that each gateway keeps its own place in the rotation.
- [ ] Save. Wait for complete.

```bash
1..6 | ForEach-Object { curl.exe -s -o NUL -D - -H "X-Api-Key: $key" -H "X-Request-Origin: skoda-portal" http://localhost:8081/checkout/store/inventory | Select-String x-backend-instance }
```

- [ ] `x-backend-instance` alternates between `petstore-9080` and `petstore-9081`. Use **one** gateway
      — the cursor is per instance, so two gateways interleave two independent round-robins and prove
      nothing.
- [ ] Set the first backend's weight to `3` and the second's to `1`, save, and run the six calls again
      → roughly three of the first for each of the second.
- [ ] Switch the rule to **Failover**, save. The weight boxes disappear, and every call goes to the
      first member.
- [ ] **Remove** is disabled when only one member is left — a route with no backend is not a state the
      form can reach.
- [ ] Add nine members → **Add backend** disables at eight, and the server refuses a ninth with the
      reason if you get one past the form.
- [ ] Set a weight under **Failover** through the API and confirm it is refused, saying weights only
      mean something under round-robin — the form and the API agree because they read the same
      validator (`control-plane/src/backend-pool.ts`).

### The breaker

The breaker and retries are policy units, so they live in **Advanced settings** on the policies tab:

```json
{
  "circuitBreaker": { "failures": 3, "windowSec": 60, "openSec": 20, "halfOpenProbes": 1 },
  "retries": { "attempts": 1, "on": ["502", "503", "504", "timeout", "connect"], "idempotentOnly": true }
}
```

- [ ] Merge those two into the existing document, save, and wait for complete.
- [ ] Stop `backend-2` (`:9081`). Calls keep succeeding on round-robin — after three failures the
      breaker takes the dead member out and the survivor answers every call.
- [ ] Bring `backend-2` back. Within `openSec` the half-open probe returns it to the rotation, and
      `x-backend-instance` starts alternating again. Nobody clicked anything.
- [ ] Stop **both** backends → **502**, and the gateway says it could not reach the backend rather
      than pretending.

---

## 9. Versioning

On the `checkout` workspace, in **DEV** — a new version is published where publishing starts.

- [ ] Switch the environment to **TEST**. Where **New version** would be there is a sentence saying it
      starts in DEV and to switch environment. The reason is on the screen, not in a tooltip.
- [ ] Switch back to **DEV**. **New version** is there, beside Promote.
- [ ] Open it. The identifier is pre-filled **v2** — the next in the series, not a blank box.
- [ ] The public path is pre-filled `/checkout/v2`, and it **changes with the identifier** as you
      type. Both versions serve at once, so they cannot share a path.
- [ ] The dialog says what carries over (the definition on screen, the DEV backends, the policies)
      and what does not (subscriptions, anything set in a later environment).
- [ ] **Product** offers the application's active products, defaulting to `checkout-product`.
- [ ] Publish. You land on the new API's workspace, and it is a **different** API — its own id in the
      address bar.
- [ ] A **Version** switcher appears on both workspaces now, listing v1 and v2. Use it to jump between
      them.
- [ ] The header line reads the version alongside the kind and the products.

### Both serve at once

```bash
curl.exe -s -o NUL -w "v1=%{http_code} " -H "X-Api-Key: $key" -H "X-Request-Origin: skoda-portal" http://localhost:8081/checkout/store/inventory; curl.exe -s -o NUL -w "v2=%{http_code}" http://localhost:8081/checkout/v2/store/inventory
```

- [ ] v1 answers on its path and v2 on its own. Neither replaced the other.
- [ ] The v1 key does **not** open v2 — they are in different products. Subscribe to
      `checkout-product` (which now holds both, if you picked it) or to v2's own product, and check
      which one the key actually opens.
- [ ] The API list shows two rows with the same name and different versions.
- [ ] Publish a *third* API named `checkout` at `v2` from the publish form → **409**, name and version
      already exist. The **Version** field on that form is what lets you say something else.
- [ ] Promote v2 to TEST. v1 in TEST is untouched.

---

## 10. SOAP

As **Pavel** → **APIs** → **Publish API**.

Fetch the WSDL first:

```bash
curl.exe -s "http://127.0.0.1:9080/soap/petstore?wsdl" | Set-Content .data/petstore.wsdl
```

- [ ] Name `petstore-soap`, **Type** `SOAP`, new product `soap-product`, backend
      `http://127.0.0.1:9080/soap/petstore`, public path `/petstore-soap`.
- [ ] Paste the WSDL (or use the file picker — it accepts `.wsdl` and `.xml`).
- [ ] Publish. The **Services** card under the definition lists the WSDL's services and operations —
      the SOAP equivalent of the operations table, not an empty panel.
- [ ] Add `"rewrite": {"stripBasePath": true}` in Advanced settings and save.
- [ ] Subscribe and reveal a key.

```bash
curl.exe -i -X POST http://localhost:8081/petstore-soap -H "Content-Type: text/xml" -H "SOAPAction: `"urn:apim:petstore:GetPet`"" -H "X-Api-Key: $key" --data-binary '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId></tns:GetPetRequest></soap:Body></soap:Envelope>'
```

- [ ] **200** with a `GetPetResponse`.
- [ ] Change the `SOAPAction` to `urn:apim:petstore:AddPet` while leaving the body alone → **400**. The
      declared action disagreeing with the body is a routing and authorization bypass.
- [ ] The refusal is a **SOAP Fault** carrying the real HTTP status, not a JSON problem document.
- [ ] Send `<tns:petId>banana</tns:petId>` — the WSDL's inline schema says integer → a fault.
- [ ] Drop the key → **401**, also as a fault. A SOAP client cannot read JSON.
- [ ] Promote it to TEST and repeat one call against `:8083`.

---

## 11. MCP

As **Pavel** → **Publish API**.

- [ ] Name `petstore-mcp`, **Type** `MCP`, new product `mcp-product`, backend
      `http://127.0.0.1:9085/mcp`, public path `/petstore-mcp`.
- [ ] **Definition source** → *Import from URL*, and give `http://127.0.0.1:9085/mcp`. For MCP this is
      a **discovery** URL — the portal connects and reads the server's own tool list.
- [ ] Publish. The definition that comes back is the discovered tool set, not something you typed.
- [ ] Add `rewrite` in Advanced settings, save, subscribe, reveal a key.
- [ ] Sidebar → **MCP Servers** lists it, and the row is absent from the plain **APIs** view's SOAP/REST
      framing — the kind filter works.

```bash
curl.exe -i -X POST http://localhost:8081/petstore-mcp -H "X-Api-Key: $key" -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

- [ ] **200**, and the response carries an `Mcp-Session-Id` header. Keep it.
- [ ] Send `tools/list` with `-H "Mcp-Session-Id: <id>"` → the server's declared tools.
- [ ] Call a tool the server never declared → JSON-RPC **-32601**.
- [ ] Call a declared tool with arguments its own schema rejects → **-32602**, *before* the server is
      reached.
- [ ] Drop the key → **401 as a JSON-RPC error, not a problem document.** An MCP client cannot read a
      problem document, and a gateway that answers in one has broken the protocol it claims to speak.

---

## 12. A2A

As **Pavel** → **Publish API**.

- [ ] Name `shelter`, **Type** `A2A`, new product `a2a-product`, backend `http://127.0.0.1:9086`,
      public path `/shelter`.
- [ ] **Import from URL** `http://127.0.0.1:9086` — the portal fetches the agent's own card.
- [ ] Publish, add `rewrite`, subscribe, reveal a key.
- [ ] Sidebar → **A2A Agents** lists it.

```bash
curl.exe -s http://localhost:8081/shelter/.well-known/agent-card.json
```

- [ ] **200 without a key** — discovery has to be open.
- [ ] The card's `url` is **the gateway**, not `http://127.0.0.1:9086`. Compare with the origin's own
      card at `curl.exe -s http://127.0.0.1:9086/.well-known/agent-card.json`.
- [ ] Its security schemes are the gateway's too, so an agent that follows this card brings a
      subscription key and arrives at every policy on the route. That rewrite is the whole reason
      publishing an agent differs from proxying one.
- [ ] Send a message method with the key → **200**. Without the key → **401**.

---

## 13. The playground

On any published API's workspace → **playground** tab.

- [ ] For the REST API, the operations from the definition are listed; pick `getInventory` and send.
- [ ] A real response comes back, and the echoed request **does not contain the key**.
- [ ] The call appears in *Your calls* below, and survives a reload.
- [ ] On an API you have no subscription to, the panel offers **Subscribe** rather than failing.
- [ ] Sign in as **Clara** and open an API owned by Platform APIs: the editing controls are present but
      **disabled, with the reason beside them** — not hidden, not throwing.

---

## 14. Kafka (simulated)

As **Pavel** → sidebar → **Kafka Topics**.

- [ ] **Create topic**: name `orders.events`, partitions `3`, a description. Create.
- [ ] The row appears as **provisioning**, then **ready**. The panel title says **· simulated**.
- [ ] **Open topic** → change the description, raise partitions to `6`, **Save topic**. Reopen — it kept
      both.
- [ ] Try to *lower* partitions → refused; a topic may only gain them.
- [ ] **Enable REST proxy**, then check sidebar → **Kafka REST Proxy** lists it and did not before.
- [ ] Request access with a purpose. As the owner it goes **activating** → **active** without approval.
- [ ] Once active, the modal offers **produce** / **consume**. Produce `hello`, then consume — the
      message comes back with an offset.
- [ ] As **Clara** (Orders), request access to the same topic → **pending**, and it appears in Pavel's
      **Approvals** beside the API request. Approve it and watch it activate.
- [ ] Try to delete the topic while access exists → refused, saying to withdraw access first.
- [ ] Withdraw both, then delete. The danger zone wants the topic name typed back.

---

## 15. The six mocked integrations

As **Pavel** → sidebar → **Integrations**.

- [ ] Three buttons: **Refresh LeanIX metadata**, **Look up application contacts**, **Run FixMe
      diagnostics**.
- [ ] Each one adds an entry to *Integration activity and mock mailbox* with a state and, expanded,
      the request and the response as JSON.
- [ ] LeanIX returns the application name, a business id, a description and an owner contact.
- [ ] LdapWS returns the application's members with their emails.
- [ ] FixMe returns numbered steps and a summary that says **no infrastructure was changed**.
- [ ] The **FixMe** entry in the Global group shows the same thing filtered to FixMe only.
- [ ] Every result is marked simulated. Nothing here suggests a real service was contacted.
- [ ] Scroll the activity list: the **email** entries from §5's approval flow are there, with recipient,
      subject and body — captured, never sent.
- [ ] The **skonet** entries carry a tracking reference.
- [ ] Reload the page, and restart the control plane (`-Down` then `-Up`). **Every entry is still
      there.** These are persisted workflow state, not a frontend log.

---

## 16. Convergence and honest progress

The claims worth attacking, since the whole design rests on them.

### An offline gateway

- [ ] Kill `dev-2` (find its pid via `scripts/stack.ps1 -Status`, or stop the process).
- [ ] Make any change — a policy edit, save.
- [ ] The operation sits at **waiting for gateways** and does **not** report complete. `dev-1` is
      serving the change; the operation is honest that the fleet is not.
- [ ] As **Alice** → **Health Status**: `dev-2` is visibly stale or absent.
- [ ] Restart the stack's `dev-2`. Within a poll or two the operation flips to **complete** **without
      anybody clicking retry**.

### A restart

- [ ] Make a change and, immediately, `pwsh -File scripts/stack.ps1 -Down`.
- [ ] `-Up` again. The operation is still listed, still in its state, and converges on its own.
- [ ] Nothing was submitted twice: the API has one release for that environment, not two.

### A blocked operation

- [ ] Publish an API with a backend URL that no allowlist permits, or one that cannot resolve.
- [ ] The refusal lands **before** the operation is accepted where the value is knowably wrong, and as
      a **Blocked** operation with an explanation where it is not.
- [ ] A blocked operation keeps its desired state — it does not vanish and does not ask you to redo
      technical steps.

### Idempotency

- [ ] Press **Publish to DEV** twice quickly on the same form. One API is created, not two.
- [ ] Submit, let it fail (bad backend), fix the field, submit again → this is a *new* command and is
      accepted, not rejected as a duplicate.

---

## 17. Administration

As **Alice**.

- [ ] **Applications** — both applications, who is in each, and how they got there (granted here, or
      from an identity-provider group), with who granted it and when.
- [ ] **People** — every account, its provider, and what it can do. Create a local account.
- [ ] Sign in as the new account: it must **choose a password before it can do anything else**.
- [ ] It is in no application. The owner screens say so and name who can fix it — rather than being
      empty, absent, or throwing. The catalog is still readable.
- [ ] As Alice, add it to Orders. Sign in again — what it can do changed with the membership.
- [ ] Remove the membership. Server-side, the ability goes with it — not just the menu item.
- [ ] Try to remove your **own** administrator role as the only administrator → refused, saying you are
      the last one and that the way forward is to make somebody else an administrator first.
- [ ] **Gateways / Health Status** — every instance, the digest it is running, and the fleet's.
- [ ] **Telemetry** — calls per minute: served, refused by the gateway, failed upstream. The calls you
      made above are in it.
- [ ] **Global policy** — attach a `cors` unit to the whole DEV environment. An API that sets its own
      `cors` **wins**; one that does not **inherits**. Check both, then detach it.
- [ ] **Trust** → *Certificate authorities* — register a CA PEM for DEV only. The preview says what the
      PEM is before it is trusted, and the anchor lists the environments it is live in. TEST is
      untouched.
- [ ] **Trust** → *TLS exceptions* — an exception needs an end date under the ceiling and a reason long
      enough to be one. The governance report lists every backend not fully verified.
- [ ] **Audit** — every change above is there, with who did it, on whose behalf, and what happened.
      Find your own approval decision from §5 and confirm it records which side made it.

---

## 18. The things that are easy to get right in a demo

...and wrong in a product. Spot-check these anywhere.

- [ ] Every screen states its purpose in one line under the title, including ones reached by accident.
- [ ] Which environment you are in is never ambiguous, and the switcher is above the content it changes.
- [ ] Nothing you cannot do is hidden. Controls are present, disabled, with the reason **beside** them
      rather than in a tooltip.
- [ ] Nothing destructive is one click away. Every delete, revoke and withdraw is folded shut and wants
      the object's name typed back, with a sentence saying what stops working.
- [ ] Every empty state offers the next step. A brand-new account never reaches a screen that only says
      "nothing here".
- [ ] Errors land where the decision was made, in the server's own words.
- [ ] Every simulated result is labelled simulated.
- [ ] Keyboard only: tab to every control in a form and submit it. Nothing clickable is unreachable.
- [ ] No key material appears in any URL, and no key is shown to anybody but the consuming application.

---

## What to record

For each failure: the section, what you did, what you expected, what happened, and whether the control
plane accepted it (Activity) but the gateway did not serve it — that distinction is the one that
matters most here, and the one a screenshot alone will not carry.
