# Technical Ownership Ledger — modelo

Um registro por fluxo crítico/alteração material e commit; preferir armazenamento local com acesso por projeto.

```json
{
  "project_id": "<id>",
  "task_id": "<id>",
  "commit_sha": "<sha_verificado>",
  "area": "<modulo_ou_fluxo>",
  "risk": "standard|critical",
  "evidence_refs": ["<path:line_ou_teste>"],
  "review_state": "unreviewed",
  "open_questions": ["<pergunta_concreta>"],
  "next_revisit_trigger": "<mudanca_contrato_ou_incidente>",
  "owner_confirmed_at": null
}
```

`review_state`: `unreviewed|explained|practiced|verified|deferred|stale`. Nenhum campo inferido de respostas não observadas. `verified` requer demonstração com evidência ou confirmação explícita; explicação enviada pelo agente conta apenas como `explained`. Mudança de SHA/contrato invalida seletivamente cartões afetados, não todo o conhecimento do projeto. Não guardar prompts integrais, PII, segredos ou código confidencial desnecessário.
