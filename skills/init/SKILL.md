---
name: init
description: Create a reqforge project (its own GitHub-backed requirements repository) in the workspace, import an existing one, or switch the default project.
argument-hint: "[KEY | owner/repo]"
---

# /reqforge:init: projects

reqforge keeps a **workspace** (default `~/.reqforge`, or `$REQFORGE_WORKSPACE`) that holds any number of **projects**. Each project is its own requirements repository: JSON records, every change a commit, and optionally its own GitHub repo.

1. Call MCP `list_projects`, or run `${CLAUDE_PLUGIN_ROOT}/bin/reqforge project list`. Show the existing projects and the default.
2. Ask with AskUserQuestion, in one call, only for what you can't infer from `$ARGUMENTS` or the current repo:
   - **Action**: create a new project (Recommended when none fits) / import an existing requirements repo / switch the default project.
   - For a new project: **KEY** (2–16 chars, A–Z first; derive one from the product or repo name) and **name**.
   - **GitHub**: new private repo `<owner>/<key>-requirements` (Recommended) / public repo / no remote for now.
3. Do it:
   - Create: MCP `create_project` with `key`, `name`, and optionally `github` and `private`. GitHub creation uses `gh`, which must be authenticated; check `gh auth status`.
   - Import: `${CLAUDE_PLUGIN_ROOT}/bin/reqforge project import <path> [--key KEY]`.
   - Switch default: `${CLAUDE_PLUGIN_ROOT}/bin/reqforge project default <KEY>`.
4. Agents act on the default project unless a tool call passes `project: "<KEY>"`. Tell the user how to target another project: pass it in tool calls, use `-P KEY` on the CLI, or `export REQFORGE_PROJECT=KEY`.
5. Report the project key, path and GitHub URL, plus the next steps: `/reqforge:elicit <need>` and `/reqforge:ui`.

Deleting a project removes all its requirements, plan, changesets, sessions and git history. It is never done by an agent: the user does it in the UI (Projects → Delete, typing the key to confirm) or with `reqforge project delete KEY --confirm KEY`.
