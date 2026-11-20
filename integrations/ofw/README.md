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

The working Claude Desktop OFW MCP remains the source connector. The bridge is a separate local Node process that calls the restricted MCP. Its legacy `sync` command exports JSON snapshots to private Storage; the `import-db` and related commands populate dedicated private `ofw_` tables, without modifying the current Lovable-backed application. Binary attachments are archived into a private bucket named `ofw-bridge`.

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

- The legacy `sync` command stores raw JSON exports in private Storage. The separate `import-db`/`import-remaining` commands populate private OFW staging tables, and `archive-attachments` saves original files in the private Storage bucket. None of these commands modifies the existing Lovable app database.
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

## OFW structured import: messages, calendar, expenses, attachments (November 20, 2026)

**Project:** Co-Parent Connect (\`zhnpbajmumsbejyoqysr\`). The private database tables have RLS enabled and are not exposed to ordinary browser users. This DOES NOT modify the existing Lovable app database.

**No imported drafts.** The historical \`ofw_drafts\` mirror table was empty and is removed. Neither the \`import-db\` nor \`import-remaining\` commands calls \`ofw_list_drafts\`. Only Inbox, Sent, calendar, and expenses enter the database. The separate \`draft <path-to-json>\` command can explicitly create a draft in OFW. Its private Storage idempotency receipt stores the request ID and OFW IDs, never body/subject/recipient text. Existing OFW drafts are not downloaded. The app does not yet implement post-send receipt cleanup or an automatic outbound-draft queue.

**Expenses:** \`ofw_list_expenses\` is read paginated to completion, with categories and financial summary totals saved. Records and their original payloads are upserted by source expense ID into \`ofw_expenses\`; known receipt/file IDs go into \`ofw_expense_attachment_refs\`. No expenses are created, edited, reimbursed, or deleted on OFW. \`sync-expenses\` refreshes only expenses/categories/summary without rereading messages or calendar.

**Attachments:** \`archive-attachments\` loads metadata from existing attachment-bearing messages and receipt references. It calls \`ofw_get_message(allowMarkRead:false)\` ONLY on messages that the saved database already identifies as read or sent. Unread inbox messages are skipped. Downloads use \`ofw_download_attachment\` to the OFW MCP's configured local attachment directory, then the bridge securely uploads original bytes to the new **private** \`ofw-bridge\` Supabase Storage bucket. File records in \`ofw_saved_files\` carry the file ID, size, SHA-256, content-type, and Storage path. Duplicate file IDs are not uploaded again. Currently standard uploads cap each file at 45 MiB; larger files need a resumable-upload implementation. The same file can be referenced from messages and expenses; it is stored once. Some expense receipt IDs might not be present in the expense list responses; the original OFW JSON remains available for future parser enrichment. A final \`ok:false\` means some files are still missing and is intentionally not a full-completeness claim.

**First import:** On November 20, 2026, the first live attempt imported **5,977** unique message records (Inbox 2,932; Sent 3,045) and **5,978** message-recipient records. It stopped on draft verification; the new code removes that step entirely. Supabase verified the message counts and no duplicate IDs.

**On Windows PowerShell, use one physical line to refresh ALL four local module files and resume from the already verified messages** (no re-upload of those 5,977 messages unless source folder counts have changed):

    $ErrorActionPreference='Stop'; $b=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'; @('import-db.mjs','expense-import.mjs','attachment-import.mjs','bridge.mjs') | ForEach-Object { Invoke-WebRequest -UseBasicParsing ('https://raw.githubusercontent.com/LPredmore/CoParent-Intel/main/integrations/ofw/'+$_) -OutFile (Join-Path $b $_) }; powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $b 'Start-OFWBridge.ps1') import-remaining

After successful \`import-remaining\` and a real audit of imported expense records, archive file content using the already refreshed modules:

    $b=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'; powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $b 'Start-OFWBridge.ps1') archive-attachments

For future expense updates (manual, not an automatic background schedule):

    $b=Join-Path $env:LOCALAPPDATA 'CoParentIntel\OFW'; powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $b 'Start-OFWBridge.ps1') sync-expenses

The bridge can still run its earlier \`sync\` command to create legacy raw Storage JSON snapshots. That is **separate** from the private database importer. There is no scheduled or always-on sync configured. An automation can be added after the first full data/attachment reconciliation. Never run import code with the Secret API key in frontend/browser code.

