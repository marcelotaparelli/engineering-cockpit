#!/usr/bin/env python3
"""Checagem de consistência dos gates de review. NÃO valida evidência real, nem autorização."""
import argparse
import json
import re
from pathlib import Path

SEVERITIES = {"critical", "high", "medium", "low", "info"}
ACTIVE_STATES = {"open", "unverified"}


def validate_report(data, expected_commit=None):
    issues = []
    if not isinstance(data, dict):
        return ["Relatório precisa ser objeto JSON"]
    if expected_commit is not None:
        if not isinstance(expected_commit, str) or not re.fullmatch(r"(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})", expected_commit):
            issues.append("--expected-commit requer SHA Git de 40 ou 64 dígitos")
        else:
            if data.get("commit_sha") != expected_commit:
                issues.append("commit_sha do relatório não corresponde ao commit esperado pelo CI")
            ver_commit = data.get("verification", {})
            if not isinstance(ver_commit, dict) or ver_commit.get("commit_sha") != expected_commit:
                issues.append("verification.commit_sha não corresponde ao commit esperado pelo CI")
    tier = data.get("tier")
    if tier not in {"quick", "standard", "critical"}:
        issues.append("tier inválido: quick | standard | critical")
    if not isinstance(data.get("task_id"), str) or not data["task_id"].strip():
        issues.append("task_id ausente")
    decision = data.get("challenge", {})
    if not isinstance(decision, dict):
        decision = {}
    dv = decision.get("verdict")
    if dv not in {"accept", "not_applicable", "experiment", "revise", "escalate"}:
        issues.append("challenge.verdict inválido/ausente")
    if dv in {"experiment", "revise", "escalate"}:
        issues.append(f"challenge pendente: {dv}")
    if dv == "not_applicable" and not str(decision.get("rationale", "")).strip():
        issues.append("challenge N/A exige justificativa")
    if tier == "critical" and dv != "accept":
        issues.append("critical exige challenge aceito")
    if dv == "accept" and not decision.get("evidence"):
        issues.append("challenge aceito requer referências à evidência")

    red = data.get("red_team", {})
    if not isinstance(red, dict):
        red = {}
    rv = red.get("verdict")
    if rv not in {"pass", "not_applicable", "not_tested", "fail"}:
        issues.append("red_team.verdict inválido/ausente")
    if rv in {"fail", "not_tested"}:
        issues.append(f"teste adversarial incompleto: {rv}")
    if rv == "not_applicable" and not str(red.get("rationale", "")).strip():
        issues.append("red_team N/A exige justificativa")
    if tier == "critical" and rv != "pass":
        issues.append("critical exige revisão red team concluída e registrada")
    mode = red.get("mode", "static-local")
    if mode not in {"static-local", "staging-active", "none"}:
        issues.append("red_team.mode inválido")
    if rv == "pass" and mode == "none":
        issues.append("red_team PASS incompatível com modo none")
    if rv == "not_applicable" and mode == "staging-active":
        issues.append("red_team N/A incompatível com staging-active")
    if mode == "staging-active":
        if red.get("roe_approved") is not True:
            issues.append("staging-active precisa de ROE aprovado (report declarativo não comprova autorização)")
        if not str(red.get("roe_reference", "")).strip():
            issues.append("staging-active requer referência ROE")
    if rv == "pass" and not red.get("evidence"):
        issues.append("red team PASS requer evidências observadas")
    findings = red.get("findings", [])
    if not isinstance(findings, list):
        issues.append("red_team.findings precisa ser lista")
        findings = []
    for i, finding in enumerate(findings, 1):
        if not isinstance(finding, dict):
            issues.append(f"finding {i}: deve ser objeto")
            continue
        sev = finding.get("severity", "").lower() if isinstance(finding.get("severity"), str) else None
        state = finding.get("status", "").lower() if isinstance(finding.get("status"), str) else None
        if sev not in SEVERITIES:
            issues.append(f"finding {i}: severidade inválida")
        if state not in {"open", "mitigated", "false_positive", "unverified"}:
            issues.append(f"finding {i}: status inválido")
        if sev in {"high", "critical"} and state in ACTIVE_STATES:
            issues.append(f"finding {i}: {sev.upper()} {state.upper()} bloqueia release")
        if sev in {"high", "critical"} and state in {"mitigated", "false_positive"} and not finding.get("evidence"):
            issues.append(f"finding {i}: {sev.upper()} encerrado requer evidência de mitigação ou falso positivo")
        if tier == "critical" and sev == "medium" and state in ACTIVE_STATES:
            issues.append(f"finding {i}: MEDIUM pendente bloqueia release critical até tratamento")

    ver = data.get("verification", {})
    if not isinstance(ver, dict):
        ver = {}
    if tier in {"standard", "critical"} and ver.get("ci_status") != "pass":
        issues.append("CI deve estar PASS com resultado independente")
    if tier in {"standard", "critical"} and not ver.get("evidence"):
        issues.append("verificação exige evidência do CI/testes")
    app = ver.get("application_observability")
    if tier == "critical" and app not in {"verified", "not_applicable"}:
        issues.append("critical: observabilidade de aplicação precisa estar verificada ou N/A justificada")
    if app == "not_applicable" and not str(ver.get("observability_rationale", "")).strip():
        issues.append("N/A de observabilidade exige justificativa")
    # Nunca tratar campos autodeclarados como autenticação/autorização válida.
    return issues


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("report", type=Path, help="JSON com dados declarados no relatório de engenharia")
    ap.add_argument("--expected-commit", help="SHA confiável fornecido pelo pipeline; confere coerência do relatório, NÃO autentica evidências")
    args = ap.parse_args()
    try:
        report = json.loads(args.report.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"BLOCKED: relatório ilegível: {exc}")
        return 2
    issues = validate_report(report, expected_commit=args.expected_commit)
    if issues:
        print("BLOCKED — falhas declarativas no relatório:")
        for problem in issues:
            print("- " + problem)
        return 1
    print("REPORT CHECK PASSED (declarative only). Ainda requer CI confiável e aprovações humanas externas.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
