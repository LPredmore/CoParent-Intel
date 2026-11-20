#requires -Version 5.1
<#
  One-time OFFLINE-SAFE Supabase key diagnostic.
  Makes only read-only GET requests to /rest/v1/. Does not change local
  credentials, the Supabase project, Storage, or OFW records.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'
$configPath = Join-Path $root 'supabase-bridge-config.json'
$credentialPath = Join-Path $root 'supabase-bridge-key.xml'
if (!(Test-Path -LiteralPath $configPath) -or !(Test-Path -LiteralPath $credentialPath)) { throw 'Bridge config or saved encrypted key missing; no request made.' }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$url = ([string]$config.supabase_url).TrimEnd('/')
if ($url -ne 'https://zhnpbajmumsbejyoqysr.supabase.co') { throw ('Expected the agreed target project; saved URL is '+$url+'. No request made.') }
$cred = Import-Clixml -LiteralPath $credentialPath
if ($cred -isnot [System.Management.Automation.PSCredential]) { throw 'Invalid stored credential file.' }
if ($cred.UserName -ne 'supabase_secret|zhnpbajmumsbejyoqysr') { throw 'Saved key does not match intended project binding.' }
$savedKey = $cred.GetNetworkCredential().Password
if (!$savedKey.StartsWith('sb_secret_')) { throw 'Saved key format not recognized.' }
Write-Host 'This will compare your saved key with a fresh Dashboard copy (without printing either one).' -ForegroundColor Cyan
Write-Host 'It will NOT export, change, or read any OFW messages or Supabase database tables.'
$freshSecure = Read-Host 'Paste Secret API key from THIS Supabase project (hidden, not saved)' -AsSecureString
$freshCred = [pscredential]::new('diagnostic',$freshSecure)
$freshKey = $freshCred.GetNetworkCredential().Password
if (!$freshKey.StartsWith('sb_secret_')) { throw 'That value does not begin with sb_secret_; no request made.' }
$match = [string]::Equals($savedKey,$freshKey,[StringComparison]::Ordinal)
$unwanted = [regex]::IsMatch($freshKey, '[\s"''\x60]')
Write-Host ('Saved and freshly pasted key are EXACTLY identical: '+ $(if($match){'YES'}else{'NO'}))
Write-Host ('Fresh key contains whitespace or quote characters: '+ $(if($unwanted){'YES'}else{'NO'}))
function Test-Key([string]$label,[string]$apiKey) {
  $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($url+'/rest/v1/')
  $req.Method = 'GET'
  $req.Accept = 'application/json'
  $req.UserAgent = 'CoParentIntel-OFWBridge/0.2 (Node.js backend)'
  $req.Timeout = 30000
  $req.Headers.Add('apikey',$apiKey)
  $resp = $null
  try { $resp = [System.Net.HttpWebResponse]$req.GetResponse() }
  catch [System.Net.WebException] {
    if ($null -eq $_.Exception.Response) {
      return [pscustomobject]@{KeySource=$label;Status='NETWORK_ERROR';RequestId='';Error='No HTTP response'}
    }
    $resp = [System.Net.HttpWebResponse]$_.Exception.Response
  }
  try {
    $status=[int]$resp.StatusCode
    $id=[string]$resp.Headers['sb-request-id']
    if (!$id) { $id=[string]$resp.Headers['x-request-id'] }
    $err=''
    if ($status -lt 200 -or $status -ge 300) {
      $stream=$resp.GetResponseStream()
      if ($stream) {
        $reader=[System.IO.StreamReader]::new($stream)
        try {
          $buffer=New-Object char[] 1500
          $count=$reader.Read($buffer,0,$buffer.Length)
          if($count -gt 0){$err=-join $buffer[0..($count-1)]}
        } finally {$reader.Dispose()}
      }
      $err=$err.Replace($apiKey,'[REDACTED_SECRET]')
      $err=[regex]::Replace($err,'sb_secret_[A-Za-z0-9_-]+','[REDACTED_SECRET]')
    }
    return [pscustomobject]@{KeySource=$label;Status=$status;RequestId=$id;Error=$err}
  } finally { $resp.Close() }
}
$results=@(Test-Key 'Freshly copied Dashboard key' $freshKey)
if (!$match) { $results+=Test-Key 'Previously saved encrypted key' $savedKey }
$results | Format-List
if ($match -and $results[0].Status -eq 401) {
 Write-Host 'STOP: Identical key rejected by a direct PowerShell request. No more bridge/key retries recommended.' -ForegroundColor Yellow
} elseif ($results[0].Status -ge 200 -and $results[0].Status -lt 300) {
 Write-Host 'SUCCESS: Direct API request works. Investigate saved credentials or Node request path as indicated above.' -ForegroundColor Green
} else {
 Write-Host 'STOP: Examine exact HTTP status above. No application data was changed.' -ForegroundColor Yellow
}
