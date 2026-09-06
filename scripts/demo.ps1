<#
.SYNOPSIS
  The walkthrough, in two acts.

  Act one proves the gateway: three environments and promotion, two versions live at once, four
  gateways, SOAP, request validation, a backend pool with a circuit breaker, the environment-wide
  policy tier, an MCP server and an A2A agent published as APIs, the Catalog, streaming, and the
  telemetry the run itself produced.

  Act two proves the portal: the six journeys the UI names on "How this works" — publish, promote,
  version, subscribe, call it from here, run the platform — walked in that order through exactly
  the endpoints the screens call, ending with an internal certificate authority registered per
  environment and the console's own call read back out of telemetry, history and audit.

.DESCRIPTION
  Everything the gateway is asked to do is done with curl.exe, because the goal is that a
  consumer can call the API with curl and see the policies enforced. Control-plane steps use the
  HTTP API the UI uses.

  Re-runnable: it deletes its own objects first, by (name, apiVersion), because names now repeat
  across versions.

.EXAMPLE
  pwsh -File scripts/stack.ps1 -Up
  pwsh -File scripts/demo.ps1
  pwsh -File scripts/demo.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch] $Remove,
  [string] $ControlPlane = "http://localhost:8080",
  [string] $Backend = "http://127.0.0.1:9080",
  [string] $Backend2 = "http://127.0.0.1:9081",
  [string] $McpServer = "http://127.0.0.1:9085/mcp",
  [string] $A2aAgent = "http://127.0.0.1:9086",
  # Act two starts its own TLS backend on this port: goal G4 needs a backend whose certificate
  # comes from an authority no public store has heard of, which is not something the shared stack
  # can leave running without also leaving its CA registered.
  [int] $TlsBackendPort = 9082
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$Gateways = @{ dev = "http://localhost:8081"; dev2 = "http://localhost:8082";
               test = "http://localhost:8083"; prod = "http://localhost:8084" }
$script:Failures = 0
$script:Checks = 0

# ------------------------------------------------------------------ small helpers

function Section { param([string] $Title) Write-Host ""; Write-Host "== $Title" -ForegroundColor Cyan }

function Check {
  param([string] $What, $Actual, $Expected)
  $script:Checks++
  if ("$Actual" -eq "$Expected") {
    Write-Host ("  ok   {0,-58} {1}" -f $What, $Actual) -ForegroundColor Green
  } else {
    $script:Failures++
    Write-Host ("  FAIL {0,-58} {1} (expected {2})" -f $What, $Actual, $Expected) -ForegroundColor Red
  }
}

function Note { param([string] $Text) Write-Host "       $Text" -ForegroundColor DarkGray }

$script:Session = $null
function Login {
  param([string] $UserId)
  $body = @{ userId = $UserId } | ConvertTo-Json
  Invoke-RestMethod -Uri "$ControlPlane/api/auth/dev-login" -Method Post -Body $body `
    -ContentType "application/json" -Headers @{ Origin = $ControlPlane } `
    -SessionVariable session | Out-Null
  $script:Session = $session
}

function Api {
  param(
    [string] $Method,
    [string] $Path,
    $Body = $null,
    [string] $IfMatch = $null,
    [switch] $AllowFailure
  )
  $headers = @{ Origin = $ControlPlane }
  if ($IfMatch) { $headers["If-Match"] = $IfMatch }
  $args = @{
    Uri = "$ControlPlane$Path"; Method = $Method; Headers = $headers; WebSession = $script:Session
  }
  if ($null -ne $Body) {
    $args.Body = ($Body | ConvertTo-Json -Depth 12 -Compress)
    $args.ContentType = "application/json"
  }
  try {
    return Invoke-RestMethod @args
  } catch {
    if ($AllowFailure) { return $null }
    $detail = ""
    try { $detail = $_.ErrorDetails.Message } catch { }
    throw "$Method $Path failed: $($_.Exception.Message) $detail"
  }
}

# curl.exe, not Invoke-WebRequest: the goal is that a consumer calls the gateway with curl.
function Curl {
  param([string] $Url, [string[]] $ExtraArgs = @())
  $bodyFile = [System.IO.Path]::GetTempFileName()
  $headerFile = [System.IO.Path]::GetTempFileName()
  $arguments = @("-s", "-o", $bodyFile, "-D", $headerFile, "-w", "%{http_code}") + $ExtraArgs + @($Url)
  $status = & curl.exe @arguments
  $result = [pscustomobject]@{
    Status  = [int] $status
    Body    = (Get-Content $bodyFile -Raw -ErrorAction SilentlyContinue)
    Headers = (Get-Content $headerFile -Raw -ErrorAction SilentlyContinue)
  }
  Remove-Item $bodyFile, $headerFile -Force -ErrorAction SilentlyContinue
  return $result
}

function HeaderValue {
  param([string] $Headers, [string] $Name)
  foreach ($line in ($Headers -split "`r?`n")) {
    if ($line -match "^(?i)$([regex]::Escape($Name))\s*:\s*(.+)$") { return $Matches[1].Trim() }
  }
  return $null
}

function Wait-Fleet {
  param([string] $Environment, [int] $TimeoutSec = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $health = Api GET "/api/targets/$Environment/health"
    if ($health.inSync) { return $health }
    Start-Sleep -Milliseconds 400
  }
  throw "the $Environment fleet did not converge within ${TimeoutSec}s"
}

function Find-Resource {
  param([string] $Name, [string] $ApiVersion)
  $list = Api GET "/api/resources?application=application_platform&name=$Name"
  return $list.items | Where-Object { $_.apiVersion -eq $ApiVersion } | Select-Object -First 1
}

function Remove-Demo {
  # Revoke first: a product holding live subscriptions refuses to be deleted, because a consumer's
  # next call would otherwise become an unexplained 404.
  Login "clara"
  $subscriptions = Api GET "/api/subscriptions"
  foreach ($subscription in $subscriptions.items) {
    if ($subscription.state -eq "active") {
      Api DELETE "/api/subscriptions/$($subscription.id)" -AllowFailure | Out-Null
    }
  }
  Login "pavel"

  foreach ($pair in @(@("petstore", "v1"), @("petstore", "v2"), @("petstore-soap", "v1"),
                      @("petstore-mcp", "v1"), @("shelter-agent", "v1"),
                      @("walkthrough", "v1"), @("walkthrough", "v2"))) {
    $existing = Find-Resource -Name $pair[0] -ApiVersion $pair[1]
    if ($existing) {
      Api DELETE "/api/resources/$($existing.id)" -AllowFailure | Out-Null
      Write-Host "  removed $($pair[0]) $($pair[1])"
    }
  }
  $products = Api GET "/api/products"
  foreach ($productName in @("petstore-product", "petstore-soap-product", "agents-product",
                             "walkthrough-product")) {
    $product = $products.items | Where-Object { $_.name -eq $productName }
    if ($product) {
      Api DELETE "/api/products/$($product.id)" -AllowFailure | Out-Null
      Write-Host "  removed product $productName"
    }
  }
  Login "clara"
  $applications = Api GET "/api/applications"
  foreach ($applicationName in @("orders-app", "walkthrough-app")) {
    $application = $applications.items | Where-Object { $_.name -eq $applicationName }
    if ($application) {
      Api DELETE "/api/applications/$($application.id)" -AllowFailure | Out-Null
      Write-Host "  removed application $applicationName"
    }
  }

  # The global tier outlives every resource in it — that is the point of it — so a run that
  # attached one has to detach it, or the next run starts with dev already carrying a cors default.
  Login "alice"
  Api DELETE "/api/policy/global/units/cors?environment=dev" -AllowFailure | Out-Null

  # A trust anchor is dated rather than deleted, so a removed one is still listed and still counts
  # against nothing — but the previous run's certificate authority is one nobody trusts any more,
  # and leaving it live would let a later run pass on the wrong CA.
  foreach ($environment in @("dev", "test", "prod")) {
    $anchors = Api GET "/api/trust/anchors?environment=$environment" -AllowFailure
    foreach ($anchor in ($anchors.items | Where-Object { $_.name -like "demo-backend-ca*" })) {
      Api DELETE "/api/trust/anchors/$($anchor.id)" -AllowFailure | Out-Null
      Write-Host "  removed trust anchor $($anchor.name) from $environment"
    }
  }
  Login "pavel"
}

# ------------------------------------------------------------------ preflight

Section "preflight"
foreach ($entry in @(@("control plane", "$ControlPlane/healthz"), @("backend", "$Backend/healthz"),
                     @("backend-2", "$Backend2/healthz"),
                     @("mcp server", "http://127.0.0.1:9085/healthz"),
                     @("a2a agent", "$A2aAgent/healthz"),
                     @("gateway dev-1", "$($Gateways.dev)/healthz"),
                     @("gateway dev-2", "$($Gateways.dev2)/healthz"),
                     @("gateway test-1", "$($Gateways.test)/healthz"),
                     @("gateway prod-1", "$($Gateways.prod)/healthz"))) {
  try {
    Invoke-RestMethod -Uri $entry[1] -TimeoutSec 3 | Out-Null
    Write-Host "  up   $($entry[0])"
  } catch {
    throw "$($entry[0]) is not reachable at $($entry[1]). Start everything with: pwsh -File scripts/stack.ps1 -Up"
  }
}

Login "pavel"
Write-Host "  signed in as pavel (publisher, application_platform)"

if ($Remove) {
  Section "removing demo objects"
  Remove-Demo
  Write-Host ""
  Write-Host "done."
  exit 0
}

Section "cleaning up any previous run"
Remove-Demo

# ------------------------------------------------------------------ 1. create and import

Section "1. create petstore v1 and import the real swagger.io definition"
$v1 = Api POST "/api/resources" @{ kind = "rest"; name = "petstore"; applicationId = "application_platform"; apiVersion = "v1"; domain = "IT"; subdomain = "Solution" }
Note "resource $($v1.id)"
$revision = Api POST "/api/resources/$($v1.id)/revisions" @{ specUrl = "https://petstore.swagger.io/v2/swagger.json" }
Check "imported revision" $revision.rev 1
Note "the fetch passed the egress allowlist and followed no redirects (design section 5.3)"

# DEV points at the real petstore; TEST and PROD point at the local simulator. Backends are
# per environment (design section 6.1), and this is what that means in practice.
Api PUT "/api/resources/$($v1.id)/routes"  @{ environment = "dev"; host = "*"; basePath = "/it/solution/petstore/v1" } | Out-Null
Api PUT "/api/resources/$($v1.id)/binding" @{ environment = "dev"; urls = @("https://petstore.swagger.io/v2") } | Out-Null

Section "2. attach policies (check header, rate limit, key required)"
Api PUT "/api/resources/$($v1.id)/policy/units/auth.subscriptionKey" @{
  value = @{ in = "header"; name = "X-Api-Key"; forwardCredentials = $false }
} | Out-Null
Api PUT "/api/resources/$($v1.id)/policy/units/rewrite" @{ value = @{ stripBasePath = $true } } | Out-Null
Api PUT "/api/resources/$($v1.id)/policy/units/preconditions" @{
  value = @(@{
    requireHeader = @{ name = "X-Request-Origin"; equals = "skoda-portal" }
    deny = @{
      status = 403
      reason = "Forbidden - missing or invalid X-Request-Origin header"
      body = @{ statusCode = 403; message = "Forbidden - missing or invalid X-Request-Origin header" }
    }
  })
} | Out-Null
Api PUT "/api/resources/$($v1.id)/policy/units/rateLimit" @{
  value = @{ calls = 3; periodSec = 10; per = "instance"; by = "subscription"; scope = "route"; emitHeaders = $true }
} | Out-Null
Write-Host "  attached auth.subscriptionKey, rewrite, preconditions, rateLimit"

Section "3. publish to DEV"
$product = Api POST "/api/products" @{ name = "petstore-product"; applicationId = "application_platform"; resourceIds = @($v1.id) }
$release = Api POST "/api/resources/$($v1.id)/releases" @{ revision = 1; environment = "dev" }
Check "release converged" $release.state "converged"
$fleet = Wait-Fleet "dev"
Check "dev gateways in sync" $fleet.liveInstances 2
Note "two DEV gateways, so the effective rate limit is calls x instances (design section 5.7)"

Section "4. subscribe (a key per environment)"
Login "clara"
$application = Api POST "/api/applications" @{ name = "orders-app"; applicationId = "application_orders" }
$subDev = Api POST "/api/subscriptions" @{ productId = $product.id; applicationId = $application.id; environment = "dev" }
$devKey = $subDev.primaryKey
Check "dev subscription active" $subDev.state "active"
Note "key shown once: $devKey"
Login "pavel"
Start-Sleep -Seconds 3   # the config poll is 2s; the key has to reach the fleet

# ------------------------------------------------------------------ curl through the gateway

Section "5. call it with curl through the DEV gateway"
$noKey = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory"
Check "no api key -> 401" $noKey.Status 401

$badKey = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory" @("-H", "X-Api-Key: sk_dev_not-a-real-key")
Check "unknown api key -> 401" $badKey.Status 401

$noHeader = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory" @("-H", "X-Api-Key: $devKey")
Check "failed check-header -> 403" $noHeader.Status 403
Note "body: $($noHeader.Body.Trim())"

$ok = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
Check "key + header -> 200 from the real petstore" $ok.Status 200

Section "6. the rate limit (3 calls per 10s, per gateway)"
# Align to the next window so the calls above do not count against this one.
Start-Sleep -Milliseconds (10000 - ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() % 10000) + 200)
$statuses = @()
foreach ($i in 1..5) {
  $response = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory" @(
    "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
  $statuses += $response.Status
  if ($response.Status -eq 429) { $retryAfter = HeaderValue $response.Headers "Retry-After" }
}
Check "5 calls to one gateway" ($statuses -join ",") "200,200,200,429,429"
Note "Retry-After: $retryAfter"

$otherGateway = Curl "$($Gateways.dev2)/it/solution/petstore/v1/store/inventory" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
Check "the second DEV gateway has its own counter -> 200" $otherGateway.Status 200
Note "per-instance limiting is design section 5.7's trade: the fleet ceiling is calls x instances"

# ------------------------------------------------------------------ promotion

Section "7. promote DEV -> TEST -> PROD"
$straightToProd = Api POST "/api/resources/$($v1.id)/releases" @{ revision = 1; environment = "prod" } -AllowFailure
Check "dev straight to prod is refused" ($null -eq $straightToProd) $true
Note "the gate names the predecessor: revision 1 has not reached test"

foreach ($environment in @("test", "prod")) {
  $port = if ($environment -eq "test") { $Gateways.test } else { $Gateways.prod }
  Api PUT "/api/resources/$($v1.id)/routes"  @{ environment = $environment; host = "*"; basePath = "/it/solution/petstore/v1" } | Out-Null
  Api PUT "/api/resources/$($v1.id)/binding" @{ environment = $environment; urls = @("$Backend/v2") } | Out-Null

  $plan = Api POST "/api/resources/$($v1.id)/releases?dryRun=1" @{ revision = 1; environment = $environment }
  $seeded = ($plan.plan.policy.create | ForEach-Object { $_.unit }) -join ", "
  Note "$environment plan: creates [$seeded] from $($plan.plan.from)"
  $promoted = Api POST "/api/resources/$($v1.id)/releases" @{ revision = 1; environment = $environment; planId = $plan.planId }
  Check "promoted to $environment" $promoted.state "converged"
  Wait-Fleet $environment | Out-Null

  Login "clara"
  $sub = Api POST "/api/subscriptions" @{ productId = $product.id; applicationId = $application.id; environment = $environment }
  Login "pavel"
  Start-Sleep -Seconds 3
  $call = Curl "$port/it/solution/petstore/v1/store/inventory" @(
    "-H", "X-Api-Key: $($sub.primaryKey)", "-H", "X-Request-Origin: skoda-portal")
  Check "$environment gateway serves it -> 200" $call.Status 200
  Note "the seeded check-header policy travelled with the promotion and is enforced here"
  $denied = Curl "$port/it/solution/petstore/v1/store/inventory" @("-H", "X-Api-Key: $($sub.primaryKey)")
  Check "$environment enforces the seeded check-header -> 403" $denied.Status 403
}

# ------------------------------------------------------------------ versioning

Section "8. a second version, live beside the first"
$v2 = Api POST "/api/resources/$($v1.id)/versions" @{ apiVersion = "v2"; copyPolicyFrom = "dev"; createRoutes = $true }
Check "created petstore v2" $v2.apiVersion "v2"
Note "proposed base path $($v2.proposedBasePath), policy copied from dev as local units"
Api PUT "/api/resources/$($v2.id)/binding" @{ environment = "dev"; urls = @("$Backend/v2") } | Out-Null
Api PUT "/api/products/$($product.id)/members" @{ resourceIds = @($v1.id, $v2.id) } | Out-Null
$releaseV2 = Api POST "/api/resources/$($v2.id)/releases" @{ revision = 1; environment = "dev" }
Check "v2 published to dev" $releaseV2.state "converged"
Wait-Fleet "dev" | Out-Null
Start-Sleep -Seconds 3

$callV1 = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
$callV2 = Curl "$($Gateways.dev)/it/solution/petstore/v2/store/inventory" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
Check "v1 still answers" $callV1.Status 200
Check "v2 answers too, from its own route and backend" $callV2.Status 200
Note "one product, one key, two versions: they are two resources with two routes"

Section "9. deprecate v1"
$current = Api GET "/api/resources/$($v1.id)"
Api PATCH "/api/resources/$($v1.id)" @{ lifecycle = "deprecated"; sunsetAt = "2027-06-30T00:00:00Z" } -IfMatch $current.etag | Out-Null
Start-Sleep -Seconds 3
$deprecated = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
Check "deprecated v1 still serves" $deprecated.Status 200
Check "Deprecation header" (HeaderValue $deprecated.Headers "Deprecation") "true"
Note "Sunset: $(HeaderValue $deprecated.Headers 'Sunset')"

# ------------------------------------------------------------------ SOAP

Section "10. a SOAP API"
$soap = Api POST "/api/resources" @{ kind = "soap"; name = "petstore-soap"; applicationId = "application_platform"; apiVersion = "v1"; domain = "IT"; subdomain = "Solution" }
$wsdl = (Invoke-WebRequest -Uri "$Backend/soap/petstore?wsdl").Content
Api POST "/api/resources/$($soap.id)/revisions" @{ spec = $wsdl } | Out-Null
Api PUT "/api/resources/$($soap.id)/routes"  @{ environment = "dev"; host = "*"; basePath = "/it/solution/petstore-soap" } | Out-Null
Api PUT "/api/resources/$($soap.id)/binding" @{ environment = "dev"; urls = @("$Backend/soap/petstore") } | Out-Null
Api PUT "/api/resources/$($soap.id)/policy/units/rewrite" @{ value = @{ stripBasePath = $true } } | Out-Null
Api PUT "/api/resources/$($soap.id)/policy/units/auth.subscriptionKey" @{
  value = @{ in = "header"; name = "X-Api-Key"; forwardCredentials = $false }
} | Out-Null
$soapProduct = Api POST "/api/products" @{ name = "petstore-soap-product"; applicationId = "application_platform"; resourceIds = @($soap.id) }
$soapRelease = Api POST "/api/resources/$($soap.id)/releases" @{ revision = 1; environment = "dev" }
Check "soap API published" $soapRelease.state "converged"

Login "clara"
$soapSub = Api POST "/api/subscriptions" @{ productId = $soapProduct.id; applicationId = $application.id; environment = "dev" }
Login "pavel"
Wait-Fleet "dev" | Out-Null
Start-Sleep -Seconds 3

$envelopeFile = [System.IO.Path]::GetTempFileName()
@'
<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
  <tns:GetPetRequest xmlns:tns="urn:apim:petstore"><tns:petId>1</tns:petId></tns:GetPetRequest>
</soap:Body></soap:Envelope>
'@ | Set-Content -Path $envelopeFile -Encoding utf8

$soapOk = Curl "$($Gateways.dev)/it/solution/petstore-soap" @(
  "-X", "POST", "-H", "Content-Type: text/xml", "-H", "SOAPAction: `"urn:apim:petstore:GetPet`"",
  "-H", "X-Api-Key: $($soapSub.primaryKey)", "--data-binary", "@$envelopeFile")
Check "a valid SOAP call -> 200" $soapOk.Status 200
Note ($soapOk.Body -replace "\s+", " ").Trim()

$soapMismatch = Curl "$($Gateways.dev)/it/solution/petstore-soap" @(
  "-X", "POST", "-H", "Content-Type: text/xml", "-H", "SOAPAction: `"urn:apim:petstore:AddPet`"",
  "-H", "X-Api-Key: $($soapSub.primaryKey)", "--data-binary", "@$envelopeFile")
Check "SOAPAction disagreeing with the body -> 400" $soapMismatch.Status 400
Check "and it is a SOAP Fault, not JSON" ($soapMismatch.Body -match "<soap:Fault>") $true

$soapNoKey = Curl "$($Gateways.dev)/it/solution/petstore-soap" @(
  "-X", "POST", "-H", "Content-Type: text/xml", "-H", "SOAPAction: `"urn:apim:petstore:GetPet`"",
  "--data-binary", "@$envelopeFile")
Check "no key on a soap route -> 401 as a fault" $soapNoKey.Status 401
Check "rendered as a fault" ($soapNoKey.Body -match "faultcode") $true
Remove-Item $envelopeFile -Force -ErrorAction SilentlyContinue

# ------------------------------------------------------------------ validation (G1)

Section "11. request validation against the API's own definition"
# v2 inherited dev's 3-per-10s limit, and the next sections make more than three calls. Raising it
# here rather than detaching it keeps the route's shape honest: it is still rate limited.
Api PUT "/api/resources/$($v2.id)/policy/units/rateLimit" @{
  value = @{ calls = 200; periodSec = 10; per = "instance"; by = "subscription"; scope = "route"; emitHeaders = $true }
} | Out-Null
Start-Sleep -Seconds 3

$petHeaders = @("-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal",
                "-H", "Content-Type: application/json")
$badPet = Curl "$($Gateways.dev)/it/solution/petstore/v2/pet" (@("-X", "POST") + $petHeaders + @("--data", '{"name":42}'))
Check "a body that contradicts the schema -> 400" $badPet.Status 400
Note 'no "validate" unit is attached: absence is not off, it is at the defaults (design section 5.1)'
Note ($badPet.Body -replace "\s+", " ").Trim()

$goodPet = Curl "$($Gateways.dev)/it/solution/petstore/v2/pet" (@("-X", "POST") + $petHeaders +
  @("--data", '{"name":"rex","photoUrls":[]}'))
Check "a body that matches -> 200" $goodPet.Status 200

# Downgrading is allowed. The price is a reason, recorded and listed.
$noReason = Api PUT "/api/resources/$($v2.id)/policy/units/validate" @{
  value = @{ request = "warning" }
} -AllowFailure
Check "downgrading without a reason is refused" ($null -eq $noReason) $true

Api PUT "/api/resources/$($v2.id)/policy/units/validate" @{
  value = @{
    request = "warning"
    response = "disabled"
    downgradeReason = "INT-4412: the vendor posts an undeclared field until their March release"
  }
} | Out-Null
Start-Sleep -Seconds 3
$warned = Curl "$($Gateways.dev)/it/solution/petstore/v2/pet" (@("-X", "POST") + $petHeaders + @("--data", '{"name":42}'))
Check "in warning mode the same body passes through -> 200" $warned.Status 200
Note "warning mode is an observation, not a control: sampled, asynchronous, and never rejecting"

Login "alice"
$downgrades = Api GET "/api/validation/downgrades?environment=dev"
$listed = $downgrades.items | Where-Object { $_.resourceName -like "petstore v2*" } | Select-Object -First 1
Check "it is listed in the governance report" ($null -ne $listed) $true
Note "reason on the record: $($listed.downgradeReason)"
Login "pavel"

Api DELETE "/api/resources/$($v2.id)/policy/units/validate" | Out-Null
Start-Sleep -Seconds 3
$backToBlocking = Curl "$($Gateways.dev)/it/solution/petstore/v2/pet" (@("-X", "POST") + $petHeaders + @("--data", '{"name":42}'))
Check "detaching the downgrade restores blocking -> 400" $backToBlocking.Status 400

# ------------------------------------------------------------------ backend pools (G7)

Section "12. two backends, round-robin, and a circuit breaker"
Api PUT "/api/resources/$($v2.id)/binding" @{
  environment = "dev"
  pool = @(@{ url = "$Backend/v2" }, @{ url = "$Backend2/v2" })
  rule = "round-robin"
} | Out-Null
Api PUT "/api/resources/$($v2.id)/policy/units/circuitBreaker" @{
  value = @{ failures = 3; windowSec = 60; openSec = 20; halfOpenProbes = 1 }
} | Out-Null
Api PUT "/api/resources/$($v2.id)/policy/units/retries" @{
  value = @{ attempts = 1; on = @("502", "503", "504", "timeout", "connect"); idempotentOnly = $true }
} | Out-Null
Start-Sleep -Seconds 3

# One gateway only: the pool cursor and the breaker are both per instance, so mixing two gateways
# would interleave two independent round-robins and prove nothing.
$served = @()
foreach ($i in 1..4) {
  $call = Curl "$($Gateways.dev)/it/solution/petstore/v2/store/inventory" @(
    "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
  $served += HeaderValue $call.Headers "x-backend-instance"
}
Check "four calls, two backends, alternating" (($served | Select-Object -Unique | Sort-Object) -join ",") "petstore-9080,petstore-9081"
Note "served: $($served -join ' -> ')"

# `x-sim-status` reaches the backend because the gateway forwards headers it has no rule about;
# both pool members answer 503, so the breaker sees the whole pool fail rather than one member.
foreach ($i in 1..8) {
  Curl "$($Gateways.dev)/it/solution/petstore/v2/store/inventory" @(
    "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal", "-H", "x-sim-status: 503") | Out-Null
}
$afterBreaker = Curl "$($Gateways.dev)/it/solution/petstore/v2/store/inventory" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
Check "with every backend open the gateway answers 503 itself" $afterBreaker.Status 503
Note "and it says so: $(($afterBreaker.Body -replace '\s+', ' ').Trim())"
$stillFine = Curl "$($Gateways.dev2)/it/solution/petstore/v2/store/inventory" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
Check "the other gateway's breaker is its own -> 200" $stillFine.Status 200
Note "per-instance breaker state: one gateway's connectivity fault cannot trip the fleet"

Note "waiting out openSec so the rest of the run has its backends back"
Start-Sleep -Seconds 21
$recovered = Curl "$($Gateways.dev)/it/solution/petstore/v2/store/inventory" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
Check "after openSec the half-open probe lets it back in -> 200" $recovered.Status 200

# ------------------------------------------------------------------ the global tier (G2)

Section "13. one policy for every API in dev"
Login "alice"
$global = Api PUT "/api/policy/global/units/cors?environment=dev" @{
  value = @{ origins = @("https://portal.example"); methods = @("GET", "POST"); maxAgeSec = 600 }
}
Note "this one write applies to $($global.affectedResources) APIs in dev"
Check "and no API overrides it yet" $global.overriddenBy 0
Login "pavel"
Start-Sleep -Seconds 3

$effective = Api GET "/api/resources/$($v1.id)/policy/effective?environment=dev"
$corsUnit = $effective.units | Where-Object { $_.unitKey -eq "cors" }
Check "petstore v1 now has cors it never attached" $corsUnit.origin "global"
Note "the API's own page names the origin, which is the only thing that makes an estate-wide tier bearable"

$preflight = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory" @(
  "-X", "OPTIONS", "-H", "Origin: https://portal.example",
  "-H", "Access-Control-Request-Method: GET")
Check "a browser preflight is answered at the gateway" $preflight.Status 204
Check "with the global origin" (HeaderValue $preflight.Headers "Access-Control-Allow-Origin") "https://portal.example"

# The resource always wins, and whole units at a time — half a cors is not a cors anybody wrote.
Api PUT "/api/resources/$($v1.id)/policy/units/cors" @{
  value = @{ origins = @("https://apps.example"); methods = @("GET"); maxAgeSec = 60 }
} | Out-Null
Start-Sleep -Seconds 3
$overridden = Api GET "/api/resources/$($v1.id)/policy/effective?environment=dev"
Check "the API's own value wins" (($overridden.units | Where-Object { $_.unitKey -eq "cors" }).origin) "resource"
$ownOrigin = Curl "$($Gateways.dev)/it/solution/petstore/v1/store/inventory" @(
  "-X", "OPTIONS", "-H", "Origin: https://apps.example", "-H", "Access-Control-Request-Method: GET")
Check "and it is the one the gateway enforces" (HeaderValue $ownOrigin.Headers "Access-Control-Allow-Origin") "https://apps.example"

Login "alice"
Api DELETE "/api/policy/global/units/cors?environment=dev" | Out-Null
Login "pavel"
Api DELETE "/api/resources/$($v1.id)/policy/units/cors" | Out-Null

# ------------------------------------------------------------------ MCP (G4)

Section "14. publish an existing MCP server and call a tool through the gateway"
$mcp = Api POST "/api/resources" @{ kind = "mcp"; name = "petstore-mcp"; applicationId = "application_platform"; apiVersion = "v1"; domain = "IT"; subdomain = "Solution" }
$mcpRevision = Api POST "/api/resources/$($mcp.id)/revisions" @{ discoverUrl = $McpServer }
Check "discovery produced a revision" $mcpRevision.rev 1
Note "the control plane spoke the protocol once — initialize, then tools/resources/prompts — and froze what it heard"

$mcpDetail = Api GET "/api/resources/$($mcp.id)"
Note "discovered from $($mcpDetail.discoveryUrl)"
$again = Api POST "/api/resources/$($mcp.id)/regenerate"
Check "re-discovering an unchanged server makes no new revision" $again.unchanged $true

Api PUT "/api/resources/$($mcp.id)/routes"  @{ environment = "dev"; host = "*"; basePath = "/it/solution/petstore-mcp" } | Out-Null
Api PUT "/api/resources/$($mcp.id)/binding" @{ environment = "dev"; urls = @($McpServer) } | Out-Null
Api PUT "/api/resources/$($mcp.id)/policy/units/rewrite" @{ value = @{ stripBasePath = $true } } | Out-Null
Api PUT "/api/resources/$($mcp.id)/policy/units/auth.subscriptionKey" @{
  value = @{ in = "header"; name = "X-Api-Key"; forwardCredentials = $false }
} | Out-Null

$a2aResource = Api POST "/api/resources" @{ kind = "a2a"; name = "shelter-agent"; applicationId = "application_platform"; apiVersion = "v1"; domain = "IT"; subdomain = "Solution" }
$agentsProduct = Api POST "/api/products" @{
  name = "agents-product"; applicationId = "application_platform"; resourceIds = @($mcp.id, $a2aResource.id)
}
$mcpRelease = Api POST "/api/resources/$($mcp.id)/releases" @{ revision = 1; environment = "dev" }
Check "mcp API published" $mcpRelease.state "converged"

Login "clara"
$agentSub = Api POST "/api/subscriptions" @{ productId = $agentsProduct.id; applicationId = $application.id; environment = "dev" }
$agentKey = $agentSub.primaryKey
Login "pavel"
Wait-Fleet "dev" | Out-Null
Start-Sleep -Seconds 3

$mcpUrl = "$($Gateways.dev)/it/solution/petstore-mcp"
$mcpAuth = @("-H", "X-Api-Key: $agentKey", "-H", "Content-Type: application/json")
$initBody = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo.ps1","version":"1.0.0"}}}'

$noMcpKey = Curl $mcpUrl (@("-X", "POST") + @("-H", "Content-Type: application/json") + @("--data", $initBody))
Check "an unauthenticated MCP call -> 401" $noMcpKey.Status 401
Check "and the refusal is JSON-RPC, not problem+json" ($noMcpKey.Body -match '"jsonrpc"') $true
Note "an MCP client cannot read problem+json; a gateway that answers in it is a gateway that broke the protocol"

# The protocol's own methods are validated too, not only the tools: `initialize` has required
# params, and a client that omits them is told which ones before the server is ever reached.
$emptyInit = Curl $mcpUrl (@("-X", "POST") + $mcpAuth +
  @("--data", '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'))
Check "initialize with empty params -> JSON-RPC -32602" ($emptyInit.Body -match "-32602") $true
Note ((($emptyInit.Body | ConvertFrom-Json).error.message))

$init = Curl $mcpUrl (@("-X", "POST") + $mcpAuth + @("--data", $initBody))
Check "a well-formed initialize -> 200" $init.Status 200
$mcpSession = HeaderValue $init.Headers "Mcp-Session-Id"
Check "the server's session id reached the client" ($null -ne $mcpSession) $true

$sessionHeader = @("-H", "Mcp-Session-Id: $mcpSession")
$tools = Curl $mcpUrl (@("-X", "POST") + $mcpAuth + $sessionHeader +
  @("--data", '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'))
Check "tools/list -> 200" $tools.Status 200
Note "tools: $((($tools.Body | ConvertFrom-Json).result.tools | ForEach-Object { $_.name }) -join ', ')"

$call = Curl $mcpUrl (@("-X", "POST") + $mcpAuth + $sessionHeader +
  @("--data", '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"getPet","arguments":{"petId":1}}}'))
Check "tools/call getPet -> 200" $call.Status 200
Note ($call.Body -replace "\s+", " ").Trim()

$badArgs = Curl $mcpUrl (@("-X", "POST") + $mcpAuth + $sessionHeader +
  @("--data", '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"getPet","arguments":{"petId":"one"}}}'))
Check "arguments the tool's own inputSchema rejects never reach the server" ($badArgs.Body -match '"error"') $true
Note "the schema came from discovery, so validation and the contract cannot disagree"

$unknown = Curl $mcpUrl (@("-X", "POST") + $mcpAuth + $sessionHeader +
  @("--data", '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"launchMissiles","arguments":{}}}'))
Check "a tool this server never declared -> JSON-RPC -32601" ($unknown.Body -match "-32601") $true

# ------------------------------------------------------------------ A2A (G5)

Section "15. publish an existing A2A agent; the card points at us, not at the origin"
$a2aRevision = Api POST "/api/resources/$($a2aResource.id)/revisions" @{ discoverUrl = $A2aAgent }
Check "the agent card was discovered" $a2aRevision.rev 1
Api PUT "/api/resources/$($a2aResource.id)/routes"  @{ environment = "dev"; host = "*"; basePath = "/it/solution/shelter" } | Out-Null
Api PUT "/api/resources/$($a2aResource.id)/binding" @{ environment = "dev"; urls = @($A2aAgent) } | Out-Null
Api PUT "/api/resources/$($a2aResource.id)/policy/units/rewrite" @{ value = @{ stripBasePath = $true } } | Out-Null
Api PUT "/api/resources/$($a2aResource.id)/policy/units/auth.subscriptionKey" @{
  value = @{ in = "header"; name = "X-Api-Key"; forwardCredentials = $false }
} | Out-Null
$a2aRelease = Api POST "/api/resources/$($a2aResource.id)/releases" @{ revision = 1; environment = "dev" }
Check "a2a API published" $a2aRelease.state "converged"
Wait-Fleet "dev" | Out-Null
Start-Sleep -Seconds 3

# The card is discovery, so it is served without a key — otherwise no agent could ever find it.
$card = Curl "$($Gateways.dev)/it/solution/shelter/.well-known/agent-card.json"
Check "the card is public, because discovery has to be" $card.Status 200
$cardBody = $card.Body | ConvertFrom-Json
Check "and its url is the gateway" ($cardBody.url -like "*$($Gateways.dev)*") $true
Note "origin said $A2aAgent; we serve $($cardBody.url)"
$schemes = $cardBody.securitySchemes.PSObject.Properties.Name
Check "the security scheme is the gateway's, not the origin's" ($schemes -join ",") "subscriptionKey"
Note "the origin asked for its own bearer token; a consumer following this card is told to bring OUR key"
Note "so a consumer that follows this card reaches the gateway and every policy on it (plan [R1-16])"

$send = Curl "$($Gateways.dev)/it/solution/shelter" (@("-X", "POST", "-H", "X-Api-Key: $agentKey",
  "-H", "Content-Type: application/json",
  "--data", '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"where is doggie"}]}}}'))
Check "message/send through the gateway -> 200" $send.Status 200
Note ($send.Body -replace "\s+", " ").Trim()

$stream = Curl "$($Gateways.dev)/it/solution/shelter" (@("-X", "POST", "-H", "X-Api-Key: $agentKey",
  "-H", "Content-Type: application/json",
  "--data", '{"jsonrpc":"2.0","id":2,"method":"message/stream","params":{"message":{"role":"user","kind":"message","messageId":"m-1","parts":[{"kind":"text","text":"hi"}]}}}'))
Check "message/stream without passthrough.sse -> 503" $stream.Status 503
Check "refused as JSON-RPC, not half-served" ($stream.Body -match "streaming is not enabled") $true
Note "the agent's card advertises streaming; this route has not been given passthrough.sse, so the gateway says no rather than opening a stream it cannot bound"

# ------------------------------------------------------------------ streaming (G7 / design 5.8)

Section "16. server-sent events through the gateway"
Api PUT "/api/resources/$($v2.id)/policy/units/passthrough" @{
  value = @{ sse = $true; streamIdleTimeoutSec = 30; maxConnectionSec = 60; maxConcurrentConnections = 10 }
} | Out-Null
Start-Sleep -Seconds 3
$events = Curl "$($Gateways.dev)/it/solution/petstore/v2/events?count=3&intervalMs=100" @(
  "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal", "--max-time", "10")
Check "the stream is proxied -> 200" $events.Status 200
Check "and the events arrive as events" (([regex]::Matches($events.Body, "(?m)^data:")).Count -ge 3) $true
Note "the upgrade ran the whole request pipeline — key, limit, precondition — and then bytes were copied"

$cacheOnStream = Api PUT "/api/resources/$($v2.id)/policy/units/cache" @{
  value = @{ ttlSec = 60 }
} -AllowFailure
Check "caching an SSE route is refused at write time" ($null -eq $cacheOnStream) $true
Note "a response that never ends cannot be stored; refusing on save beats ignoring at runtime (design section 5.8)"
Api DELETE "/api/resources/$($v2.id)/policy/units/passthrough" | Out-Null

# ------------------------------------------------------------------ the Catalog (G6)

Section "17. the Catalog: one place to find all three protocols"
$v1Now = Api GET "/api/resources/$($v1.id)"
Api PATCH "/api/resources/$($v1.id)" @{
  summary = "Pets, their owners, and the orders between them."
  description = "The canonical demo API. Use it to try a subscription key, a rate limit and a promotion end to end."
  tags = @("pets", "retail", "demo")
  icon = "🐾"
} -IfMatch $v1Now.etag | Out-Null

$search = Api GET "/api/catalog?q=pet&sort=relevance"
Check "searching for 'pet' finds the petstore" (($search.items | Where-Object { $_.name -eq "petstore" }).Count -gt 0) $true
$byOperation = Api GET "/api/catalog?q=getPet"
Check "and searching by an operation the contract declares finds it too" ($byOperation.items.Count -gt 0) $true
Note "the index covers names, summaries, tags, REST operation ids, MCP tool names and A2A skills"

$facets = Api GET "/api/catalog/facets"
$kinds = ($facets.kinds | ForEach-Object { "$($_.value)=$($_.count)" }) -join "  "
Note "kinds: $kinds"
Check "all three protocols are listed side by side" (($facets.kinds | Where-Object { $_.value -in @("rest", "mcp", "a2a") }).Count) 3

$listing = Api GET "/api/catalog/$($v1.id)"
Check "the listing carries a copy-pasteable call" ($listing.example.text -match "curl") $true
Note ($listing.example.text -replace "\s+", " ").Trim()
Check "and the operations from the contract itself" ($listing.operations.Count -gt 0) $true

$mcpListing = Api GET "/api/catalog/$($mcp.id)"
Check "an MCP listing shows its tools with their input schemas" ($mcpListing.operations[0].inputSchema -ne $null) $true

# ------------------------------------------------------------------ telemetry

Section "18. the telemetry this run produced"
Login "alice"
Start-Sleep -Seconds 8   # one poll plus one flush interval
$summary = Api GET "/api/telemetry/summary?environment=dev&sinceMin=30"
Write-Host ("  requests {0}   ok {1}   gateway rejections {2}   upstream errors {3}" -f `
  $summary.totals.requests, $summary.totals.ok, $summary.totals.gatewayRejections, $summary.totals.upstreamErrors)
Write-Host ("  p50 {0} ms   p95 {1} ms   (approximate: interpolated from histogram buckets)" -f `
  $summary.totals.p50Ms, $summary.totals.p95Ms)
Check "the run produced traffic the control plane can see" ($summary.totals.requests -gt 0) $true
Check "and it recorded the rejections" ($summary.totals.gatewayRejections -ge 5) $true

$outcomes = ($summary.outcomes | ForEach-Object { "$($_.outcome)=$($_.count)" }) -join "  "
Note "outcomes: $outcomes"

$perApi = Api GET "/api/telemetry/resources?environment=dev&sinceMin=30"
foreach ($item in $perApi.items) {
  Write-Host ("  {0,-16} {1,-4} requests {2,5}   ok {3,5}   p95 {4} ms" -f `
    $item.name, $item.apiVersion, $item.requests, $item.ok, $item.p95Ms)
}

$instances = Api GET "/api/telemetry/instances?environment=dev&sinceMin=30"
foreach ($item in $instances.items) {
  Write-Host ("  gateway {0,-8} requests {1,5}   share {2,5:P0}   rss {3} MB" -f `
    $item.name, $item.requests, $item.share, [math]::Round($item.process.rssBytes / 1MB, 1))
}

# ------------------------------------------------------------------ revoking a gateway

Section "19. revoke a gateway; the others keep serving"
# A throwaway gateway of its own, so a demo run never leaves the fleet degraded and the script
# stays re-runnable. Its token goes in an env file rather than argv, as the stack script does.
$victimName = "demo-victim"
$victimPort = 8089
$existing = (Api GET "/api/targets/dev/instances").items |
  Where-Object { $_.name -eq $victimName -and -not $_.revoked }
foreach ($stale in $existing) { Api DELETE "/api/instances/$($stale.id)" -AllowFailure | Out-Null }

Login "alice"
$victim = Api POST "/api/targets/dev/instances" @{ name = $victimName }
Login "pavel"
$victimEnv = ".data/env/$victimName"
@(
  "DP_NAME=$victimName"
  "DP_PORT=$victimPort"
  "GATEWAY_CP_URL=$ControlPlane"
  "GATEWAY_TOKEN=$($victim.token)"
  "GATEWAY_CONFIG_CACHE=.data/dp-$victimName-config.json"
  "POLL_INTERVAL_SEC=2"
  # A gateway refuses to start unless the runtime's outbound queue is at least as wide as its own
  # ceiling, so this throwaway one needs the pair too (reports/capacity-report.md).
  "MAX_CONCURRENT_REQUESTS=2048"
  "BUN_CONFIG_MAX_HTTP_REQUESTS=8192"
  ""
) | Set-Content -Path $victimEnv -Encoding utf8

$victimProcess = Start-Process -FilePath "bun" -NoNewWindow -PassThru `
  -ArgumentList @("--env-file=$victimEnv", "run", "data-plane/src/server.ts") `
  -RedirectStandardOutput ".data/$victimName.out.log" -RedirectStandardError ".data/$victimName.err.log"
try {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-RestMethod "http://localhost:$victimPort/healthz" -TimeoutSec 2 | Out-Null; break }
    catch { Start-Sleep -Milliseconds 300 }
  }
  Start-Sleep -Seconds 2
  $before = Curl "http://localhost:$victimPort/it/solution/petstore/v1/store/inventory" @(
    "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
  Check "the new gateway serves traffic -> 200" $before.Status 200

  Login "alice"
  Api DELETE "/api/instances/$($victim.id)" | Out-Null
  Login "pavel"
  Start-Sleep -Seconds 4

  $revoked = Curl "http://localhost:$victimPort/it/solution/petstore/v1/store/inventory" @(
    "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
  Check "after revocation it refuses traffic -> 503" $revoked.Status 503
  $survivor = Curl "$($Gateways.dev2)/it/solution/petstore/v1/store/inventory" @(
    "-H", "X-Api-Key: $devKey", "-H", "X-Request-Origin: skoda-portal")
  Check "the rest of the DEV fleet is untouched -> 200" $survivor.Status 200
  Note "revocation fails closed at the next poll; staleness never does (design section 8.5)"
} finally {
  Stop-Process -Id $victimProcess.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $victimEnv, ".data/dp-$victimName-config.json" -Force -ErrorAction SilentlyContinue
}

# ==================================================================================================
#  Act two: the six journeys, in the order the portal presents them
#
#  Act one proves the gateway. This act proves the *portal*: it walks the six journeys the UI names
#  on "How this works", in that order, through exactly the endpoints the screens call — so a step
#  that cannot be reached from the one before it fails here rather than in somebody's first hour
#  (plan §9.2). Each journey ends where the UI's completion panel says it ends.
# ==================================================================================================

Login "pavel"

$SpecV1 = @'
{
  "openapi": "3.0.0",
  "info": { "title": "walkthrough", "version": "1.0.0" },
  "paths": {
    "/store/inventory": {
      "get": { "operationId": "getInventory", "responses": { "200": { "description": "counts" } } }
    },
    "/pet/{petId}": {
      "get": {
        "operationId": "getPetById",
        "parameters": [
          { "name": "petId", "in": "path", "required": true, "schema": { "type": "integer" } }
        ],
        "responses": { "200": { "description": "one pet" } }
      }
    },
    "/echo": {
      "get": { "operationId": "echo", "responses": { "200": { "description": "what was sent" } } }
    }
  }
}
'@

# The same contract with two changes a caller would feel: one operation gone, and a parameter that
# was optional now required. This is the upload that makes journey 3 the right move.
$SpecV1Rev2 = @'
{
  "openapi": "3.0.0",
  "info": { "title": "walkthrough", "version": "1.0.1" },
  "paths": {
    "/store/inventory": {
      "get": {
        "operationId": "getInventory",
        "parameters": [
          { "name": "status", "in": "query", "required": true, "schema": { "type": "string" } }
        ],
        "responses": { "200": { "description": "counts" } }
      }
    },
    "/echo": {
      "get": { "operationId": "echo", "responses": { "200": { "description": "what was sent" } } }
    }
  }
}
'@

# ------------------------------------------------------------------ journey 1: publish

Section "20. journey 1 of 6 - publish an API"
$walk = Api POST "/api/resources" @{ kind = "rest"; name = "walkthrough"; applicationId = "application_platform"; apiVersion = "v1"; domain = "IT"; subdomain = "Solution" }
Note "step 1 of the wizard: the API exists, and has nothing in it yet"

$walkRev = Api POST "/api/resources/$($walk.id)/revisions" @{ spec = $SpecV1 }
Check "the definition imported as revision 1" $walkRev.rev 1

# Before it is released: the portal already knows what is missing and says which screen fixes it.
# This is the same evaluator the dashboard and the API page both read (plan section 6.3). It says
# "never released" rather than "no route in PROD" on purpose — a route is only reported for an
# environment the API has begun to occupy, or every new API would arrive carrying three blockers.
$blocked = Api GET "/api/resources/$($walk.id)"
$pending = $blocked.attention | Where-Object { $_.code -eq "never-released" }
Check "the portal names what is missing before anybody asks" ($null -ne $pending) $true
Note "$($pending.detail)"
Note "and it links to $($pending.href)"

Api PUT "/api/resources/$($walk.id)/routes"  @{ environment = "dev"; host = "*"; basePath = "/it/solution/walkthrough/v1" } | Out-Null
Api PUT "/api/resources/$($walk.id)/binding" @{ environment = "dev"; urls = @("$Backend/v2") } | Out-Null
Api PUT "/api/resources/$($walk.id)/policy/units/rewrite" @{ value = @{ stripBasePath = $true } } | Out-Null
Api PUT "/api/resources/$($walk.id)/policy/units/auth.subscriptionKey" @{
  value = @{ in = "header"; name = "X-Api-Key"; forwardCredentials = $false }
} | Out-Null
Note "step 2: host *, base path /walkthrough/v1, backend $Backend/v2"

$walkRelease = Api POST "/api/resources/$($walk.id)/releases" @{ revision = 1; environment = "dev" }
Check "step 3: released, and the release converged" $walkRelease.state "converged"
Wait-Fleet "dev" | Out-Null

$published = Api GET "/api/resources/$($walk.id)"
$devRoute = $published.routes | Where-Object { $_.environment -eq "dev" }
Check "the completion panel's address is real" $devRoute.basePath "/it/solution/walkthrough/v1"
Check "and nobody can subscribe to it yet, because it is in no product" $published.products.Count 0
Note "which is exactly what the wizard's last line says, and journey 4 is where that is fixed"

# ------------------------------------------------------------------ journey 2: promote

Section "21. journey 2 of 6 - promote it to the next environment"
# Step 2 of the wizard is the plan, and the plan is what refuses: TEST has no route yet, so the
# promotion is named as blocked before anybody presses anything.
$blockedPlan = Api POST "/api/resources/$($walk.id)/releases?dryRun=1" @{ revision = 1; environment = "test" }
Check "the plan refuses a promotion TEST cannot serve" ($blockedPlan.plan.blockers.Count -gt 0) $true
Note "blockers: $((($blockedPlan.plan.blockers | ForEach-Object { $_.code }) -join ', '))"
$applyBlocked = Api POST "/api/resources/$($walk.id)/releases" @{ revision = 1; environment = "test" } -AllowFailure
Check "and applying it anyway is refused too" ($null -eq $applyBlocked) $true

Api PUT "/api/resources/$($walk.id)/routes"  @{ environment = "test"; host = "*"; basePath = "/it/solution/walkthrough/v1" } | Out-Null
Api PUT "/api/resources/$($walk.id)/binding" @{ environment = "test"; urls = @("$Backend/v2") } | Out-Null

$walkPlan = Api POST "/api/resources/$($walk.id)/releases?dryRun=1" @{ revision = 1; environment = "test" }
Check "with the route in place the plan is clear" $walkPlan.plan.blockers.Count 0
$creates = ($walkPlan.plan.policy.create | ForEach-Object { $_.unit }) -join ", "
Note "the plan creates [$creates] in TEST, seeded from $($walkPlan.plan.from)"
Note "only the contract travelled; the route and the backend above are TEST's own"

$walkPromoted = Api POST "/api/resources/$($walk.id)/releases" @{
  revision = 1; environment = "test"; planId = $walkPlan.planId
}
Check "step 3: what was applied is the plan that was shown" $walkPromoted.state "converged"
Wait-Fleet "test" | Out-Null

$divergence = Api GET "/api/resources/$($walk.id)/divergence"
Note "divergence now compares $((($divergence.environments | ForEach-Object { $_.environment }) -join ' vs '))"

# ------------------------------------------------------------------ journey 3: a new version

Section "22. journey 3 of 6 - publish a new version"
# The reason for a new version is a change that would break the callers you already have — so the
# portal is asked what would break, before the decision rather than after it (goal G3).
$walkRev2 = Api POST "/api/resources/$($walk.id)/revisions" @{ spec = $SpecV1Rev2 }
Check "the changed contract is revision 2" $walkRev2.rev 2

$revisions = Api GET "/api/resources/$($walk.id)/revisions"
$rev2 = $revisions.items | Where-Object { $_.rev -eq 2 }
$diff = Api GET "/api/revisions/$($rev2.id)/diff"
Check "the diff finds breaking changes" ($diff.summary.breaking -ge 2) $true
foreach ($operation in ($diff.operations | Where-Object { $_.breaking })) {
  Note "breaking: $($operation.operationId) $($operation.change) - rule $($operation.rule)"
}
Check "and it names the rule that fired, not just 'changed'" (($diff.operations | Where-Object { $_.rule -eq "operation-removed" }).Count -ge 1) $true

$unreleased = (Api GET "/api/resources/$($walk.id)").attention |
  Where-Object { $_.code -eq "unreleased-revision" }
Check "revision 2 is listed as uploaded but not serving anywhere" ($null -ne $unreleased) $true
Note "$($unreleased.detail)"

$walkV2 = Api POST "/api/resources/$($walk.id)/versions" @{ apiVersion = "v2"; copyPolicyFrom = "dev"; createRoutes = $true }
Check "so v2 is created beside v1 rather than over it" $walkV2.apiVersion "v2"
Note "proposed base path $($walkV2.proposedBasePath); policy copied from dev as v2's own units"

# A version is created from the newest definition, so the contract that would have broken v1's
# callers is already v2's revision 1 — there is nothing to upload again.
$v2Revisions = Api GET "/api/resources/$($walkV2.id)/revisions"
Check "v2 starts at revision 1, carrying the changed contract" $v2Revisions.items.Count 1
$v2Rev1 = $v2Revisions.items[0]
$acrossVersions = Api GET "/api/revisions/$($v2Rev1.id)/diff?from=$($revisions.items | Where-Object { $_.rev -eq 1 } | ForEach-Object { $_.id })"
Check "and diffing it against v1's live revision says the same thing" ($acrossVersions.summary.breaking -ge 2) $true
Note "which is why these are two versions and not two revisions of one"

Api PUT "/api/resources/$($walkV2.id)/binding" @{ environment = "dev"; urls = @("$Backend/v2") } | Out-Null
$walkV2Release = Api POST "/api/resources/$($walkV2.id)/releases" @{ revision = 1; environment = "dev" }
Check "v2 published to dev" $walkV2Release.state "converged"
Wait-Fleet "dev" | Out-Null

$bothLive = Api GET "/api/resources/$($walk.id)"
Check "v1 is still live and still serving revision 1" (($bothLive.releases | Where-Object { $_.environment -eq "dev" -and $_.state -eq "converged" }).rev) 1
Note "two base paths, two sets of subscribers; a consumer moves to v2 deliberately"

# ------------------------------------------------------------------ journey 4: subscribe

Section "23. journey 4 of 6 - subscribe to it"
$walkProduct = Api POST "/api/products" @{
  name = "walkthrough-product"; applicationId = "application_platform"; resourceIds = @($walk.id, $walkV2.id)
}
Note "an owner puts the API in a product; a consumer subscribes to the product, never to the API"

Login "clara"
$listing = Api GET "/api/catalog/$($walk.id)"
Check "the consumer finds it in the catalog" $listing.title "walkthrough"
Check "and the listing offers a product to subscribe to" ($listing.products.Count -gt 0) $true

# The wizard's three steps, through the endpoints the wizard calls.
$walkApp = Api POST "/api/applications" @{ name = "walkthrough-app"; applicationId = "application_orders" }
Note "step 1: the application, because keys belong to a caller rather than to a person"
$terms = Api GET "/api/resources/$($walk.id)/policy/effective?environment=dev"
Note "step 3 reads the terms from what the gateway is running: $((($terms.units | ForEach-Object { $_.unitKey }) -join ', '))"
$walkSub = Api POST "/api/catalog/$($walkProduct.id)/subscribe" @{ applicationId = $walkApp.id; environment = "dev" }
$walkKey = $walkSub.primaryKey
Check "the key is issued, once" ($walkKey.Length -gt 20) $true
Note "shown here because this is a script; the UI shows it once and never again"

$reveal = Api POST "/api/subscriptions/$($walkSub.id)/reveal"
Check "and it can be recovered later only through an audited reveal" $reveal.primaryKey $walkKey

Start-Sleep -Seconds 3
$consumerCall = Curl "$($Gateways.dev)/it/solution/walkthrough/v1/store/inventory" @("-H", "X-Api-Key: $walkKey")
Check "the key works at the gateway -> 200" $consumerCall.Status 200

# ------------------------------------------------------------------ journey 5: call it from here

Section "24. journey 5 of 6 - call it from the portal"
# The console never composes a URL and never holds a key: it asks the control plane what the form
# should offer, then posts an operation id (plan section 5).
$form = Api GET "/api/playground/form?resourceId=$($walk.id)&environment=dev"
Check "the form is drawn from the revision DEV is serving" $form.rev 1
Check "it offers exactly the operations that revision declares" $form.operations.Count 3
Note "operations: $((($form.operations | ForEach-Object { $_.id }) -join ', '))"
Check "it names the key header rather than the key" $form.key.name "X-Api-Key"
Check "and it offers the caller's own subscription" ($form.subscriptions.Count -ge 1) $true
Note "$($form.note)"

# A header of the caller's own, so "the key is not in what comes back" is an assertion about a
# non-empty header set rather than a sentence that would pass over an empty one.
$send = Api POST "/api/playground" @{
  resourceId = $walk.id
  environment = "dev"
  subscriptionId = $walkSub.id
  keyKind = "primary"
  operationId = "getInventory"
  headers = @(@{ name = "X-Trace"; value = "walkthrough"; enabled = $true })
}
Check "the call went through the gateway -> 200" $send.response.status 200
Check "and the response came back with it" ($send.response.body -match "available") $true
$echoed = ($send.request.headers.PSObject.Properties.Name) -join ","
Check "the header the caller set is echoed back" ($echoed -match "X-Trace") $true
Check "and the key it was sent with is not" ($echoed -notmatch "X-Api-Key") $true
Note "headers shown: $echoed"

# A path parameter, prefilled by the form and accepted by the send — the two cannot disagree,
# because both resolve the same route.
$withParam = Api POST "/api/playground" @{
  resourceId = $walk.id
  environment = "dev"
  subscriptionId = $walkSub.id
  operationId = "getPetById"
  pathParams = @{ petId = "1" }
}
Check "an operation with a path parameter -> 200" $withParam.response.status 200
Note ($withParam.response.body -replace "\s+", " ").Trim()

$history = Api GET "/api/playground/history?resourceId=$($walk.id)"
Check "both calls are in this user's own history" ($history.items.Count -ge 2) $true
Check "every entry can be loaded back into the form" (($history.items | Where-Object { -not $_.replayable }).Count) 0
Note "kept for $($history.retentionDays) days, newest $($history.cap), and visible to nobody else"

# The owner's path: pavel can see the console, and is told what to do about the key he has not got.
Login "pavel"
$ownerForm = Api GET "/api/playground/form?resourceId=$($walk.id)&environment=dev"
Check "an owner with no subscription is told so, not shown an empty console" $ownerForm.needsSubscription $true
Login "clara"
$hidden = Api GET "/api/playground/history?resourceId=$($walk.id)" -AllowFailure
Check "and history is per user: clara still sees her own two" ($hidden.items.Count -ge 2) $true

# ------------------------------------------------------------------ journey 6: operate

Section "25. journey 6 of 6 - run the platform: trust an internal certificate authority"
Login "pavel"
$tlsPort = $TlsBackendPort
$caPath = ".data/demo-backend-ca.pem"
Remove-Item $caPath -Force -ErrorAction SilentlyContinue
$tlsProcess = Start-Process -FilePath "bun" -NoNewWindow -PassThru `
  -ArgumentList @("run", "tools/backend/server.ts", "--port=$tlsPort", "--tls",
                  "--tls-ca-out=$caPath", "--instance=petstore-tls") `
  -RedirectStandardOutput ".data/backend-tls.out.log" -RedirectStandardError ".data/backend-tls.err.log"
try {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod "https://localhost:$tlsPort/healthz" -TimeoutSec 2 -SkipCertificateCheck | Out-Null
      break
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not (Test-Path $caPath)) { throw "the TLS backend did not write its CA to $caPath" }
  Note "a backend on https://127.0.0.1:$tlsPort with a certificate from a CA nobody has heard of"

  Api PUT "/api/resources/$($walk.id)/binding" @{
    environment = "dev"; urls = @("https://127.0.0.1:$tlsPort/v2")
  } | Out-Null
  Start-Sleep -Seconds 3
  $beforeAnchor = Curl "$($Gateways.dev)/it/solution/walkthrough/v1/store/inventory" @("-H", "X-Api-Key: $walkKey")
  Check "before the CA is registered the gateway refuses to trust it -> 502" $beforeAnchor.Status 502
  Note "which is the correct answer: an unverifiable backend is not one to forward to"

  Login "alice"
  $pem = Get-Content $caPath -Raw
  # Preview first, exactly as the screen does: what this PEM is, before it is trusted.
  $preview = Api POST "/api/trust/anchors/preview" @{ pem = $pem }
  Check "the portal reads the PEM before trusting it" $preview.ca $true
  Note "subject $($preview.subject), expires in $($preview.expiresInDays) days, $($preview.keyAlgorithm)"
  $anchor = Api POST "/api/trust/anchors" @{ environment = "dev"; name = "demo-backend-ca"; pem = $pem }
  Check "registered as a DEV trust anchor" $anchor.environment "dev"
  Note "one write, at the environment level: every DEV gateway picks it up at its next poll"

  $testAnchors = Api GET "/api/trust/anchors?environment=test"
  Check "TEST is untouched until somebody copies it there" (($testAnchors.items | Where-Object { $_.thumbprint -eq $anchor.thumbprint }).Count) 0
  Note "trusting a CA in PROD is a PROD decision; nothing about trust rides the promotion chain"

  Login "pavel"
  Start-Sleep -Seconds 4
  $afterAnchor = Curl "$($Gateways.dev)/it/solution/walkthrough/v1/store/inventory" @("-H", "X-Api-Key: $walkKey")
  Check "after one poll the same call verifies and succeeds -> 200" $afterAnchor.Status 200

  Login "alice"
  $exceptions = Api GET "/api/trust/exceptions?environment=dev"
  $forWalkthrough = $exceptions.items | Where-Object { $_.resourceId -eq $walk.id -and $_.live }
  Check "and it took no TLS exception to do it" ($null -eq $forWalkthrough) $true
  Note "verification was turned on, not off - which is the whole point of goal G4"
  Login "pavel"
} finally {
  # Left pointing at the plain backend, so what this run leaves behind still answers once the
  # throwaway TLS backend is gone.
  Api PUT "/api/resources/$($walk.id)/binding" @{ environment = "dev"; urls = @("$Backend/v2") } -AllowFailure | Out-Null
  Stop-Process -Id $tlsProcess.Id -Force -ErrorAction SilentlyContinue
}

Section "26. journey 6 of 6 - and what the platform now shows"
Login "alice"
Start-Sleep -Seconds 8   # one gateway poll plus one telemetry flush
$dashboard = Api GET "/api/dashboard?environment=dev&sinceMin=30"
Check "the dashboard answers in one call" ($dashboard.hats.Count -gt 0) $true
Note "hats: $($dashboard.hats -join ', ')"
Note ("owner: {0} APIs, {1} requests, {2} refused by the gateway, {3} the backend failed" -f `
  $dashboard.owner.apis.total, $dashboard.owner.traffic.requests,
  $dashboard.owner.traffic.gatewayRejections, $dashboard.owner.traffic.upstreamErrors)
Check "three traffic numbers, never one" ($null -ne $dashboard.owner.traffic.gatewayRejections) $true
if (-not $dashboard.trendAvailable) {
  Note "no previous window: retention cannot cover it, so the trend is null rather than wrong"
}
foreach ($row in ($dashboard.owner.attention | Select-Object -First 4)) {
  Note "attention [$($row.severity)] $($row.code): $($row.detail)"
}
if ($dashboard.owner.attentionTruncated -gt 0) {
  Note "$($dashboard.owner.attentionTruncated) more not shown - every list here is bounded"
}

$anchorsNow = Api GET "/api/trust/anchors?environment=dev"
Check "the trust screen lists the authority this run registered" (($anchorsNow.items | Where-Object { $_.name -eq "demo-backend-ca" }).Count) 1

Section "27. the call, read back out of the platform"
$walkTelemetry = Api GET "/api/telemetry/resources?environment=dev&sinceMin=30"
$walkRow = $walkTelemetry.items | Where-Object { $_.name -eq "walkthrough" -and $_.apiVersion -eq "v1" }
Check "the portal's own calls are in telemetry like any other" ($walkRow.requests -gt 0) $true
Note ("walkthrough v1: {0} requests, {1} ok, p95 {2} ms" -f $walkRow.requests, $walkRow.ok, $walkRow.p95Ms)

$audit = Api GET "/api/audit?limit=200"
$playgroundRows = $audit.items | Where-Object { $_.action -eq "playground.call" }
Check "every console call left an audit row" ($playgroundRows.Count -ge 2) $true
$detail = ($playgroundRows | Select-Object -First 1).detail
Check "which records the outcome and no body" ($detail -notmatch '"body"') $true
Check "and no headers" ($detail -notmatch '"headers"') $true
Note "detail: $detail"
Login "pavel"

# ------------------------------------------------------------------ done

Write-Host ""
if ($script:Failures -eq 0) {
  Write-Host "All $($script:Checks) checks passed." -ForegroundColor Green
} else {
  Write-Host "$($script:Failures) of $($script:Checks) checks FAILED." -ForegroundColor Red
  exit 1
}
