"""Seed a demo requirements repo through the reqforge CLI: `python3 examples/seed_demo.py /tmp/reqforge-demo`.

Shows the shape the agents produce: classified requirements with ACs, an epic,
stories with evals covering the ACs, and typed tasks across the lifecycle."""
import sys
from pathlib import Path

from _loader import Loader  # noqa: E402

root = next((a for a in sys.argv[1:] if not a.startswith("--")), "reqforge-demo")
s = Loader(root, "SHOP", "Demo shop checkout")

reqs = s.upsert_many("requirements", [
    {"title": "Guest checkout", "type": "functional", "category": "checkout", "priority": "must", "status": "approved",
     "statement": "The system shall let a guest complete a purchase with an email address and a card payment.",
     "rationale": "Forced registration is a top cause of checkout abandonment.",
     "acceptance_criteria": [{"id": "AC1", "text": "Given a cart, when a guest pays with a valid card, then an order is created and a receipt is emailed"},
                             {"id": "AC2", "text": "A declined card shows a retryable error and creates no order"}]},
    {"title": "Card data handling", "type": "constraint", "category": "regulatory", "priority": "must", "status": "approved",
     "statement": "The system shall never store, process or transmit primary account numbers outside the PSP-hosted fields.",
     "standards": ["PCI DSS v4.0 SAQ A"], "rationale": "Keeps PCI scope at SAQ A.",
     "acceptance_criteria": [{"id": "AC1", "text": "No PAN pattern appears in application logs, DB or network traces in the e2e suite"}]},
    {"title": "Checkout latency", "type": "quality", "category": "performance-efficiency", "priority": "should", "status": "approved",
     "statement": "The system shall respond to the place-order call within 800 ms at p95 under 50 orders/s.",
     "acceptance_criteria": [{"id": "AC1", "text": "k6 run at 50 rps for 5 min: p95 < 800 ms, error rate < 0.1%"}]},
    {"title": "Accessible checkout", "type": "quality", "category": "interaction-capability", "priority": "must", "status": "proposed",
     "statement": "The system shall meet WCAG 2.2 AA on every checkout page.", "standards": ["WCAG 2.2 AA"],
     "acceptance_criteria": [{"id": "AC1", "text": "axe reports 0 serious/critical violations on cart, details and payment pages"}]},
])["created"]
r_guest, r_pci, r_lat, r_a11y = reqs

epic = s.create("epics", {"title": "Checkout", "requirements": reqs})["id"]
story = s.create("stories", {
    "title": "Guest pays by card", "epic": epic, "requirements": reqs, "deliverable": "code", "component": "web", "points": 5,
    "narrative": "As a guest shopper, I want to pay without an account, so that I can finish quickly.",
    "evals": [
        {"id": "E1", "name": "order placement", "kind": "integration", "command": "echo pytest tests/checkout/test_guest.py",
         "covers": [f"{r_guest}#AC1", f"{r_guest}#AC2"]},
        {"id": "E2", "name": "PAN leak scan", "kind": "security", "command": "echo python scripts/pan_scan.py",
         "covers": [f"{r_pci}#AC1"]},
        {"id": "E3", "name": "place-order load", "kind": "performance", "command": "echo k6 run perf/place_order.js",
         "covers": [f"{r_lat}#AC1"]},
        {"id": "E4", "name": "axe checkout pages", "kind": "accessibility", "command": "echo npx pa11y-ci",
         "covers": [f"{r_a11y}#AC1"]},
        {"id": "E5", "name": "prod smoke", "kind": "smoke", "command": "echo curl -fsS $APP_URL/health"},
    ]})["id"]
for kind, title in [("design", "Checkout API contract + PSP hosted-fields flow"), ("code", "Implement guest checkout (E1-E4 green)"),
                    ("deployment", "Feature-flagged rollout of guest checkout"), ("monitoring", "Checkout SLO, latency alert, synthetic purchase")]:
    s.create("tasks", {"title": title, "story": story, "kind": kind, "done_when": "reviewed and merged"})
s.save_config({"coverage_waivers": {"interface/hardware": "web only", "data/migration": "greenfield"}})
s.flush()
if "--no-code" not in sys.argv:  # add a tagged code component with CI evidence (examples/seed_code.py)
    import subprocess
    subprocess.run([sys.executable, str(Path(__file__).with_name("seed_code.py")), s.root], check=True)
print(f"demo repo at {s.root}; try: bin/reqforge --repo {s.root} serve")
