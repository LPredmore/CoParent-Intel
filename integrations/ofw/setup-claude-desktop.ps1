#requires -Version 5.1
<#
  Installs a read/calendar/draft-only OurFamilyWizard MCP connection for Claude Desktop.
  No application or Supabase database changes. No OFW credentials are committed to GitHub.
  Credentials are encrypted locally with Windows DPAPI for the current Windows user.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($env:OS -ne 'Windows_NT') { throw 'This setup script is for Windows.' }

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'Node.js 22.5 or newer is required. Install Node.js LTS from https://nodejs.org/ and rerun this script.' }
$nodeExe = $nodeCmd.Source
$nodeVersionText = (& $nodeExe --version).TrimStart('v')
if ([version]$nodeVersionText -lt [version]'22.5.0') {
  throw "Node.js version $nodeVersionText is too old. Install Node.js 22.5 or newer."
}
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { throw 'npm.cmd was not found. Reinstall Node.js with npm.' }

$root = Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'
$runtime = Join-Path $root 'runtime'
$credentialFile = Join-Path $root 'ofw-credential.xml'
$launcherFile = Join-Path $root 'Start-OFWMCP.ps1'
$claudeDir = Join-Path $env:APPDATA 'Claude'
$claudeConfig = Join-Path $claudeDir 'claude_desktop_config.json'
New-Item -Path $runtime, $claudeDir -ItemType Directory -Force | Out-Null

# Pin the upstream release. Never install the latest version without review.
Write-Host 'Installing pinned OurFamilyWizard MCP package (2.26.1)...'
& $npmCmd.Source install --prefix $runtime --no-save --no-audit --no-fund --ignore-scripts 'ofw-mcp@2.26.1'
if ($LASTEXITCODE -ne 0) { throw 'npm installation failed. Claude configuration was not changed.' }
$entry = Join-Path $runtime 'node_modules\ofw-mcp\dist\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw "OFW MCP entry point not found at $entry" }

Write-Host 'Enter your OurFamilyWizard login in the secure Windows credential prompt.'
$credential = Get-Credential -Message 'OurFamilyWizard account (email address and password)'
if (-not $credential) { throw 'Credentials were not entered; setup stopped.' }
$credential | Export-Clixml -LiteralPath $credentialFile -Force
$credential = $null

# The launcher decrypts credentials only when the MCP starts; Claude config contains no secrets.
$launcherText = @'
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'
$cred = Import-Clixml -LiteralPath (Join-Path $root 'ofw-credential.xml')
if (-not ($cred -is [System.Management.Automation.PSCredential])) {
  throw 'Encrypted OFW credential missing or unreadable. Rerun the setup under the original Windows user.'
}
$env:OFW_USERNAME = $cred.UserName
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($cred.Password)
try {
  $env:OFW_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
$env:OFW_WRITE_MODE = 'drafts'
$env:OFW_ALLOW_MARK_READ = 'false'
$env:OFW_CONFIRM_MARK_READ = 'false'
$env:OFW_FETCH_UNREAD_BODIES = 'false'
$env:OFW_CALENDAR_WRITES = 'false'
$env:OFW_DISABLE_FETCHPROXY = '1'
$entry = Join-Path $root 'runtime\node_modules\ofw-mcp\dist\index.js'
$nodeExe = '__NODE_EXE__'
& $nodeExe $entry
exit $LASTEXITCODE
'@
$launcherText = $launcherText.Replace('__NODE_EXE__', $nodeExe.Replace("'", "''"))
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($launcherFile, $launcherText, $utf8)

# Do not overwrite any other MCP connections or settings.
if (Test-Path -LiteralPath $claudeConfig) {
  $configText = [System.IO.File]::ReadAllText($claudeConfig)
  if ($configText.Trim()) {
    $config = $configText | ConvertFrom-Json
  } else {
    $config = [pscustomobject]@{}
  }
  Copy-Item -LiteralPath $claudeConfig -Destination ($claudeConfig + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) -Force
} else {
  $config = [pscustomobject]@{}
}
if (-not $config.PSObject.Properties['mcpServers']) {
  $config | Add-Member -NotePropertyName 'mcpServers' -NotePropertyValue ([pscustomobject]@{})
}
$ofwConfig = [pscustomobject]@{
  command = 'powershell.exe'
  args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $launcherFile)
}
if ($config.mcpServers.PSObject.Properties['ofw']) {
  $config.mcpServers.ofw = $ofwConfig
} else {
  $config.mcpServers | Add-Member -NotePropertyName 'ofw' -NotePropertyValue $ofwConfig
}
$json = $config | ConvertTo-Json -Depth 40
[System.IO.File]::WriteAllText($claudeConfig, ($json + [Environment]::NewLine), $utf8)
$null = ([System.IO.File]::ReadAllText($claudeConfig) | ConvertFrom-Json)

Write-Host ''
Write-Host 'OFW MCP configured for Claude Desktop.' -ForegroundColor Green
Write-Host "Claude config: $claudeConfig"
Write-Host "Encrypted credential: $credentialFile"
Write-Host "MCP launcher: $launcherFile"
Write-Host 'Fully quit and reopen Claude Desktop, then ask: "Use ofw_get_profile to check my OFW connection."'
Write-Host 'This setup does not send messages, open unread message bodies, or edit OFW calendar entries.'
