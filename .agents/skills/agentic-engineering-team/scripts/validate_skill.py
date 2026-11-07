#!/usr/bin/env python3
"""Valida estrutura de uma skill Codex sem dependências externas."""
import sys
import re
import tomllib
from pathlib import Path

EXPECTED = {"architect", "backend_engineer", "frontend_engineer", "security_reviewer", "test_engineer", "qa_engineer", "sre_observability", "devops_engineer", "performance_engineer", "engineering_challenger", "adversarial_security_tester", "technical_ownership_mentor"}

def validate(repo: Path) -> list[str]:
    errors = []
    skill = repo / ".agents/skills/agentic-engineering-team/SKILL.md"
    if not skill.is_file():
        return [f"SKILL.md ausente: {skill}"]
    body = skill.read_text(encoding="utf-8")
    if not body.startswith("---\n") or "\n---\n" not in body[4:]:
        errors.append("Frontmatter YAML inválido/ausente")
    else:
        front = body.split("---", 2)[1]
        for field in ("name", "description"):
            if not any(line.startswith(field+":") and line.split(":", 1)[1].strip() for line in front.splitlines()):
                errors.append(f"Campo frontmatter ausente: {field}")
    roles = repo / ".codex/agents"
    for role in EXPECTED:
        path = roles / (role + ".toml")
        if not path.is_file():
            errors.append(f"Role ausente: {path}")
            continue
        try:
            parsed = tomllib.loads(path.read_text(encoding="utf-8"))
            for key in ("name", "description", "developer_instructions"):
                if not isinstance(parsed.get(key), str) or not parsed[key].strip():
                    errors.append(f"{path}: {key} ausente/vazio")
            if parsed.get("name") != role:
                errors.append(f"{path}: name divergente")
        except tomllib.TOMLDecodeError as exc:
            errors.append(f"{path}: TOML inválido: {exc}")
    example = repo / ".codex/config.example.toml"
    if example.exists():
        try:
            parsed = tomllib.loads(example.read_text(encoding="utf-8"))
            if parsed.get("agents", {}).get("max_concurrent_threads_per_session", 0) < 1:
                errors.append("max_concurrent_threads_per_session inválido")
        except tomllib.TOMLDecodeError as exc:
            errors.append(f"Config exemplo inválida: {exc}")
    # Confirme os links de arquivos locais citados na skill.
    for sub in sorted(set(re.findall(r"(?:references|assets|scripts)/[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)*", body))):
        if not (skill.parent / sub).is_file():
            errors.append(f"Referência local quebrada em SKILL.md: {sub}")
    for sub in ("references/token-policy.md", "references/security-gates.md", "references/agent-observability.md", "references/application-observability.md", "assets/task-brief.md", "assets/handoff.md", "assets/telemetry-contract.md", "assets/incident-runbook.md", "assets/codex-otel.user.example.toml", "scripts/agent_usage.py", "scripts/review_gate.py", "references/challenger-protocol.md", "references/red-team-protocol.md", "assets/challenge-review.md", "assets/red-team-report.md", "assets/rules-of-engagement.md", "assets/decision-register.md", "references/engineering-cockpit.md", "assets/cockpit-scorecard.md", "references/technical-ownership.md", "assets/ownership-card.md", "assets/ownership-ledger.md"):
        if not (skill.parent / sub).is_file():
            errors.append(f"Arquivo obrigatório ausente: {sub}")
    otel_sample = skill.parent / 'assets/codex-otel.user.example.toml'
    if otel_sample.is_file():
        try:
            telemetry = tomllib.loads(otel_sample.read_text(encoding='utf-8'))
            if telemetry.get('otel', {}).get('log_user_prompt') is not False:
                errors.append('Exemplo OTel deve manter log_user_prompt=false')
        except tomllib.TOMLDecodeError as exc:
            errors.append(f'OTel exemplo TOML inválido: {exc}')
    # Verificar que o plano de observabilidade nao foi omitido por engano.
    for text, content in (("SKILL.md", body),
            ("references/application-observability.md", (skill.parent/"references/application-observability.md").read_text(encoding="utf-8") if (skill.parent/"references/application-observability.md").exists() else "")):
        for key in ("métricas", "traces", "logs", "segurança"):
            if key not in content.lower():
                errors.append(f"{text}: contrato de observabilidade incompleto ({key})")
    return sorted(errors)

if __name__ == "__main__":
    repo = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors = validate(repo)
    if errors:
        print("INVALIDO:\n" + "\n".join(f"- {e}" for e in errors), file=sys.stderr)
        raise SystemExit(1)
    print(f"OK: skill e {len(EXPECTED)} roles TOML validadas em {repo}")
