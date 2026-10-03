---
name: ui
description: Start the reqforge web UI + REST API (search, edit, bulk update, CSV import/export, traceability and lint dashboards) or the interactive console.
argument-hint: "[port | console]"
---

# /reqforge:ui

- If `$ARGUMENTS` is "console": tell the user to run `! ${CLAUDE_PLUGIN_ROOT}/bin/reqforge console`. It's interactive, so it has to run in their terminal.
- Otherwise start the server in the background: `${CLAUDE_PLUGIN_ROOT}/bin/reqforge serve --port ${ARGUMENTS:-8787}` (Bash with `run_in_background`). Then confirm it responds with `curl -s localhost:<port>/api/meta | head -c 200`.
- Report the URL, plus these notes:
  - The left sidebar is the category tree: drill from type to category; the bars show story coverage and the dots show lint health.
  - "Chat with Claude" runs local Claude Code against the repository. It proposes changesets, which the user applies or rejects in the UI. Set `components` in reqforge.json (`{name: path}`) so it can assess code impact.
  - Setting `REQFORGE_TOKEN` before starting requires a bearer token for the API; the UI prompts for it.
  - `--host 0.0.0.0` exposes it on the network. Only do that with a token set.
  - "Sync to GitHub" in the UI pushes the commits.
  - REST endpoints are listed in `reqforge/api.py` and the README.
