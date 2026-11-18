#requires -Version 5.1
<#
  Set up an independent local OFW -> Supabase Storage bridge.
  Requires the OFW MCP installer already working in Claude Desktop.
  Only creates a private Storage bucket on first "sync"; never alters app tables.
#>
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
$bridge=Join-Path $root 'bridge.mjs'
$credFile=Join-Path $root 'supabase-bridge-key.xml'
$launch=Join-Path $root 'Start-OFWBridge.ps1'
Invoke-WebRequest -UseBasicParsing $bridgeSource -OutFile $bridge
if (-not (Test-Path $bridge)) { throw 'Bridge download failed' }
Write-Host ''
Write-Host 'Find your project service_role (legacy) key in Supabase:'
Write-Host 'https://supabase.com/dashboard/project/nukdhsxnaonzsskmchov/settings/api-keys'
Write-Host 'Choose the service_role secret from LEGACY API KEYS, not the anon or publishable key.'
Write-Host 'Paste it at the private password prompt below. The key is encrypted for this Windows user.'
$secret=Read-Host 'Supabase service_role key (hidden)' -AsSecureString
if (-not $secret -or $secret.Length -lt 20) {throw 'A valid-looking service_role key is required'}
$cred=[pscredential]::new('service_role',$secret)
$cred | Export-Clixml -LiteralPath $credFile -Force
$cred=$null
$secret=$null
$launcherText=@'
$ErrorActionPreference='Stop'
$root=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'
$cred=Import-Clixml -LiteralPath (Join-Path $root 'supabase-bridge-key.xml')
$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($cred.Password)
try { $env:SUPABASE_SERVICE_ROLE_KEY=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
$env:SUPABASE_URL='https://nukdhsxnaonzsskmchov.supabase.co'
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
