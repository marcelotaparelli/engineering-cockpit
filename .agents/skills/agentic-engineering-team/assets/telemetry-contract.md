# Telemetry Contract — <service / feature / task>

**Serviço e ambiente:** ...
**Owner SRE:** ...
**Criticidade e risco dos dados:** ...
**Artefato (commit/release):** ...

## SLIs/SLOs (somente quando aplicáveis)

| Jornada | SLI (numerador / denominador / janela) | Baseline | SLO aprovado | Painel e alerta | Owner |
|---|---|---|---|---|---|
| Ex.: POST /orders | respostas bem-sucedidas / válidas em 30 dias | a medir | a definir | dashboard + runbook | ... |

## Instrumentação requerida

- [ ] HTTP: contagem, erros, duração de request (histograma), saturação quando relevante.
- [ ] Processo/infra: uso de recurso, pool e fila quando relevantes.
- [ ] Domínio: métricas de sucesso/falha de operações importantes (sem IDs de alta cardinalidade).
- [ ] Traces: contexto W3C propagado e spans de operações críticas.
- [ ] Logs JSON: fields, `request_id`, `trace_id`, resultado, níveis, sanitização.
- [ ] Eventos de segurança: auth/authz, rate-limit, privilégio/tenant, quando relevantes.
- [ ] Alertas: severidade, limiar calibrado, owner, runbook.
- [ ] Custos: sampling, cardinalidade, retenção e custo de ingestão revisados.

## Evidências reproduzíveis

| Cenário | Comando/ação | Métrica | Trace | Log/auditoria | Resultado |
|---|---|---|---|---|---|
| sucesso | ... | ... | ... | ... | ... |
| erro controlado | ... | ... | ... | ... | ... |
| authz negada | ... | ... | ... | ... | ... |
| exporter fora | ... | ... | ... | ... | ... |

**Resultado:** verified | partial | blocked | not_applicable com justificativa e aprovador.
