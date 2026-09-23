<#
.SYNOPSIS
  Start, stop or inspect the whole stack: the upstreams (the petstore backend twice, an MCP server,
  an A2A agent and a simulated Kafka REST proxy), the control plane, and four gateways (two in DEV,
  one in TEST, one in PROD).

.DESCRIPTION
  The three upstreams exist so that every variant this platform publishes has something real to
  publish. They are ordinary servers that know nothing about the gateway — an MCP server that
  answers `initialize` and lists tools, and an A2A agent that serves its own card — which is the
  point: publishing them must not require changing them.

  Each gateway is started with `bun --env-file=.data/env/<name>`, so its token never appears in
  the process table (review V1-12). Process ids are recorded in .data/stack.json so -Down stops
  exactly what -Up started and nothing else.

.EXAMPLE
  pwsh -File scripts/stack.ps1 -Up
  pwsh -File scripts/stack.ps1 -Status
  pwsh -File scripts/stack.ps1 -Down
#>
[CmdletBinding()]
param(
  [switch] $Up,
  [switch] $Down,
  [switch] $Status,
  [switch] $Rebuild
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$StateFile = ".data/stack.json"
$Gateways = @(
  @{ name = "dev-1";  environment = "dev";  port = 8081 }
  @{ name = "dev-2";  environment = "dev";  port = 8082 }
  @{ name = "test-1"; environment = "test"; port = 8083 }
  @{ name = "prod-1"; environment = "prod"; port = 8084 }
)
# One upstream per variant. The ports are the ones the UI prefills and demo.ps1 discovers from, so
# changing one here means changing it in both.
$Upstreams = @(
  @{ name = "backend";   entry = "tools/backend/server.ts"; port = 9080; what = "the petstore backend (REST + SOAP + SSE + WebSocket)" }
  # A second copy, so a backend pool has two members that can be told apart: each response carries
  # `x-backend-instance`, which is what makes "round-robin spread the calls" an assertion rather
  # than a claim, and what lets the circuit breaker be shown taking one member out.
  @{ name = "backend-2"; entry = "tools/backend/server.ts"; port = 9081; what = "the second petstore backend" }
  @{ name = "mcp";       entry = "tools/mcp/server.ts";     port = 9085; what = "the MCP server" }
  @{ name = "a2a";       entry = "tools/a2a/agent.ts";      port = 9086; what = "the A2A agent" }
  # The far end of the shared Kafka proxy API: a simulated Confluent REST Proxy v3, cluster
  # `local-cluster`. An administrator points the shared proxy at it from Kafka REST Proxy.
  @{ name = "kafka-rest"; entry = "tools/kafka-rest/server.ts"; port = 9087; what = "the Kafka REST proxy (simulated)" }
)

function Wait-Endpoint {
  param([string] $Url, [string] $What, [int] $TimeoutSec = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-RestMethod -Uri $Url -TimeoutSec 2
      return $response
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "$What did not come up at $Url within ${TimeoutSec}s - check .data/*.log"
}

function Start-Piece {
  param([string] $Name, [string[]] $ArgumentList)
  $proc = Start-Process -FilePath "bun" -ArgumentList $ArgumentList -NoNewWindow -PassThru `
    -RedirectStandardOutput ".data/$Name.out.log" -RedirectStandardError ".data/$Name.err.log"
  return @{ name = $Name; processId = $proc.Id }
}

if ($Down) {
  if (-not (Test-Path $StateFile)) {
    Write-Host "no $StateFile; nothing recorded as running"
    exit 0
  }
  $state = Get-Content $StateFile -Raw | ConvertFrom-Json
  foreach ($piece in $state.pieces) {
    $running = Get-Process -Id $piece.processId -ErrorAction SilentlyContinue
    if ($running) {
      Stop-Process -Id $piece.processId -Force
      Write-Host ("stopped {0} (pid {1})" -f $piece.name, $piece.processId)
    } else {
      Write-Host ("{0} (pid {1}) was not running" -f $piece.name, $piece.processId)
    }
  }
  Remove-Item $StateFile -Force
  exit 0
}

if ($Status) {
  Write-Host "piece        url                       state"
  Write-Host "-----        ---                       -----"
  # Not `$up`: PowerShell variable names are case-insensitive, so a loop variable spelled that way
  # would assign a hashtable to the `-Up` switch parameter and fail on its declared type.
  $checks = @()
  foreach ($upstream in $Upstreams) {
    $checks += @{ name = $upstream.name; url = "http://localhost:$($upstream.port)/healthz" }
  }
  $checks += @{ name = "control"; url = "http://localhost:8080/healthz" }
  foreach ($gw in $Gateways) {
    $checks += @{ name = $gw.name; url = "http://localhost:$($gw.port)/healthz" }
  }
  foreach ($check in $checks) {
    try {
      $health = Invoke-RestMethod -Uri $check.url -TimeoutSec 2
      $detail = if ($health.configDigest) {
        "digest {0}… routes {1} requests {2}" -f $health.configDigest.Substring(0, 14), $health.routes, $health.requestsTotal
      } else { "ok" }
      Write-Host ("{0,-12} {1,-25} {2}" -f $check.name, $check.url, $detail)
    } catch {
      Write-Host ("{0,-12} {1,-25} down" -f $check.name, $check.url)
    }
  }
  exit 0
}

if (-not $Up) {
  Write-Host "usage: stack.ps1 -Up | -Down | -Status [-Rebuild]"
  exit 1
}

New-Item -ItemType Directory -Force -Path .data | Out-Null

# An env file written before a setting was introduced starts a gateway configured by defaults
# nobody chose — and, for the ones that are required, one that refuses to boot naming a variable
# the file does not contain. Reseed instead. The marker is the newest variable seed.ts writes, so
# this check has to move each time one is added.
#
# Since v6 the marker also has to catch a file written *before* the ceilings moved into the
# database: one that still sets MAX_CONCURRENT_UPGRADES starts a gateway that refuses to boot,
# naming the variable. So the check is now in both directions — a file missing what seed.ts writes
# today, or still carrying what it no longer does.
$stale = (Test-Path ".data/env/dev-1") -and (
  -not (Select-String -Path ".data/env/dev-1" -Pattern "BUN_CONFIG_MAX_HTTP_REQUESTS" -Quiet) -or
  (Select-String -Path ".data/env/dev-1" -Pattern "MAX_CONCURRENT_UPGRADES" -Quiet)
)
if ($stale) { Write-Host ".data/env/* predates the v6 gateway settings; reseeding" }

if ($Rebuild -or $stale -or -not (Test-Path ".data/env/dev-1")) {
  # Bun loads .env.local into every process it starts, including the seed. Since the seed is what
  # writes that file, an older one (a v1 PROMOTION_CHAIN, say) would otherwise fight the targets
  # file it is about to seed from.
  if ($Rebuild -and (Test-Path ".env.local")) { Remove-Item ".env.local" -Force }
  Write-Host "seeding (mints one token per gateway, writes .env.local and .data/env/*)"
  bun run scripts/seed.ts
  if ($LASTEXITCODE -ne 0) { throw "seed failed" }
}

$pieces = @()
foreach ($upstream in $Upstreams) {
  # `--port=` on the command line rather than an env var: every one of these tools defaults to its
  # own port, and two copies of the same tool differ only here.
  $pieces += Start-Piece -Name $upstream.name -ArgumentList @("run", $upstream.entry, "--port=$($upstream.port)")
  Wait-Endpoint -Url "http://localhost:$($upstream.port)/healthz" -What $upstream.what | Out-Null
  Write-Host ("{0,-12} http://localhost:{1}     up" -f $upstream.name, $upstream.port)
}

$pieces += Start-Piece -Name "cp" -ArgumentList @("run", "control-plane/src/server.ts")
Wait-Endpoint -Url "http://localhost:8080/healthz" -What "the control plane" | Out-Null
Write-Host "control      http://localhost:8080     up"

foreach ($gw in $Gateways) {
  $envFile = ".data/env/$($gw.name)"
  if (-not (Test-Path $envFile)) { throw "$envFile is missing - run with -Rebuild" }
  $pieces += Start-Piece -Name $gw.name -ArgumentList @(
    "--env-file=$envFile", "run", "data-plane/src/server.ts"
  )
  $health = Wait-Endpoint -Url "http://localhost:$($gw.port)/healthz" -What "gateway $($gw.name)"
  Write-Host ("{0,-12} http://localhost:{1}     up ({2})" -f $gw.name, $gw.port, $health.environment)
}

@{ startedAt = (Get-Date).ToString("o"); pieces = $pieces } | ConvertTo-Json -Depth 4 |
  Set-Content $StateFile

Write-Host ""
Write-Host "stack up. logs in .data/*.log, state in $StateFile"
Write-Host "  UI          http://localhost:8080   (bun run build:ui first, or bun run dev:ui)"
# The upstreams are printed as 127.0.0.1, not localhost: the platform's own egress rule denies the
# PUBLIC_URL host on every port (deny-rules.ts selfRule), and locally that host is localhost.
Write-Host "  MCP server  http://127.0.0.1:9085/mcp   (publish it from APIs -> new mcp API -> Discover)"
Write-Host "  A2A agent   http://127.0.0.1:9086        (its card is at /.well-known/agent-card.json)"
Write-Host "  Kafka REST  http://127.0.0.1:9087        (cluster local-cluster; the shared proxy's backend)"
Write-Host "  walkthrough pwsh -File scripts/demo.ps1"
Write-Host "  stop        pwsh -File scripts/stack.ps1 -Down"
