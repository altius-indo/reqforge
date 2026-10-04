"""Add a tagged code component to a seeded demo project: `python3 examples/seed_code.py <requirements-repo>`.

Creates `<requirements-repo>-code/`, a small git repo whose implementation and tests carry reqforge
trace tags. It registers that repo as component `web`, scans it, and ingests CI results so that every
verification status shows up:
  REQ-0001#AC1 verified · REQ-0001#AC2 failing · REQ-0002#AC1 suspect (code changed after it passed)
  REQ-0003#AC1 verified via an eval report · REQ-0004#AC1 pending (tagged test, no run yet)."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from _loader import BIN

reqs = Path(sys.argv[1]).resolve()
code = Path(str(reqs) + "-code")
FILES = {
    "shop/checkout.py": '''from shop.psp import hosted_fields

# reqforge: implements REQ-0001
def place_order(cart, email, card_token):
    """Guest checkout: charge through PSP-hosted fields, then create the order."""
    charge = hosted_fields.charge(card_token, cart.total)
    if not charge.ok:
        raise Declined(charge.reason)
    return Order.create(cart, email, charge.id)
''',
    "shop/psp.py": '''# reqforge: implements REQ-0002
class hosted_fields:
    """Card data never touches our servers: only PSP tokens are handled here."""
    @staticmethod
    def charge(token, amount):
        return PSP.charge(token=token, amount=amount)
''',
    "tests/checkout/test_guest.py": '''import pytest
from shop.checkout import place_order

@pytest.mark.req("REQ-0001#AC1")
def test_guest_can_pay():
    assert place_order(cart(), "a@b.c", "tok_ok").id

@pytest.mark.req("REQ-0001#AC2")
def test_declined_card_creates_no_order():
    with pytest.raises(Declined):
        place_order(cart(), "a@b.c", "tok_declined")
    assert Order.count() == 0
''',
    "tests/security/test_pan.py": '''# reqforge: verifies REQ-0002#AC1
def test_no_pan_in_logs(caplog):
    run_checkout_e2e()
    assert not PAN_PATTERN.search(caplog.text)
''',
    "web/checkout.a11y.test.ts": '''import { axe } from './axe';

test('[REQ-0004#AC1] checkout pages have no serious axe violations', async () => {
  for (const page of ['/cart', '/details', '/payment']) {
    expect((await axe(page)).serious).toHaveLength(0);
  }
});
''',
}
JUNIT = """<?xml version="1.0"?><testsuites><testsuite name="pytest">
<testcase classname="tests.checkout.test_guest" name="test_guest_can_pay" time="0.4"/>
<testcase classname="tests.checkout.test_guest" name="test_declined_card_creates_no_order" time="0.3"><failure message="Order.count() == 1">assert 1 == 0</failure></testcase>
<testcase classname="tests.security.test_pan" name="test_no_pan_in_logs" time="2.1"/>
</testsuite></testsuites>"""
EVAL = {"stage": "performance", "results": [{"story": "STORY-0001", "id": "E3", "status": "passed", "covers": ["REQ-0003#AC1"]}]}


def run(*args, cwd=None):
    subprocess.run(args, check=True, capture_output=True, cwd=cwd)


for rel, text in FILES.items():
    p = code / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)
run("git", "init", "-q", "-b", "main", cwd=code)
run("git", "-c", "user.email=demo@reqforge", "-c", "user.name=demo", "add", "-A", cwd=code)
run("git", "-c", "user.email=demo@reqforge", "-c", "user.name=demo", "commit", "-qm", "checkout", cwd=code)

rf = [BIN, "--repo", str(reqs)]
run(*rf, "add", "components", "--data", json.dumps({"title": "Web shop", "key": "web", "path": str(code), "language": "python",
                                                    "repo_url": "https://github.com/acme/shop-web", "owners": ["checkout-team"]}))
run(*rf, "scan")
with tempfile.TemporaryDirectory() as d:
    (Path(d) / "junit.xml").write_text(JUNIT)
    (Path(d) / "evals-performance.json").write_text(json.dumps(EVAL))
    run(*rf, "evidence", "ingest", str(Path(d) / "junit.xml"), str(Path(d) / "evals-performance.json"), "-c", "web",
        "--run", "https://github.com/acme/shop-web/actions/runs/1")
# a change after the run: the PCI evidence no longer vouches for the current code
psp = code / "shop/psp.py"
psp.write_text(psp.read_text().replace("amount=amount)", "amount=amount, idempotency_key=token)"))
run(*rf, "scan")
print(f"code component 'web' at {code}; try: bin/reqforge --repo {reqs} verify --md")
