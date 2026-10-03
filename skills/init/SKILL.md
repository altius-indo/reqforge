---
name: init
description: Create or connect the GitHub-backed reqforge requirements repository (JSON records, one file per requirement/epic/story/task, every change a commit).
argument-hint: "[owner/repo]"
---

# /reqforge:init: requirements repository

1. Check for an existing repository: call MCP `config` (or run `${CLAUDE_PLUGIN_ROOT}/bin/reqforge list req`). If one is found, report its root and stop.
2. Ask with AskUserQuestion, in one call:
   - **Location**: new GitHub repo `<owner>/<project>-requirements` (Recommended) / folder `requirements/` inside this repo / existing GitHub repo (they give owner/name via Other).
   - **Visibility** (new repo only): private (Recommended) / public.
   Also derive a short project KEY and a name from the repo or directory, and confirm them in the same question set.
3. Create it:
   - New or existing GitHub repo: `init_repo` with `path` set to a sibling folder named after the repo, plus `key`, `name`, `github: owner/name` and `private`. This uses `gh` (must be authenticated; check `gh auth status`). For an existing remote repo, `gh repo clone` it first, then `init_repo` on the clone.
   - Folder in this repo: `init_repo` with `path: requirements`. Commits land in this repo's history.
4. If the requirements repo isn't inside the current directory, write a pointer file `.reqforge-repo` in the current project root containing the relative path, so the CLI, console and MCP server find it from here. Alternatively, export `REQFORGE_REPO`.
5. Report the path, the GitHub URL, and next steps (`/reqforge:elicit <need>`, `/reqforge:ui`).
