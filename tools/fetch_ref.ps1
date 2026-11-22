$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
$base = 'https://raw.githubusercontent.com/liyangpengs/qq-farm-bot/master/'
$dst  = Join-Path (Get-Location) 'ref\qq-farm-bot'
New-Item -ItemType Directory -Force -Path $dst | Out-Null

$files = @(
  'docs/README.md',
  'docs/tools.md',
  'docs/network-concurrency.md',
  'core/src/utils/gateway-token.ts',
  'core/src/utils/keepalive-policy.ts',
  'core/src/utils/network.ts',
  'core/src/utils/proto.ts',
  'core/src/utils/request-context.ts',
  'core/src/utils/request-priority.ts',
  'core/src/services/wx-login/service.ts',
  'core/src/services/wx-login/native-protocol.ts',
  'core/src/services/qq-login/service.ts',
  'core/src/services/farm/api.ts',
  'core/src/services/farm/index.ts',
  'core/src/services/farm/scheduler.ts',
  'core/src/services/farm/planting.ts',
  'core/src/services/farm/land-analysis.ts',
  'core/src/services/friend/api.ts',
  'core/src/services/friend/index.ts',
  'core/src/services/friend/scheduler.ts',
  'core/src/services/friend/visit-plan.ts',
  'core/src/services/friend/visit-strategy.ts',
  'core/src/services/interact.ts',
  'core/src/services/ace.ts',
  'core/src/services/rate-limiter.ts',
  'core/src/services/scheduler.ts',
  'core/src/runtime/runtime-engine.ts',
  'core/src/proto/game.proto',
  'core/src/proto/plantpb.proto',
  'core/src/proto/visitpb.proto',
  'core/src/proto/interactpb.proto',
  'core/src/proto/friendpb.proto',
  'core/src/proto/userpb.proto',
  'core/src/proto/acepb.proto',
  'core/src/proto/corepb.proto',
  'core/src/proto/itempb.proto',
  'core/src/proto/miscpb.proto'
)

$ok = 0; $fail = @()
foreach ($f in $files) {
  $out = Join-Path $dst ($f -replace '/', '\')
  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  try {
    Invoke-WebRequest -Uri ($base + $f) -OutFile $out -TimeoutSec 40 -UseBasicParsing
    $sz = (Get-Item $out).Length
    Write-Host ("[OK]   {0,8}  {1}" -f $sz, $f)
    $ok++
  } catch {
    Write-Host "[FAIL] $f  ->  $($_.Exception.Message)"
    $fail += $f
  }
}
Write-Host "[done] ok=$ok fail=$($fail.Count)"
$fail | ForEach-Object { Write-Host "  missed: $_" }
