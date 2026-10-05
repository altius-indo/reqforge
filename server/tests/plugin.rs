//! Contract tests for the Claude Code plugin shipped alongside the server: agent and skill
//! definitions, the MCP wiring, and consistency between the chat tool policy and the MCP tools.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn frontmatter(text: &str) -> Vec<(String, String)> {
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some("---"), "file must start with YAML frontmatter");
    lines
        .take_while(|l| *l != "---")
        .filter_map(|l| l.split_once(": ").map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string())))
        .collect()
}

// reqforge: verifies REQ-0002#AC1
#[test]
fn agents_have_valid_frontmatter() {
    let want = [
        "cicd-engineer", "delivery-planner", "eval-designer", "mece-reviewer", "requirements-analyst",
        "requirements-classifier", "standards-researcher", "traceability-evaluator",
    ];
    let mut got: Vec<String> = fs::read_dir(root().join("agents")).unwrap().flatten().filter(|e| e.path().extension().map(|x| x == "md").unwrap_or(false)).map(|e| e.path().file_stem().unwrap().to_string_lossy().to_string()).collect();
    got.sort();
    assert_eq!(got, want);
    for a in want {
        let fm = frontmatter(&fs::read_to_string(root().join(format!("agents/{a}.md"))).unwrap());
        assert!(fm.iter().any(|(k, v)| k == "name" && v == a), "{a}: name");
        assert!(fm.iter().any(|(k, v)| k == "description" && v.len() > 40), "{a}: description");
    }
}

// reqforge: verifies REQ-0001#AC1
// reqforge: verifies REQ-0001#AC2
#[test]
fn elicit_skill_orchestrates_research_questions_and_review() {
    let text = fs::read_to_string(root().join("skills/elicit/SKILL.md")).unwrap();
    for needle in ["standards-researcher", "requirements-analyst", "mece-reviewer", "AskUserQuestion", "4 rounds", "propose_changeset", "save_session", "lint", "sync"] {
        assert!(text.contains(needle), "elicit skill must mention {needle}");
    }
    let mut skills: Vec<String> = fs::read_dir(root().join("skills")).unwrap().flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    skills.sort();
    assert_eq!(skills, ["cicd", "elicit", "evaluate", "init", "plan", "run", "ui", "verify"]);
    for sk in &skills {
        let fm = frontmatter(&fs::read_to_string(root().join(format!("skills/{sk}/SKILL.md"))).unwrap());
        assert!(fm.iter().any(|(k, v)| k == "name" && v == sk), "{sk}: name");
    }
}

// reqforge: verifies REQ-0063#AC1
// reqforge: verifies REQ-0063#AC2
#[test]
fn elicit_persists_graded_findings_through_a_changeset() {
    let agent = fs::read_to_string(root().join("agents/standards-researcher.md")).unwrap();
    for needle in ["VERIFIED", "THIN", "REFUTED", "perishability", "sources", "supersedes", "date"] {
        assert!(agent.contains(needle), "standards-researcher must grade findings: {needle}");
    }
    let skill = fs::read_to_string(root().join("skills/elicit/SKILL.md")).unwrap();
    for needle in ["\"op\": \"finding\"", "supersedes", "\"$f3\"", "standards", "RF-NNNN", "simulate_changeset", "apply_changeset"] {
        assert!(skill.contains(needle), "elicit skill must propose cited findings in a changeset: {needle}");
    }
}

// reqforge: verifies REQ-0036#AC1
#[test]
fn manifest_and_mcp_wiring() {
    let plugin: Value = serde_json::from_str(&fs::read_to_string(root().join(".claude-plugin/plugin.json")).unwrap()).unwrap();
    assert_eq!(plugin["name"], "reqforge");
    let market: Value = serde_json::from_str(&fs::read_to_string(root().join(".claude-plugin/marketplace.json")).unwrap()).unwrap();
    assert_eq!(market["plugins"][0]["name"], "reqforge");
    let mcp: Value = serde_json::from_str(&fs::read_to_string(root().join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(mcp["mcpServers"]["reqforge"]["command"], "${CLAUDE_PLUGIN_ROOT}/bin/reqforge");
    assert_eq!(mcp["mcpServers"]["reqforge"]["args"][0], "mcp");
    assert!(root().join("bin/reqforge").exists());
}

// reqforge: verifies REQ-0036#AC2
#[test]
fn chat_tool_policy_names_real_mcp_tools() {
    let tools: Vec<String> = reqforge::mcp::tools().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    for name in reqforge::chat::allowed().iter().chain(reqforge::chat::denied().iter()) {
        if let Some(t) = name.strip_prefix(reqforge::chat::MCP) {
            assert!(tools.contains(&t.to_string()), "chat policy names unknown MCP tool {t}");
        }
    }
    // every MCP tool is either allowed or denied for the chat agent: nothing is left to chance
    for t in &tools {
        let full = format!("{}{t}", reqforge::chat::MCP);
        let listed = reqforge::chat::allowed().contains(&full) || reqforge::chat::denied().contains(&full);
        assert!(listed, "MCP tool {t} is neither allowed nor denied for the chat agent");
    }
}

// reqforge: verifies REQ-0043#AC2
#[test]
fn ci_workflow_runs_clippy_and_tests() {
    let wf = fs::read_to_string(root().join(".github/workflows/test.yml")).unwrap();
    assert!(wf.contains("on: [push, pull_request]"));
    assert!(wf.contains("cargo clippy --manifest-path server/Cargo.toml --all-targets -- -D warnings"));
    assert!(wf.contains("cargo test --manifest-path server/Cargo.toml"));
}

// reqforge: verifies REQ-0043#AC3
#[test]
fn ci_workflow_runs_verification_gate() {
    let wf = fs::read_to_string(root().join(".github/workflows/test.yml")).unwrap();
    let ingest = wf.find("evidence ingest").expect("CI ingests test evidence");
    let gate = wf.find("verify --md --gate").expect("CI runs the verification gate");
    assert!(ingest < gate, "evidence must be ingested before the gate runs");
}
