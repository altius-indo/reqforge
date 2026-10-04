//! Generate a GitHub Actions pipeline driven by the eval registry.
//!
//! Stage-shaped (traceability gate -> commit -> acceptance/security -> performance -> deploy ->
//! post-deploy, plus a scheduled monitor). Each stage job asks reqforge at run time which evals
//! belong to it, so adding an eval to a story extends CI/CD without regenerating the workflow.
//! The reqforge binary is built in CI from `cicd.reqforge_git`, or from a vendored copy of the
//! server sources in `.reqforge/server` (no UI embedded: `--no-default-features`).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::store::Store;

fn indent(lines: &[String], n: usize) -> String {
    lines.iter().map(|l| format!("{}{}", " ".repeat(n), l)).collect::<Vec<_>>().join("\n")
}

fn install_step(git: &str) -> Vec<String> {
    let src = if git.is_empty() {
        "--path .reqforge/server".to_string()
    } else {
        format!("--git {git}")
    };
    vec![
        "- uses: actions/cache@v4".into(),
        "  with:".into(),
        "    path: |".into(),
        "      ~/.cargo/bin/reqforge".into(),
        "      ~/.cargo/registry".into(),
        "    key: reqforge-${{ runner.os }}-${{ hashFiles('.reqforge/server/Cargo.lock', '.reqforge/server/src/**') }}".into(),
        "- name: Install reqforge".into(),
        format!("  run: command -v reqforge >/dev/null || cargo install --locked --no-default-features {src} reqforge"),
    ]
}

pub fn workflow(store: &Store, requirements_path: &str) -> String {
    workflow_for(store, requirements_path, None)
}

// reqforge: implements REQ-0012
// reqforge: implements REQ-0044
pub fn workflow_for(store: &Store, requirements_path: &str, component: Option<&str>) -> String {
    let cfg = store.config_value();
    let c = cfg.get("cicd").cloned().unwrap_or(Value::Null);
    let get = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let comp = component.map(String::from).unwrap_or_else(|| get("component"));
    let junit: Vec<String> = c.get("junit").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
    let publish = c.get("publish_evidence").and_then(Value::as_bool).unwrap_or(false);
    let req_repo = get("requirements_repo");
    let setup: Vec<String> = c.get("setup_steps").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(|x| format!("- run: {x}")).collect();
    let deploy = if get("deploy_command").is_empty() { "echo 'set cicd.deploy_command in reqforge.json' && exit 1".to_string() } else { get("deploy_command") };
    let cron = if get("monitor_cron").is_empty() { "*/30 * * * *".to_string() } else { get("monitor_cron") };
    let req_dir = if !req_repo.is_empty() { ".requirements".to_string() } else if requirements_path.is_empty() { ".".into() } else { requirements_path.to_string() };

    let mut checkout: Vec<String> = vec!["- uses: actions/checkout@v4".into(), "  with:".into(), "    fetch-depth: 0".into()];
    if !req_repo.is_empty() {
        checkout.extend([
            "- uses: actions/checkout@v4".into(),
            "  with:".into(),
            format!("    repository: {req_repo}"),
            "    path: .requirements".into(),
            "    token: ${{ secrets.REQFORGE_REPO_TOKEN || github.token }}".into(),
        ]);
    }
    checkout.extend(install_step(&get("reqforge_git")));
    let with_setup: Vec<String> = checkout.iter().cloned().chain(setup.iter().cloned()).collect();

    let stage_job = |name: &str, stage: &str, needs: &[&str], cond: Option<&str>| -> Vec<String> {
        let mut l = vec![format!("{name}:"), "  runs-on: ubuntu-latest".into()];
        if !needs.is_empty() {
            l.push(format!("  needs: [{}]", needs.join(", ")));
        }
        if let Some(c) = cond {
            l.push(format!("  if: {c}"));
        }
        l.push("  steps:".into());
        l.push(indent(&with_setup, 4));
        l.extend([
            format!("    - name: Run {stage} evals"),
            format!("      run: reqforge evals run --stage {stage} --workdir . --md >> \"$GITHUB_STEP_SUMMARY\""),
            "    - uses: actions/upload-artifact@v4".into(),
            "      if: always()".into(),
            "      with:".into(),
            format!("        name: reqforge-{stage}"),
            "        path: |".into(),
            "          reqforge-reports/".into(),
        ]);
        l.extend(junit.iter().map(|g| format!("          {g}")));
        l.push("        if-no-files-found: ignore".into());
        l
    };
    let on_main = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
    let mut jobs: Vec<String> = vec![
        "traceability:".into(),
        "  runs-on: ubuntu-latest".into(),
        "  if: github.event_name != 'schedule'".into(),
        "  steps:".into(),
        indent(&checkout, 4),
        "    - name: Requirement lint (MECE + quality)".into(),
        "      run: reqforge lint --md --gate >> \"$GITHUB_STEP_SUMMARY\"".into(),
        "    - name: Traceability gate (requirement -> story -> eval)".into(),
        "      run: reqforge trace --md --gate >> \"$GITHUB_STEP_SUMMARY\"".into(),
    ];
    if !comp.is_empty() {
        jobs.extend([
            "    - name: Code trace tags (requirement -> code/tests)".into(),
            format!("      run: reqforge scan --component {comp} --root . && reqforge verify --static --md --gate >> \"$GITHUB_STEP_SUMMARY\""),
        ]);
        jobs.extend([
            "impact:".to_string(),
            "  runs-on: ubuntu-latest".into(),
            "  if: github.event_name == 'pull_request'".into(),
            "  permissions:".into(),
            "    contents: read".into(),
            "    pull-requests: write".into(),
            "  steps:".into(),
            indent(&checkout, 4),
            "    - name: Requirement impact of this change".into(),
            format!("      run: reqforge impact --component {comp} --root . --base origin/${{{{ github.base_ref }}}} --md > reqforge-impact.md && cat reqforge-impact.md >> \"$GITHUB_STEP_SUMMARY\""),
            "    - name: Comment on the PR".into(),
            "      env:".into(),
            "        GH_TOKEN: ${{ github.token }}".into(),
            "      run: gh pr comment ${{ github.event.pull_request.number }} --body-file reqforge-impact.md --edit-last || gh pr comment ${{ github.event.pull_request.number }} --body-file reqforge-impact.md".into(),
        ]);
    }
    jobs.extend(stage_job("commit", "commit", &["traceability"], None));
    jobs.extend(stage_job("acceptance", "acceptance", &["commit"], None));
    jobs.extend(stage_job("security", "security", &["commit"], None));
    jobs.extend(stage_job("performance", "performance", &["acceptance"], Some(on_main)));
    // verification: scan the code, ingest every stage's results as evidence for this commit, gate
    let mut vsteps: Vec<String> = vec![
        "    - uses: actions/download-artifact@v4".into(),
        "      with:".into(),
        "        pattern: reqforge-*".into(),
        "        path: reqforge-results".into(),
    ];
    if !comp.is_empty() {
        vsteps.extend(["    - name: Scan trace tags".into(), format!("      run: reqforge scan --component {comp} --root .")]);
    }
    let comp_flag = if comp.is_empty() { String::new() } else { format!(" --component {comp}") };
    vsteps.extend([
        "    - name: Ingest evidence (eval reports + JUnit) for this commit".into(),
        format!("      run: shopt -s globstar nullglob && files=(reqforge-results/**/*.json reqforge-results/**/*.xml) && if [ ${{#files[@]}} -gt 0 ]; then reqforge evidence ingest \"${{files[@]}}\"{comp_flag} --commit \"$GITHUB_SHA\" --run \"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID\"; fi"),
        "    - name: Verification gate (requirement -> test -> evidence -> code)".into(),
        "      run: reqforge verify --md --gate >> \"$GITHUB_STEP_SUMMARY\"".into(),
    ]);
    if publish {
        vsteps.extend([
            "    - name: Publish evidence to the requirements repo".into(),
            format!("      if: {on_main}"),
            "      run: git config --global user.email reqforge@users.noreply.github.com && git config --global user.name reqforge-ci && reqforge sync -m \"evidence from $GITHUB_REPOSITORY@$GITHUB_SHA\"".into(),
        ]);
    }
    jobs.extend([
        "verification:".to_string(),
        "  runs-on: ubuntu-latest".into(),
        "  needs: [commit, acceptance, security, performance]".into(),
        "  if: always() && github.event_name != 'schedule' && needs.commit.result != 'skipped'".into(),
        "  steps:".into(),
        indent(&checkout, 4),
    ]);
    jobs.extend(vsteps);
    jobs.extend([
        "deploy:".to_string(),
        "  runs-on: ubuntu-latest".into(),
        "  needs: [acceptance, security, performance, verification]".into(),
        format!("  if: {on_main}"),
        "  environment: production".into(),
        "  steps:".into(),
        indent(&with_setup, 4),
        "    - name: Deploy".into(),
        format!("      run: {deploy}"),
    ]);
    jobs.extend(stage_job("post-deploy", "post-deploy", &["deploy"], Some(on_main)));
    jobs.extend(stage_job("monitor", "monitor", &[], Some("github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'")));

    [
        "# Generated by reqforge. Stage membership comes from story evals at run time:".to_string(),
        "# add evals to stories (reqforge / UI / API) instead of editing this file.".into(),
        "name: reqforge-pipeline".into(),
        "on:".into(),
        "  push:".into(),
        "    branches: [main]".into(),
        "  pull_request:".into(),
        "  workflow_dispatch:".into(),
        "  schedule:".into(),
        format!("    - cron: '{cron}'"),
        "permissions:".into(),
        "  contents: read".into(),
        "env:".into(),
        format!("  REQFORGE_REPO: {req_dir}"),
        "concurrency:".into(),
        "  group: reqforge-${{ github.ref }}".into(),
        "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}".into(),
        "jobs:".into(),
        indent(&jobs, 2),
        String::new(),
    ]
    .join("\n")
}

/// Directory holding the reqforge server sources (for vendoring into CI), if discoverable.
pub fn server_source_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("REQFORGE_SERVER_SRC") {
        return Some(PathBuf::from(d));
    }
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if compiled.join("Cargo.toml").exists() {
        return Some(compiled);
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().find(|p| p.join("server/Cargo.toml").exists()).map(|p| p.join("server"))
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        if name == "target" {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            copy_tree(&p, &to.join(&name))?;
        } else {
            fs::copy(&p, to.join(&name))?;
        }
    }
    Ok(())
}

pub fn generate(store: &Store, out_dir: &Path, requirements_path: &str, vendor: bool) -> Result<Vec<String>, String> {
    generate_for(store, out_dir, requirements_path, vendor, None)
}

pub fn generate_for(store: &Store, out_dir: &Path, requirements_path: &str, vendor: bool, component: Option<&str>) -> Result<Vec<String>, String> {
    let out = fs::canonicalize(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let cfg = store.config_value();
    let req_repo = cfg["cicd"]["requirements_repo"].as_str().unwrap_or("").to_string();
    let mut rp = requirements_path.to_string();
    if rp.is_empty() && req_repo.is_empty() {
        rp = match store.root.strip_prefix(&out) {
            Ok(rel) if rel.as_os_str().is_empty() => ".".into(),
            Ok(rel) => rel.display().to_string(),
            Err(_) => {
                return Err("requirements repo is outside the code repo: set cicd.requirements_repo (owner/name) in reqforge.json or pass --requirements-path".into())
            }
        };
    }
    let wf = out.join(".github/workflows/reqforge-pipeline.yml");
    fs::create_dir_all(wf.parent().unwrap()).map_err(|e| e.to_string())?;
    if let Some(k) = component {
        if crate::codetrace::component_by_key(store, k).is_none() {
            return Err(format!("unknown component '{k}'"));
        }
    }
    fs::write(&wf, workflow_for(store, &rp, component)).map_err(|e| e.to_string())?;
    let mut written = vec![wf.display().to_string()];
    let git = cfg["cicd"]["reqforge_git"].as_str().unwrap_or("");
    if vendor && git.is_empty() {
        let src = server_source_dir().ok_or("cannot locate reqforge server sources to vendor; set cicd.reqforge_git or REQFORGE_SERVER_SRC")?;
        let dest = out.join(".reqforge/server");
        if dest.exists() {
            fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
        }
        copy_tree(&src, &dest).map_err(|e| e.to_string())?;
        written.push(dest.display().to_string());
    }
    Ok(written)
}
