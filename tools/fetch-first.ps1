$ProgressPreference='SilentlyContinue'
$base='http://127.0.0.1:18927/assets/'
$dst='out\first'
New-Item -ItemType Directory -Force -Path $dst | Out-Null

$chunks = @(
 '_plugin-vue_export-helper-DWcVQE5U.js','Cloud-BEh4ifVd.js','CodeBrowser-BxjYFVDO.js',
 'Control-DIwKPZH7.js','Devtools-Cvc1pZrP.js','Extract-jIoj7lNf.js','Faq-GDU6n2Ek.js',
 'Feedback-CA1Su_LU.js','Hook-CppfXnFQ.js','Mcp-MRGtnCK-.js','Navigator-aUIM301u.js',
 'Settings-DfWNvMJQ.js','Targets-Ca7ghKlt.js','ToggleSwitch-ChsozSAo.js',
 'VConsole-BUDzkaIB.js','WxApi-BRz0TJcR.js'
)
foreach($c in $chunks){
  try{
    $r=Invoke-WebRequest -Uri ($base+$c) -TimeoutSec 15 -UseBasicParsing
    [System.IO.File]::WriteAllText((Join-Path $PWD "$dst\$c"), $r.Content)
    Write-Host ("[ok] {0,8}  {1}" -f $r.Content.Length, $c)
  }catch{ Write-Host "[fail] $c  $($_.Exception.Message)" }
}
