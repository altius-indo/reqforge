## Now
- All 64 requirements (173 criteria) verified; all 56 tasks done; lint 0 findings; trace gate passes (2026-10-05).
- Shipped this session: context management (EPIC-0011: snapshot, next actions, DEC decisions, session history, graded research), per-task evals in Complete (REQ-0056), sandbox false-positive fix (REQ-0052 AC6), collapsible and resizable side panels (REQ-0064).

## Next
- Find why the reqforge MCP server fails to start in agent runs (RUN-TASK-0041, RUN-TASK-0050 and RUN-TASK-0053 logged it; agents worked from their briefs): compare .mcp.json with the plugin dir passed in server/src/agent.rs, then rerun `cargo test --manifest-path server/Cargo.toml --test agent_run`.

## Watch
- REQ-0064 covers the sidebar and chat panel only; whether the record drawer should resize is undecided.
- Research findings (REQ-0063) can be added and linted but not listed or read through REST, MCP or the UI.
- No DEC decision records exist yet; the unexercised-decision lint has nothing to check.

Last reconciled: 2026-10-05
