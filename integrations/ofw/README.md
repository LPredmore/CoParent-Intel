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

1. Open the **correct, active Supabase project** in https://supabase.com/dashboard. In **Integrations > Data API**, copy its **Project URL**, in the form `https://<project-ref>.supabase.co`. Check that the project is running (not paused). Then, in the same project's **Project Settings > API Keys > Publishable and secret API keys**, create a dedicated **Secret API key** named `ofw_bridge` (underscore, not hyphen) if you haven't already. Copy its `sb_secret_...` value; never paste the key in chat.
2. Run this ONE physical line in Windows PowerShell:

    $p=Join-Path $env:TEMP 'setup-ofw-bridge.ps1'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/setup-bridge.ps1' -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p

3. The installer asks for the verified **Project URL**, checks its DNS record, and reuses a previously encrypted `sb_secret_...` key ONLY if that credential is bound to the same project ref. Older unbound credentials require reentry. Otherwise, enter the Secret API key at the **hidden** Windows secure prompt. The key is encrypted locally with Windows DPAPI at `%LOCALAPPDATA%\CoParentIntel\OFW\supabase-bridge-key.xml`; it is not stored in GitHub. To replace a previously saved key, rerun the script with `-ReplaceSecret`.
4. Setup executes `probe` (OFW login health and Supabase key check). The private bucket may show `storageBucketReady:false` until the first sync creates it.
5. After the probe, run the following one-line command to perform the initial export:

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CoParentIntel\OFW\Start-OFWBridge.ps1" sync

On successful export, look in your project Supabase Dashboard -> Storage -> `ofw-bridge` for `manifest/latest.json`. The manifest points to complete timestamped run folders (`runs/<runId>/messages/...` and `runs/<runId>/calendar.json`). The manifest is updated only after every file was uploaded.

### Bridge environment configuration

| Variable | Source |
| --- | --- |
| `SUPABASE_URL` | Actual Project URL copied from Supabase Dashboard, saved in `%LOCALAPPDATA%\CoParentIntel\OFW\supabase-bridge-config.json` (not hardcoded) |
| `SUPABASE_SECRET_KEY` | New opaque `sb_secret_...` value, decrypted locally from Windows credential file by launcher |
| `OFW_BRIDGE_BUCKET` | `ofw-bridge` (private) |
| `OFW_MCP_ENTRY` | Existing pinned local `ofw-mcp` Node entry point (OFW credentials are decrypted from the original Windows DPAPI file) |

The bridge starts the third-party OFW MCP directly as a Node child process, preserving JSON and Unicode over stdio. It never passes the Supabase Secret API key to that child process. It sends the key as `apikey` to the Data API; to Storage it sends both `apikey` and `Authorization: Bearer <key>`, matching the current `supabase-js` Storage request wrapper. The gateway handles new opaque keys. The key is high privilege: keep it only on your trusted Windows machine, never in frontend code or committed to GitHub.

### Allowed operations

- `probe`: verify OFW authentication and Supabase access; no OFW mutation and no data upload.
- `storage-test`: create or reuse the new **private** `ofw-bridge` bucket, upload and read back one harmless synthetic JSON test object (`_checks/bridge-storage-test.json`), and verify an exact round trip. Does not export OFW records or alter the app database. Run it once after the first successful probe, before a full sync.
- `sync`: refresh the OFW cache (without opening unread inbox messages), export all Inbox/Sent records and 30 days past/180 days future detailed calendar to private Storage. This is a MANUAL operation until separately scheduled.
- `draft <path-to-json>`: explicitly create an OFW draft (NEVER send); record a `draft-receipts/<requestId>.json` state in private Storage to avoid blind duplicate retries. Existing draft replacement is supported with optional `messageId` and `expectedRevision`, subject to upstream conflict controls. Do not execute this command until the app provides a trusted draft request. A failed request with a `started` receipt requires human reconciliation; it must not be retried blindly.

Example draft-request JSON fields: `requestId` (unique 8-100 character alphanumeric/hyphen/underscore ID), `subject`, `body`, optionally `replyToId` (number), `messageId` (number), and `expectedRevision` (string). OurFamilyWizard does not persist recipients on drafts, so they need manual review when sending.

### Important limits

- The bridge stores raw export JSON in private Supabase Storage. It does NOT directly insert records in the app's existing tables or connect to Google Calendar; the app's owner will handle ingestion and application features separately.
- The draft command is callable by a trusted local process. A Supabase queue consumer or automatic processing schedule is NOT installed; those require app workflow integration.
- This bridge runs locally and is not a remotely hosted service. The user's PC must be on for exports. No Windows Scheduled Task is created.
- The local MCP was verified by the user. This bridge code has been syntax-checked, but the Supabase bridge itself needs the local Windows setup, project key, and a real `probe`/`sync` run before production operation is confirmed.

### Diagnosing an `ENOTFOUND` Supabase hostname error

An `ENOTFOUND <project-ref>.supabase.co` error happens before the API key can be authenticated. The original installer mistakenly hardcoded the project URL from old application code. The new setup validates the URL you copy from the Supabase dashboard and checks DNS *before* attempting authentication. A key label such as `ofw_bridge` is unrelated to that hostname.

If the hostname does not resolve, compare the exact Project URL, verify that Supabase reports the project as active (not paused), and test your local DNS. If only this hostname fails despite a correct active project, contact Supabase support; if every Supabase hostname fails, check your computer or network DNS settings. Do not rotate the Secret API key to fix DNS errors.

### Storage authentication: missing authorization header

A previous bridge version produced `Invalid Compact JWS` when it sent `Authorization: Bearer sb_secret_...` while the saved key was invalid. The November 20 direct comparison confirmed that the saved credential differed from a working Dashboard key. The current bridge uses the same two headers as `supabase-js` for Storage (`apikey` and `Authorization`) and independently tests the Data API with the key in `apikey`.

- `PROJECT_KEY_REJECTED` or an API-key verification 401/403: the saved credential is not being accepted. Run `diagnose-supabase.ps1` to compare it with a freshly copied Dashboard value before drawing conclusions. The verified key can be safely saved with the `-RepairSavedKey` switch.
- `STORAGE_MISSING_AUTH_HEADER` or `STORAGE_AUTH_INVALID_JWS`: the Storage header or gateway translation failed even after the key was verified. Report the exact sanitized error before running any import.
- A successful `probe` must verify OFW authentication, Data API key acceptance, and private Storage access. Only then perform a `sync`.

The Project URL is the root `https://<project-ref>.supabase.co`; omit `/rest/v1/`.

To refresh only the bridge script and rerun the probe **without reentering the secret or resetting the URL**, use this one-line PowerShell command:

    $b=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/bridge.mjs' -OutFile (Join-Path $b 'bridge.mjs'); powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $b 'Start-OFWBridge.ps1') probe

A successful probe confirms access but does not upload OFW data. Do not run `sync` until the probe succeeds.

### Project/key mismatch (November 2026)

The frontend code in `lib/supabase.ts` currently points to project `nukdhsxnaonzsskmchov`, while the user provided a different active dashboard Project URL `https://zhnpbajmumsbejyoqysr.supabase.co`. Those are distinct projects. Before importing any OFW content, confirm which project is the intended database destination; the bridge MUST use that project's own Secret API key. Do not change the app's backend URL without an independent deployment and data migration plan.

The revised installer binds its DPAPI-protected credential to the selected project ref and will ask for a new key when changing projects or migrating from an older, unbound key file. The key label `ofw_bridge` is not the key's value. The setup command remains the same; when prompted, copy the `sb_secret_...` value from the matching project's API Keys page. No OFW data is exported by a `probe`.

### Read-only diagnosis before any first import

As of November 18, 2026, project `zhnpbajmumsbejyoqysr` is the intended empty destination Supabase project. The current live application's database remains in Lovable and migration is explicitly deferred. Older frontend `lib/supabase.ts` code pointing to another ref is not evidence of the intended destination for this new, isolated bridge; do not alter the application or schema as part of bridge connectivity testing.

The `probe` command now independently attempts read-only GET requests to `/rest/v1/` and `/storage/v1/bucket`. It reports each HTTP status and sanitized error body instead of treating every 401 as an invalid key. It doesn't read application tables, write any objects, or mark OFW messages read. On either test failure, it returns a nonzero exit code so the installer does not claim the bridge is ready. Exact HTTP status alone is not sufficient to conclude an API key is invalid.

To rotate only the bridge key without disturbing the existing one: open the target project's **Settings > API Keys > Publishable and secret API keys**, create a new Secret API key named `ofw_bridge_v2`, copy the `sb_secret_...` value, then run the installer with `-ReplaceSecret` and paste the actual project base URL. Do not delete the older key until the new one is verified, and never paste the secret in chat or commit it to GitHub. Run only `probe`, NOT `sync`, until reviewed.

### First private Storage write/read verification

After `probe` returns Data API 200 and Storage 200, run **one** synthetic write/read test before exporting private OFW records:

    $b=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/bridge.mjs' -OutFile (Join-Path $b 'bridge.mjs'); powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $b 'Start-OFWBridge.ps1') storage-test

The command creates the private bucket if missing, writes the fixed synthetic `_checks/bridge-storage-test.json` object, reads it back, and confirms it has the same random nonce. It is a deliberately **non-OFW** write; no sensitive message or calendar content is exported. Do not perform `sync` unless `writeVerified` and `readVerified` are both true. The synthetic check object remains privately stored in the bucket.

### Verified root cause and one-time fix (November 20, 2026)

Direct read-only tests showed the current Supabase Dashboard Secret key returned HTTP 200, while the encrypted key installed by prior bridge runs returned HTTP 401. The values were **not identical**. This establishes a stale or incorrect locally saved credential, not a confirmed gateway outage. The cause of the discrepancy (older/rotated key versus prior input) remains unknown; the installer code itself has not been proven to corrupt it.

The `diagnose-supabase.ps1 -RepairSavedKey` mode prompts once for the Dashboard key. It **only** overwrites the DPAPI-encrypted local bridge credential if the freshly supplied key first returns HTTP 200 from the correct project's `/rest/v1/` endpoint. It encrypts to a candidate file, checks the decrypt round-trip, moves the candidate over the old credential, and rechecks the saved value. It never uploads OFW data, changes Supabase records, or prints the key.

Copy-paste one-line PowerShell for the repair:

    $p=Join-Path $env:TEMP 'diagnose-supabase.ps1'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/diagnose-supabase.ps1' -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -RepairSavedKey

After `REPAIRED` / `HTTP 200`, download the newest `bridge.mjs` and execute the existing launcher `probe`. Do not run `sync` until the read-only probe confirms Data API and Storage both pass.

## Structured database import (November 20, 2026)

The destination project is **Co-Parent Connect** (`zhnpbajmumsbejyoqysr`). The database has **seven** separate, private RLS-enabled OFW tables. The main `messages` and `conversations` tables in the Lovable-backed app are untouched. The installer now downloads `import-db.mjs` alongside `bridge.mjs`, and the `import-db` bridge command loads that module.

After the read-only `probe` returns HTTP 200 from Data API and Storage, run this **one physical line** in Windows PowerShell to download the current importer and execute the one-time database transfer:

    $ErrorActionPreference='Stop'; $b=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/import-db.mjs' -OutFile (Join-Path $b 'import-db.mjs'); Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/bridge.mjs' -OutFile (Join-Path $b 'bridge.mjs'); powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $b 'Start-OFWBridge.ps1') import-db

Behavior: local OFW cache is refreshed using `ofw_sync_messages` with `fetchUnreadBodies:false`. The importer stops if historical backfill remains incomplete after bounded retries; it does not misrepresent a partial cache as a complete historical archive. Every Inbox/Sent message is inserted using the real OFW ID, with no duplicate insert on rerun. It preserves sender, timestamps, subject, nullable body (unread bodies intentionally withheld), recipient view provenance, thread IDs, attachments count, and original JSON. No message is sent or marked read. Drafts are verified before upload and stored separately in `ofw_drafts`. Full OFW detailed calendar responses, including custody `guardianData` when provided, are stored for each quarter from January 2010 through December of next year in `ofw_calendar_snapshots`, alongside parsed entries in `ofw_calendar_items`. The import is audited in `ofw_import_runs`. Only source-provided attachment file IDs appear in `ofw_attachment_refs`; compact message lists usually expose only counts. Actual attachment files and bodies of unopened unread messages are **not** downloaded.

The importer compares the source-scoped stored message count to Inbox + Sent totals before marking a run completed. A failure marks the audit `partial` and exits with an error. Existing message rows are never replaced with weaker snapshots on rerun (duplicate IDs are ignored); drafts and calendar snapshots are mutable. Imports are **not automatically scheduled** and do not change the Lovable application or create browser access policies. This is a one-time, intentional transfer of family/court records to the private project and should only run from the user's trusted Windows account. Current code has passed simulated tests; actual source import still requires the local executable.



### Recovery after partial import (2026-11-20)

The first live import confirmed 2,932 Inbox and 3,045 Sent messages (5,977 unique source IDs), with 5,978 recipient rows in Supabase. Import then stopped because `ofw_list_drafts` returned `serverConfirmed:false`. The import audit correctly records `partial`. The database held 0 drafts and 0 calendar snapshots when inspected.

The `import-remaining` bridge command now confirms the stored per-folder message counts equal the current OFW source counts before **skipping redundant message upload**. If either count differs, it halts and instructs a full `import-db` rerun. It then reads drafts from the cache without repeating the failed live verification step, stores them with their actual per-record `server_confirmed` flag, and continues through calendar snapshots. An unverified draft set deliberately leaves the audit at `partial` — it is not proof those drafts still exist on OFW. No messages are sent, marked read, or deleted.

Run one physical PowerShell line:

    $ErrorActionPreference='Stop'; $b=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'; Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/import-db.mjs' -OutFile (Join-Path $b 'import-db.mjs'); Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/bridge.mjs' -OutFile (Join-Path $b 'bridge.mjs'); powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $b 'Start-OFWBridge.ps1') import-remaining

The import still **does not download attachment file contents**. Initial audit found 226 message rows reporting one or more attachments, but zero `ofw_attachment_refs` rows, because the compact message listing exposes attachment counts but not file IDs. These attachments need a separate, deliberately guarded enrichment/download workflow. No actual local recovery import has been run or verified yet.
