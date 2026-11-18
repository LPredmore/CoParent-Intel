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
