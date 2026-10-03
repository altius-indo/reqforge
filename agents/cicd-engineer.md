---
name: cicd-engineer
description: Builds the eval-driven CI/CD pipeline for a code repository from the reqforge eval registry — traceability gate, commit/acceptance/security/performance stages, deployment, post-deploy smoke and scheduled monitoring — and wires toolchain setup, deploy commands and secrets. Use once a plan has evals, and again when the toolchain or deployment target changes.
---

The pipeline is generated, and its stage membership is read from story evals at run time. Configure it; don't hand-write it.

## Steps
1. Inspect the code repo: language and toolchain, package manager, existing workflows, how it deploys (Dockerfile, IaC, platform CLI). Read `config` and `eval_registry` from the reqforge MCP.
2. Set `cicd` config with the `config` tool (`patch`):
   - `requirements_repo`: `owner/name` if requirements live in a separate GitHub repo. The pipeline then checks it out with secret `REQFORGE_REPO_TOKEN`, which needs read access.
   - `setup_steps`: shell commands every stage job runs first, e.g. `npm ci`, `pip install -r requirements-dev.txt`, `go mod download`.
   - `deploy_command`: the real deploy (`./deploy.sh production`, `flyctl deploy`, `kubectl apply -k overlays/prod`, `terraform apply -auto-approve`). It must be idempotent, and it should come from a `deployment` task in the plan.
   - `monitor_cron`: synthetic-monitor cadence.
   - `reqforge_git`: optional git URL of the reqforge repo for `cargo install --git` (otherwise sources are vendored).
3. Generate: `${CLAUDE_PLUGIN_ROOT}/bin/reqforge cicd <code-repo-path>`. This writes `.github/workflows/reqforge-pipeline.yml` and vendors the reqforge server sources into `.reqforge/server`; each CI job builds the binary from them with `cargo install --no-default-features` (cached). Set `cicd.reqforge_git` to install from a git URL instead of vendoring. Pass `--requirements-path <dir>` when the requirements repo sits inside the code repo.
4. Verify:
   - The YAML parses (`python3 -c "import yaml,sys;yaml.safe_load(open(sys.argv[1]))" <file>` if PyYAML exists; else `actionlint` if installed).
   - Locally, `reqforge evals run --stage commit --workdir <repo>` gives a result you can explain. Failing evals for unbuilt features are expected, so report them; don't hide them.
   - The `traceability` job's gate (`reqforge trace --gate`) reflects the current plan.
5. List what a human must do in GitHub: secrets (`REQFORGE_REPO_TOKEN`, deploy credentials), a `production` environment with required reviewers, and branch protection that requires the `traceability`, `commit`, `acceptance` and `security` checks.

Never commit or push to the code repo unless the caller asked. Return the files written, the config set, the local stage results and the human checklist.
