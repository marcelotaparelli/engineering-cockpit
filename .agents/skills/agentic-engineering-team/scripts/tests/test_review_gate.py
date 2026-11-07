"""Testes de consistência do verificador declarativo, sem rede nem dependências."""
import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "review_gate.py"
spec = importlib.util.spec_from_file_location("review_gate", MODULE)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def valid(tier="critical"):
    return {
        "task_id": "T-1",
        "tier": tier,
        "challenge": {"verdict": "accept", "evidence": ["review/decision-1.md"]},
        "red_team": {"verdict": "pass", "mode": "static-local", "evidence": ["reports/test-1.txt"], "findings": []},
        "verification": {"ci_status": "pass", "evidence": ["CI:job#1"], "application_observability": "verified"},
    }


class TestReviewGate(unittest.TestCase):
    def test_critical_complete_report_passes_declarative_only(self):
        self.assertEqual(gate.validate_report(valid()), [])

    def test_high_open_blocks_any_tier(self):
        data = valid("quick")
        data["red_team"]["findings"] = [{"severity": "high", "status": "open"}]
        self.assertTrue(any("HIGH" in x for x in gate.validate_report(data)))

    def test_unverified_critical_rejected(self):
        data = valid()
        data["red_team"]["verdict"] = "not_tested"
        self.assertTrue(any("incompleto" in x for x in gate.validate_report(data)))

    def test_active_staging_requires_roe(self):
        data = valid()
        data["red_team"]["mode"] = "staging-active"
        errors = gate.validate_report(data)
        self.assertTrue(any("ROE" in x for x in errors))

    def test_quick_na_with_reason(self):
        data = valid("quick")
        data["challenge"] = {"verdict": "not_applicable", "rationale": "Conforme padrão existente, sem decisões novas"}
        data["red_team"] = {"verdict": "not_applicable", "rationale": "Somente copy, sem superfície de entrada", "findings": []}
        self.assertEqual(gate.validate_report(data), [])

    def test_critical_medium_open_blocks(self):
        data = valid()
        data["red_team"]["findings"] = [{"severity": "medium", "status": "unverified"}]
        self.assertTrue(any("MEDIUM" in x for x in gate.validate_report(data)))

    def test_expected_commit_requires_match(self):
        expected = "a" * 40
        data = valid()
        data["commit_sha"] = expected
        data["verification"]["commit_sha"] = expected
        self.assertEqual(gate.validate_report(data, expected_commit=expected), [])
        data["verification"]["commit_sha"] = "b" * 40
        self.assertTrue(any("verification.commit_sha" in x for x in gate.validate_report(data, expected_commit=expected)))
        self.assertTrue(any("40 ou 64" in x for x in gate.validate_report(data, expected_commit="abc")))

    def test_pass_requires_actual_review_mode(self):
        data = valid()
        data["red_team"]["mode"] = "none"
        self.assertTrue(any("modo none" in x for x in gate.validate_report(data)))

    def test_closing_high_finding_requires_evidence(self):
        data = valid()
        data["red_team"]["findings"] = [{"severity": "high", "status": "mitigated"}]
        self.assertTrue(any("requer evidência" in x for x in gate.validate_report(data)))

    def test_invalid_json_shape_fails(self):
        self.assertTrue(gate.validate_report([]))


if __name__ == "__main__":
    unittest.main()
