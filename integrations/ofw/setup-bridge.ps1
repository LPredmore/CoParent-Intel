#requires -Version 5.1
<#
  Set up an independent local OFW -> Supabase Storage bridge.
  Requires the OFW MCP installer already working in Claude Desktop.
  Only creates a private Storage bucket on first "sync"; never alters app tables.
#>
[CmdletBinding()]
param([switch]$ReplaceSecret)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'
$ofwLauncher = Join-Path $root 'Start-OFWMCP.ps1'
if (-not (Test-Path $ofwLauncher)) { throw 'OFW MCP launcher was not found. Complete the earlier Claude Desktop OFW setup first.' }
$node = Get-Command node.exe -ErrorAction Stop
$ver = (& $node.Source --version).TrimStart('v')
if ([version]$ver -lt [version]'22.5.0') {throw "Node.js $ver is too old; install Node 22.5+"}
New-Item -Path $root -ItemType Directory -Force | Out-Null
$bridgeSource='https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/bridge.mjs'
$importSource='https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/import-db.mjs'
$expenseSource='https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/expense-import.mjs'
$attachmentSource='https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/attachment-import.mjs'
$bridge=Join-Path $root 'bridge.mjs'
$importModule=Join-Path $root 'import-db.mjs'
$expenseModule=Join-Path $root 'expense-import.mjs'
$attachmentModule=Join-Path $root 'attachment-import.mjs'
$credFile=Join-Path $root 'supabase-bridge-key.xml'
$launch=Join-Path $root 'Start-OFWBridge.ps1'
Invoke-WebRequest -UseBasicParsing $bridgeSource -OutFile $bridge
Invoke-WebRequest -UseBasicParsing $importSource -OutFile $importModule
Invoke-WebRequest -UseBasicParsing $expenseSource -OutFile $expenseModule
Invoke-WebRequest -UseBasicParsing $attachmentSource -OutFile $attachmentModule
if (-not (Test-Path $bridge) -or -not (Test-Path $importModule) -or -not (Test-Path $expenseModule) -or -not (Test-Path $attachmentModule)) { throw 'Bridge or importer module download failed' }
Write-Host ''
Write-Host 'Copy the actual Project URL from Supabase Dashboard > Integrations > Data API (or the project Connect dialog).' -ForegroundColor Cyan
Write-Host 'The previous hardcoded hostname did not resolve. Do not assume it is the right project.'
Write-Host 'Example: https://abcdefghijklmnopqrst.supabase.co'
$inputUrl=(Read-Host 'Paste the full Supabase Project URL').Trim().TrimEnd('/')
$projectUrl=$inputUrl -replace '/rest/v1$',''
if($projectUrl -cnotmatch '^https://[a-z0-9-]+\.supabase\.co$'){
  throw 'Invalid Project URL. Copy the HTTPS URL ending in .supabase.co from Data API, not a dashboard URL.'
}
$hostName=([uri]$projectUrl).DnsSafeHost
Write-Host "Checking DNS for $hostName ..."
try{
  $ips=[System.Net.Dns]::GetHostAddresses($hostName)
  if(-not $ips -or $ips.Count -lt 1){throw 'No DNS addresses returned'}
}catch{
  $generalDnsOk=$false
  try{
    $publicDns=[System.Net.Dns]::GetHostAddresses('supabase.co')
    $generalDnsOk=($null -ne $publicDns -and $publicDns.Count -gt 0)
  }catch{$generalDnsOk=$false}
  if($generalDnsOk){
    throw "Cannot resolve $hostName. Check the copied URL, and whether this project is paused, deleted, or missing DNS records. No credentials changed."
  }
  throw "DNS resolution failed for both $hostName and supabase.co. Check your computer's network and DNS configuration. No credentials changed."
}
Write-Host "Supabase project hostname resolved: $hostName" -ForegroundColor Green
$projectRef=$hostName.Split('.')[0]
$configFile=Join-Path $root 'supabase-bridge-config.json'
$utf8=New-Object System.Text.UTF8Encoding($false)
$configJson=([pscustomobject]@{supabase_url=$projectUrl}|ConvertTo-Json -Compress)
[System.IO.File]::WriteAllText($configFile,$configJson,$utf8)
Write-Host ''
Write-Host 'Supabase Secret API key name: ofw_bridge (underscore).'
Write-Host ("Ensure this key was created in the SAME project: https://supabase.com/dashboard/project/" + $projectRef + "/settings/api-keys") -ForegroundColor Yellow
Write-Host 'If the older setup saved a key without a project binding, it must be re-entered.'
Write-Host 'The key VALUE begins with sb_secret_. It is unrelated to the project hostname.'
$needsKey=$ReplaceSecret -or -not (Test-Path -LiteralPath $credFile)
if(-not $needsKey){
  try{
    $stored=Import-Clixml -LiteralPath $credFile
    if(-not ($stored -is [System.Management.Automation.PSCredential])){throw 'Invalid saved credential'}
    if($stored.UserName -ne ('supabase_secret|' + $projectRef)){ throw 'Previously saved key is unbound or belongs to a different project' }
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($stored.Password)
    try{
      $testValue=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
      $isValid=$testValue.StartsWith('sb_secret_')
    }finally{
      $testValue=$null
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
    if(-not $isValid){$needsKey=$true}
    $stored=$null
  }catch{$needsKey=$true}
}
if($needsKey){
  Write-Host 'Paste your Secret API key into the hidden prompt. Do not use a publishable or legacy key.'
  $secret=Read-Host 'Supabase Secret API key, sb_secret_... (hidden)' -AsSecureString
  if(-not $secret -or $secret.Length -lt 25){throw 'A Supabase Secret API key is required'}
  $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try{
    $testValue=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $isValid=$testValue.StartsWith('sb_secret_')
  }finally{
    $testValue=$null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
  if(-not $isValid){throw 'The key must start with sb_secret_'}
  [pscredential]::new(('supabase_secret|' + $projectRef),$secret) | Export-Clixml -LiteralPath $credFile -Force
  $secret=$null
}else{
  Write-Host 'Reusing your already encrypted Supabase Secret API key.' -ForegroundColor Green
}
$launcherText=@'
$ErrorActionPreference='Stop'
$root=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'
$cred=Import-Clixml -LiteralPath (Join-Path $root 'supabase-bridge-key.xml')
$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($cred.Password)
try { $env:SUPABASE_SECRET_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
$config=Get-Content -LiteralPath (Join-Path $root 'supabase-bridge-config.json') -Raw | ConvertFrom-Json
$env:SUPABASE_URL=$config.supabase_url
$env:OFW_BRIDGE_BUCKET='ofw-bridge'
$ofwCred=Import-Clixml -LiteralPath (Join-Path $root 'ofw-credential.xml')
$env:OFW_USERNAME=$ofwCred.UserName
$ofwPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($ofwCred.Password)
try { $env:OFW_PASSWORD=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ofwPtr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ofwPtr) }
$env:OFW_WRITE_MODE='drafts'
$env:OFW_ALLOW_MARK_READ='false'
$env:OFW_CONFIRM_MARK_READ='false'
$env:OFW_FETCH_UNREAD_BODIES='false'
$env:OFW_CALENDAR_WRITES='false'
$env:OFW_DISABLE_FETCHPROXY='1'
$env:OFW_MCP_ENTRY=Join-Path $root 'runtime\node_modules\ofw-mcp\dist\index.js'
$node='__NODE_EXECUTABLE__'
& $node (Join-Path $root 'bridge.mjs') @args
exit $LASTEXITCODE
'@
$launcherText=$launcherText.Replace('__NODE_EXECUTABLE__',$node.Source.Replace("'", "''"))
$utf8=New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($launch,$launcherText,$utf8)
Write-Host ''
Write-Host 'Local bridge installed. Testing OFW authentication and Supabase access...' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launch probe
if ($LASTEXITCODE -ne 0) {throw 'Connection probe failed. No export was started; check the error above.'}
Write-Host ''
Write-Host 'Bridge probe passed. Run this next command in PowerShell to export the existing OFW cache and calendar to private Storage:' -ForegroundColor Green
Write-Host ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "'+$launch+'" sync')
