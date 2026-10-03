---
name: cicd
description: Generate the eval-driven CI/CD pipeline (GitHub Actions) for a code repository from the story evals — traceability gate, commit/acceptance/security/performance stages, deploy, post-deploy smoke, scheduled monitoring.
argument-hint: "[path to code repo — default: current directory]"
---

# /reqforge:cicd: eval-driven pipeline

Target: `$ARGUMENTS`, or the current working directory.

1. `trace`. If there are no stories with evals yet, stop and suggest `/reqforge:plan`.
2. Ask with AskUserQuestion only for what you can't infer from the repo:
   - where the requirements live: separate GitHub repo (Recommended when shared across services) / inside this repo,
   - the deploy target, if no deployment task or deploy tooling exists yet.
3. Launch **cicd-engineer** with the target path and the answers.
4. Report the files written, the config set, the local commit-stage results, and the human checklist (secrets, environment, branch protection). Don't commit to the code repo unless the user says so.
