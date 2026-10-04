---
id: projects
title: Projects
tabs: projects
keywords: project, workspace, switch, switcher, create, import, rename, default, delete, github, repository, key, onboarding
---
A **project** is a git repository holding one product's requirements, plan, changesets and session notes. Each project
has a short key such as `SHOP` that appears in links (`#/p/SHOP`) and on the command line.

### Switch projects

1. Click the project name next to *reqforge* in the header to open the project switcher.
2. Click a project to open it. Each entry shows its requirement count; a star marks the default project.
3. Use the browser's back and forward buttons to return to the previous project.

### Create a project

1. Open the switcher and choose **New project…**, click **New project** on the projects page, or click
   **Create project** on the first-run screen.
2. Enter a **Key**: 2–16 characters, starting with a letter. It is upper-cased as you type and must not already exist.
3. Enter a **Name**.
4. Optionally enter a GitHub repository as `owner/name` and tick or untick **Private repository**: the server creates
   it with the `gh` CLI and pushes to it. Leave it empty for a local-only repository; you can add a remote later.
5. Click **Create project**. The new project opens.

### Import an existing repository

1. Click **Import** on the projects page or **Import existing repository** on the first-run screen (or switch the
   create dialog to its **Import existing repository** tab).
2. Enter the absolute path of an existing reqforge repository on the server (it has a `reqforge.json`). It is
   registered in place, not copied. The key defaults to the repository's own key unless you enter one.
3. Click **Import**.

### Manage projects

1. Open the switcher and choose **Manage projects** to open the projects page.
2. Click **Open** to work in a project, **Rename** to change its display name (the key stays the same), or
   **Make default** to choose the project opened when there is no last-used one.
3. To delete a project, click **Delete**, type its key to confirm, and decide whether to also delete its GitHub
   repository. Deletion removes the directory and its git history and cannot be undone.
4. Click **Back to** followed by the project key to return to the project you were working in.

In single-repository mode (the server was started with `--repo`), the projects page is read-only.
