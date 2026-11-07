# Scorecards operacionais — dois sistemas de observabilidade

## A. Engenharia agêntica (Tech Lead)

- Eficiência por task: duração até MR aprovado, `input_tokens`, `output_tokens`, `cached_input_tokens`, custo faturado ou preço por uso quando confiável; tentativas/retries, falhas e ferramentas usadas.
- Compare **custo por entrega verificada** e **taxa de CI aprovado na primeira tentativa**, não tokens por linha.
- `cached_input_tokens` é subconjunto de entrada conforme semconv/fonte: não duplique. Modelos/tarifas podem diferir. Assinatura não é faturamento API.
- `scripts/task_metrics.py`: scorecard manual de tarefa. `scripts/agent_usage.py`: registro de invocações por papel/modelo/custo real informado. Nenhum coleta valores sozinho.
- OTel do Codex: opt-in global (`~/.codex/config.toml`); leia `agent-observability.md`. Não registrar prompts/segredos.

## B. Aplicação entregue (SRE + Security + DevOps)

- **Golden signals:** tráfego, erros, duração p50/p95/p99, saturação/filas, disponibilidade. Métricas de negócio pertinentes.
- **Traces:** caminho request → serviço → DB/filas, correlação com logs por `trace_id`/`request_id`, erros e dependências.
- **Logs estruturados:** evento, resultado, erro sanitizado, serviço/ambiente/versão. Eventos sensíveis auditáveis com retenção e controle de acesso.
- **Segurança:** authn/authz, rate-limit, tentativas cross-tenant e mudanças administrativas críticas. Alertas comportamentais com regras revisadas, sem adivinhar ataques.
- **SLOs/alertas/runbooks:** baseline e alvo acordados, owner e teste de diagnóstico/rollback. Instrumentação sem validação não equivale a sinal operacional ativo.
- Fontes, contratos e checklists em `application-observability.md` e `assets/telemetry-contract.md`.

## Separação e governança

Nunca misture telemetria de desenvolvimento agêntico com telemetria de aplicação sem escopo e base legal. Use exporters/serviços/retention separados e acesso mínimo; correlação opcional por `release`/commit não autoriza capturar prompt, usuário final nem payload. O custo de observabilidade (ingestão, cardinalidade, retenção) também precisa de limites.
