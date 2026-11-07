# Plano B — Observabilidade da aplicação (operabilidade e segurança)

**Owner:** `sre_observability` define o contrato de sinais, `backend_engineer`/`frontend_engineer` implementam a instrumentação, `devops_engineer` provisiona exportação/retention/alertas, `security_reviewer` valida eventos e privacidade, `test_engineer` garante testes de telemetria. Tech Lead cobra evidências e gates de deploy.

> Não confundir telemetria do Codex com telemetria do software produzido. Instrumentar a aplicação mesmo que nenhum agente esteja ativo.

## Contrato mínimo por mudança, proporcional ao risco

| Sinal | Obrigação quando relevante | Exemplo de evidência |
|---|---|---|
| Métricas | volume, erros, duração `p50/p95/p99`, saturação; métricas de domínio quando úteis | métrica aparece no endpoint/exporter, contadores aumentam sob teste |
| Traces | `trace_id`/`span_id`, propagação W3C `traceparent`, spans de operações relevantes | uma requisição de teste forma trace HTTP → domínio → DB/integração |
| Logs | JSON estruturado com level, timestamp, service, env, release/commit, `request_id`, `trace_id`, `event`, outcome, erro sanitizado | log correlaciona erro/teste ao mesmo trace; sem PII/segredo |
| Segurança | logs de authn/authz negada, rate limit, validação suspeita, mudança de privilégio, acesso crítico; testes de isolamento por tenant | evento de segurança produz log/auditoria e teste negativo sem dados sensíveis |
| Saúde e operação | readiness/liveness, SLI/SLO, alertas acionáveis, responsável e runbook, rollback | simulação de falha/degradação aciona sinal e procedimento documentado |

### HTTP e métricas

- Preferir semconv OTel quando já disponíveis, como `http.server.request.duration` (histograma em segundos). Latência p95/p99 calculada sobre histograma / distribuição, **não média de percentis individuais**.
- Atributos de métricas devem ter **baixa cardinalidade**: route templated `/users/:id`, método, classe de status, serviço, ambiente. **Nunca** path com ID real, user ID, tenant ID, request ID, trace ID, IP, e-mail como labels métricos.
- Métricas de negócio: pedidos, falhas de processamento, tickets classificados, campanhas enviadas, jobs pendentes etc. Defina nomes, unidades e propósito com o dono do domínio. Evite multiplicar contadores sem caso de uso.
- Para frontend estático sem API própria, priorizar Web Vitals/RUM conforme privacidade, erros JS, uptime, hosting/CDN logs e erros de publicação. Não instalar backends de tracing desnecessários.

### Tracing distribuído

- Usar OpenTelemetry SDK/instrumentação compatível com runtime real e OTLP para exportar; em Bun, confirmar suporte da versão/biblioteca com teste em execução, sem assumir compatibilidade Node de forma automática.
- `traceparent` atravessa gateways e serviços confiáveis; nunca confiar em `tenant_id`/claims do browser para autorização. Traces não devem conter payload, segredo, query com PII ou conteúdo de prompts.
- Amostrar traces de sucesso de modo conservador com taxa configurável, preservar visibilidade sobre erros quando operacionalmente viável, e medir custo do volume de ingestão. Nunca amostrar eventos de auditoria de segurança quando precisam de trilha completa.

### Logs e eventos de segurança

Esquema sugerido (campos não sensíveis, pseudonimizar identificadores conforme avaliação de privacidade):

```json
{"timestamp":"2026-10-24T12:00:00Z","level":"warn","service":"api","env":"staging","release":"commit-short","request_id":"req-safe","trace_id":"trace-safe","event":"authorization.denied","resource_type":"project","outcome":"denied","reason_code":"insufficient_scope"}
```

- Registrar `auth.failed`, `authz.denied`, `rate_limit.triggered`, `input.validation_failed`, `privilege.changed`, `tenant.access_denied`, `security.policy_denied` e ações administrativas críticas quando pertinentes.
- Sem credenciais, tokens, cookies, payload integral, e-mail, CPF, prompts, SQL parametrizado com dados privados, ou stacktrace com segredos. Sanitizar newline/control characters (log injection). Acesso aos logs deve ser restrito, com retenção e trilha de auditoria.
- Eventos críticos de auditoria podem exigir persistência separada **append-only/tamper-evident**; logs observacionais não substituem auditoria obrigatória.
- Regras de detecção baseadas em séries, taxas e contexto (muitas falhas authn, explosão 403, tentativas cross-tenant, privilégios inesperados); evitar tratar todo 403 como ataque.

### SLI/SLO, resposta e gates

- SLI: taxa de sucesso de requests **válidas**; latência na jornada crítica; disponibilidade do serviço; atraso/erro de filas. Documentar numerador, denominador, janela e exclusões.
- SLO e alertas são **propostas**, não objetivos arbitrários: derivar de baseline, expectativa de negócio e error budget aceito. Preferir alertas acionáveis com runbook e pessoa responsável.
- Validação de release: teste de sucesso e erro → métrica muda → trace correlacionado → log seguro e recuperável → alerta/documentação de incidentes → plano de rollback.
- Defeitos em instrumentação podem ser `blocked` em APIs críticas ou `debt` explícito em tarefas menores, conforme política de risco. Jamais marcar como verificado sem exporter/sinal real ou teste de integração.

## Caminho operacional sugerido (vendor-neutral)

`Aplicação → SDK/OTLP → OpenTelemetry Collector → métricas (Prometheus), traces (Tempo), logs (Loki) → Grafana + alertas + runbooks`.

**Esse é um desenho de referência, não implantação automática.** Para serviço pequeno, começar com logs JSON, /health, /ready, métricas de RED, rastreamento essencial e exportação barata já gera valor. Collector ajuda a controlar batch, retries, filtros de privacidade, TLS e custos de ingestão. Validar retenção, cardinalidade e custos.

## Arquivos de saída por projeto

- `assets/telemetry-contract.md`: template de SLI/SLO, instrumentação e segurança.
- `assets/incident-runbook.md`: template de triagem, detecção, rollback e pós-incidente.
- `assets/release-checklist.md`: gate e evidências.

## Fontes oficiais

- https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
- https://opentelemetry.io/docs/collector/
- https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
