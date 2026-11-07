# Plano A — Observabilidade da equipe de agentes (Codex e automações)

**Responsável:** Tech Lead. **Objetivo:** custo total por mudança aprovada, transparência sobre decisões/execução, confiabilidade do workflow e descoberta de gargalos. Não confundir métricas da equipe com sinais da aplicação entregue (ver `application-observability.md`).

## Contrato de medição

| Campo | Unidade / origem | Regras |
|---|---|---|
| `task_id`, `run_id`, `agent_role`, `model`, `provider`, `tier` | IDs não sensíveis, versão do modelo | `run_id` único para evitar dupla contagem; não usar IDs privados como labels Prometheus |
| `input_tokens`, `output_tokens`, `cached_input_tokens` | contadores **observados** pelo provedor/Codex | cached geralmente é subconjunto de input; **não somar novamente** |
| `cost_usd` | faturamento ou preço oficial vigente aplicado ao uso observado | se não existe medição/preço, usar `null`/não medido; planos por assinatura não equivalem a cobrança por token |
| `duration_ms`, `queue_ms`, `tool_calls`, `retry_count` | execução real e resultado | medir quando o runtime disponibilizar dados; não inferir de texto do LLM |
| `status`, `failure_kind` | resultado `success/failed/blocked/cancelled` | categorizar: timeout, permissão, teste, API/rate-limit, conflito, orçamento |
| `ci_first_pass`, `review_rework`, `defects_after_release` | CI, PR/MR e incidentes | vincular ao commit para evitar atribuição incorreta |

- O custo por tarefa inclui **todas** as tentativas, agentes e retries. Não exclua tentativas falhas.
- Para modelos com preços diferentes em tokens de entrada/saída/cache, discrimine antes de calcular valores monetários; não trate todos tokens como mesma tarifa.
- Se custo monetário não puder ser inferido com confiança, mostre somente uso real em tokens e a origem. Marque valores ausentes, não zere artificialmente.
- Limites de orçamento: alerta em limiar acordado e parada mediante política executável de runtime/CI; instruções em prompt **não são hard cap** de gasto.

## Telemetria Codex (opcional, explicitamente autorizada)

- Configuração OTel de Codex é **global** em `~/.codex/config.toml`; `.codex/config.toml` do projeto **não pode definir** a seção `otel`.
- Exemplo de *opt-in* em `assets/codex-otel.user.example.toml`, separado do pacote ativo. Nunca reconfigure os exporters do usuário sem aprovação.
- `log_user_prompt = false`. Além disso, desabilite captura de corpos de prompt/resposta/código, argumentos secretos e ferramentas sensíveis no coletor de destino. Teste redaction também em eventos de erro.
- Codex dispõe de exportação OTel de logs, traces e métricas (conforme versão e config); **não garanta que cada subagente receba automaticamente um custo isolado ou trace_id correlacionado com Git**. Se a telemetria não fornecer ligação inequívoca, registre agregação por sessão e marque atribuição por agente como indisponível.
- Métricas do Codex não substituem faturamento do provedor. Verificar campo, versão, período e finalidade antes de usar no dashboard.

## Dashboards e alertas úteis

**Painel de eficiência (somente dados medidos):** consumo por tarefa/agent/model; total por período; cache hit relativo; falhas e retries; tempo e taxa de PR/CI aprovado; regressões e incidentes gerados; custo por entrega verificada.

**Alertas:** orçamento diário/mensal excedendo limiar *definido pelo proprietário*; agente preso em retries; falhas repetidas de ferramentas; queda da taxa de aprovação em CI. Em excesso de orçamento, pare novas invocações se houver controle operacional para isso; em tarefas críticas não elimine gates de segurança.

## Registro sem dependências

`scripts/agent_usage.py` armazena registros JSONL de uso **informado explicitamente a partir de uma fonte observada**, por invocação, sem chamadas ao Codex/Cloud e sem gravar conteúdo de prompts. Um `run_id` não pode ser duplicado no mesmo arquivo. Use storage privado fora do Git.

## Links oficiais

- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/config-file/config-advanced
- https://opentelemetry.io/docs/specs/semconv/gen-ai/
