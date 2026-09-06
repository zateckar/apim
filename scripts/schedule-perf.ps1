<#
.SYNOPSIS
  Register (or remove) a daily Windows scheduled task that runs the quick performance profile.

.DESCRIPTION
  One of the three ways the load suite is "used regularly" (plan G6). The other two need no
  setup: the guardrail in `bun test` runs on every test run, and `.github/workflows/perf.yml`
  runs the same profile on a schedule wherever this repository has a remote.

  This script prints exactly what it will register and asks before doing it, because registering
  a scheduled task is a change to the machine rather than to the repository.

.EXAMPLE
  pwsh -File scripts/schedule-perf.ps1
  pwsh -File scripts/schedule-perf.ps1 -At 02:30
  pwsh -File scripts/schedule-perf.ps1 -Remove
#>
[CmdletBinding()]
param(
  [string] $At = "03:00",
  [string] $TaskName = "apim-perf-quick",
  [switch] $Remove,
  [switch] $Force
)

$ErrorActionPreference = "Stop"
$repository = Split-Path $PSScriptRoot -Parent
Set-Location $repository

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Host "no scheduled task named $TaskName"
    exit 0
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "removed the scheduled task $TaskName"
  exit 0
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue)?.Source
if (-not $bun) { throw "bun is not on PATH; the task would fail" }

Write-Host "About to register a Windows scheduled task:"
Write-Host ""
Write-Host "  name       $TaskName"
Write-Host "  runs       daily at $At"
Write-Host "  command    $bun run tools/loadgen/index.ts --profile=quick"
Write-Host "  directory  $repository"
Write-Host "  writes     reports/perf-report.md, .data/perf/<timestamp>.json, .data/perf/history.jsonl"
Write-Host "  takes      about four minutes, and saturates a few cores while it runs"
Write-Host ""
Write-Host "It builds its own isolated world on ephemeral ports, so it will not disturb a stack"
Write-Host "you have running."
Write-Host ""

if (-not $Force) {
  $answer = Read-Host "Register it? [y/N]"
  if ($answer -notin @("y", "Y", "yes")) {
    Write-Host "nothing registered"
    exit 0
  }
}

$action = New-ScheduledTaskAction -Execute $bun `
  -Argument "run tools/loadgen/index.ts --profile=quick" -WorkingDirectory $repository
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "APIM gateway performance, quick profile" -Force | Out-Null

Write-Host "registered $TaskName. Run it now with: Start-ScheduledTask -TaskName $TaskName"
Write-Host "remove it with: pwsh -File scripts/schedule-perf.ps1 -Remove"
