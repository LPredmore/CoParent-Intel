# OurFamilyWizard MCP connection

This setup is independent of the CoParent-Intel application and database. It installs the upstream OFW MCP locally for Claude Desktop. No React, OpenRouter, or Supabase code or schema is changed.

## Windows setup

1. Install Claude Desktop (https://claude.ai/download) and Node.js 22.5+ (https://nodejs.org/) if necessary.
2. Open Windows PowerShell and run the following as ONE line:

    $p=Join-Path $env:TEMP 'setup-ofw-claude.ps1'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/setup-claude-desktop.ps1' -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p

3. In the Windows credential prompt, enter your OurFamilyWizard email address and password. Do not share them in chat or commit them to GitHub.
4. Fully quit Claude Desktop and reopen it.
5. Ask Claude: 'Use ofw_get_profile to check my OFW connection.' The OFW MCP must authenticate successfully before calling the connection complete.

## Environment variable names

OFW_USERNAME = the email in the secure Windows prompt
OFW_PASSWORD = the password in the secure Windows prompt
OFW_WRITE_MODE = drafts
OFW_ALLOW_MARK_READ = false
OFW_CONFIRM_MARK_READ = false
OFW_FETCH_UNREAD_BODIES = false
OFW_CALENDAR_WRITES = false
OFW_DISABLE_FETCHPROXY = 1

The two credentials are encrypted for your Windows user profile with DPAPI at %LOCALAPPDATA%\CoParentIntel\OFW\ofw-credential.xml. The launcher decrypts them only when starting the MCP process. They are NOT stored in GitHub or Supabase.

Claude Desktop configuration: %APPDATA%\Claude\claude_desktop_config.json
Launcher: %LOCALAPPDATA%\CoParentIntel\OFW\Start-OFWMCP.ps1
Installed upstream package: %LOCALAPPDATA%\CoParentIntel\OFW\runtime\node_modules\ofw-mcp (pinned 2.26.1)

## Restrictions and status

Allowed: reading message metadata and already-read message bodies, listing OFW calendar and parenting events, listing drafts, creating draft messages.
Blocked: sending any message, modifying OFW calendar events, marking previously unread messages as read, and other high-impact OFW writes.

This installer does not make a live OFW request; credentials and a local Windows execution are required first. It does not create automatic synchronization with Supabase, does not run continuously when your computer is off, and does not connect OFW to the ChatGPT Plus web session.

The upstream project is unofficial and AI-developed and has not received a human security audit. Review the code and OFW terms before running it. Upstream: https://github.com/chrischall/ofw-mcp

## Optional independent Supabase Storage bridge

The working Claude Desktop OFW MCP remains the source connector. The bridge is a separate local Node process that calls the same restricted MCP. It does not touch CoParent-Intel application code, existing Supabase tables, RLS, or OpenRouter. It exports JSON records into a NEW private Supabase Storage bucket named `ofw-bridge`.

### One-time bridge setup

1. Open https://supabase.com/dashboard/project/nukdhsxnaonzsskmchov/settings/api-keys and copy the **legacy service_role** secret key. Do not copy the anon/publishable key and never paste the secret in chat.
2. Run this ONE physical line in Windows PowerShell:

    $p=Join-Path $env:TEMP 'setup-ofw-bridge.ps1'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/setup-bridge.ps1' -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p

3. Enter that service_role key at the **hidden** Windows secure prompt. It is encrypted locally with Windows DPAPI at `%LOCALAPPDATA%\CoParentIntel\OFW\supabase-bridge-key.xml` and never stored in GitHub.
4. Setup executes `probe` (OFW login health and Supabase key check). The private bucket may show `storageBucketReady:false` until the first sync creates it.
5. After the probe, run the following one-line command to perform the initial export:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CoParentIntel\OFW\Start-OFWBridge.ps1" sync

On successful export, look in your project Supabase Dashboard -> Storage -> `ofw-bridge` for `manifest/latest.json`. The manifest points to complete timestamped run folders (`runs/<runId>/messages/...` and `runs/<runId>/calendar.json`). The manifest is updated only after every file was uploaded.

### Bridge environment configuration

| Variable | Source |
| --- | --- |
| `SUPABASE_URL` | `https://nukdhsxnaonzsskmchov.supabase.co` (set by launcher) |
| `SUPABASE_SERVICE_ROLE_KEY` | Decrypted locally from Windows credential file by launcher |
| `OFW_BRIDGE_BUCKET` | `ofw-bridge` (private) |
| `OFW_MCP_ENTRY` | Existing pinned local `ofw-mcp` Node entry point (OFW credentials are decrypted from the original Windows DPAPI file) |

The bridge starts the third-party OFW MCP directly as a Node child process, preserving JSON and Unicode over stdio. It never passes the Supabase service-role key to that child process. That key is high privilege: keep it only on your trusted Windows machine, do not expose it in client code or environment variables committed to GitHub.

### Allowed operations

- `probe`: verify OFW authentication and Supabase access; no OFW mutation and no data upload.
- `sync`: refresh the OFW cache (without opening unread inbox messages), export all Inbox/Sent records and 30 days past/180 days future detailed calendar to private Storage. This is a MANUAL operation until separately scheduled.
- `draft <path-to-json>`: explicitly create an OFW draft (NEVER send); record a `draft-receipts/<requestId>.json` state in private Storage to avoid blind duplicate retries. Existing draft replacement is supported with optional `messageId` and `expectedRevision`, subject to upstream conflict controls. Do not execute this command until the app provides a trusted draft request. A failed request with a `started` receipt requires human reconciliation; it must not be retried blindly.

Example draft-request JSON fields: `requestId` (unique 8-100 character alphanumeric/hyphen/underscore ID), `subject`, `body`, optionally `replyToId` (number), `messageId` (number), and `expectedRevision` (string). OurFamilyWizard does not persist recipients on drafts, so they need manual review when sending.

### Important limits

- The bridge stores raw export JSON in private Supabase Storage. It does NOT directly insert records in the app's existing tables or connect to Google Calendar; the app's owner will handle ingestion and application features separately.
- The draft command is callable by a trusted local process. A Supabase queue consumer or automatic processing schedule is NOT installed; those require app workflow integration.
- This bridge runs locally and is not a remotely hosted service. The user's PC must be on for exports. No Windows Scheduled Task is created.
- The local MCP was verified by the user. This bridge code has been syntax-checked, but the Supabase bridge itself needs the local Windows setup, project key, and a real `probe`/`sync` run before production operation is confirmed.
