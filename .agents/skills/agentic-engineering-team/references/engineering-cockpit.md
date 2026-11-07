# Engineering Cockpit — especificação do painel do Engineering Owner

**Estado:** especificação e protocolo, **não é um dashboard em execução**. Sem integração, nenhuma métrica está sendo coletada automaticamente. Implementar somente após aprovação do escopo e dos custos pelo Engineering Owner.

## Missão

O painel responde a sete perguntas: **estamos na direção certa? qual tarefa está bloqueada? o sistema está saudável? estamos seguros? a qualidade é verificável? quanto custa avançar? sabemos explicar e manter o que foi construído?** A primeira tela é um *decision surface*, não um terminal de logs. Todas as decisões devem ter origem, timestamp, versão e próximo responsável. A ausência de sinal aparece como `not_configured`, `not_measured`, `stale` ou `not_verified` — nunca como `0`, `PASS` ou verde.

## Instrumento adicional — PROPRIEDADE TÉCNICA

Além dos seis instrumentos operacionais, o Cockpit precisa ter um instrumento de **domínio técnico por projeto**, baseado em evidências de entendimento humano. Exibir: arquitetura e fluxos críticos navegáveis, mudanças não revisadas, ownership cards vinculados a commit, pendências de compreensão, exercício de diagnóstico e próximas revisões. Em modo Monitor/Direct não interromper a execução; em Engineering Workflow, ensinar em marcos e solicitar briefing de alto risco antes de decisões relevantes. Modos `passive|guided|deep` controlam custo e frequência, independentemente dos perfis de segurança.

Arquitetura: eventos normalizados de Codex/Claude/OpenCode + diff Git/CI -> detector determinístico de mudanças relevantes -> mentor opcional -> card com evidência -> ledger -> UI. Caso o provedor não exporte eventos suficientes, marcar lacuna e usar diff local; não alegar universalidade de eventos. Nunca atribuir `verified` só por gerar texto. Validade por versão; prompts e segredos não devem vazar para o armazenamento.

## Visão do piloto — seis instrumentos operacionais + propriedade técnica

| Instrumento | Pergunta | Indicadores iniciais | Fonte autoritativa |
|---|---|---|---|
| RUMO / Produto | Estamos chegando ao MVP? | marcos, critérios de aceite verificados, bloqueios, próxima entrega | backlog/MR + critérios aprovados pelo humano |
| TRIPULAÇÃO / Agentes | Quem trabalha, onde travou? | tarefa, role, fase, estado, duração, retries, delegações | orquestrador e eventos observados Codex |
| COMBUSTÍVEL / Custos | O gasto traz valor? | tokens input/output/cache, custo medido, tempo por entrega, orçamento remanescente | OTel Codex/provedor/fatura, custos infra |
| MOTORES / Runtime | Aplicação está operável? | disponibilidade, taxa de erros, p95, saturação, filas, SLO e burn rate | OTel app + backend de métricas/logs/traces |
| ALERTAS / Segurança | Podemos continuar/publicar? | findings HIGH/CRITICAL abertos, secrets detectados, authz, scanners e ROE | SAST/SCA/DAST/Red Team, CI e registros revisados |
| AERONAVEGABILIDADE / Qualidade | Código pode decolar? | CI por SHA, regressões, mudanças em review, flakiness, rollback | GitLab pipelines + jobs, testes executados |

**Ponto de foco:** topo da tela mostra **uma decisão prioritária**, incluindo impacto, evidência, opções, recomendação do Challenger e ação humana necessária. Não use scores sintéticos opacos (ex.: "saúde 93%") sem especificação pública e validação.

## Camadas da UI

1. **Cockpit executivo (sempre aberto):** seletor projeto/ambiente/janela, última atualização, fontes conectadas e seis instrumentos; próximos três bloqueios, decisão aguardando sua aprovação, próximo marco e botão para abrir evidência.
2. **Drill-down técnico:** por fonte e artefato — tarefas/agentes e gasto; traces/logs da app; histórico de decisões; findings e remediações; execução CI por commit; incidentes. Filtros projeto, ambiente, branch/commit e intervalo. Nunca correlacionar projetos pelo nome livre.
3. **Audit trail:** prova de quem/que sistema emitiu evento, quando, relação com projeto/tarefa/commit/release, estado de verificação e fonte externa. Artefatos não confiáveis não se tornam verdade por serem escritos por agentes.

### Exemplo de cartão de decisão (campos)

- `decision_id`, `project_id`, `task_id`, `commit_sha`, `severity`, `owner`.
- `question`, `why_now`, `options[]`, `recommended_option`, `reason`, `evidence_refs[]`.
- `impact_cost`, `impact_security`, `impact_latency`, `reversibility`, `review_trigger`.
- `status`: `needs_owner_approval | approved_by_human | rejected_by_human | superseded`.
- **Aprovação humana precisa vir do sistema externo com autenticação**, nunca de JSON escrito pelo agente.

## Arquitetura técnica por camadas

```
GitLab MRs / Pipelines ---------Codex OTel logs/metrics ---------Application OTel / OTLP ---------> Collectors + adaptadores -> normalização -> API Cockpit -> UI
CI scanners / findings ----------/                                |            |
Billing / infra / budgets -------/                                |            +--> eventos de alerta
Decisions / ADRs ---------------/                             Storage
```

**Fontes distintas, política de confiança distinta:** GitLab é autoritativo para jobs/merge; Collector/telemetria para sinais observados; faturamento/preços oficiais para custo monetário; ADRs/LLMs são propostas, não prova; humano autenticado para aprovações. Não confundir tokens observados com dólares faturados, especialmente planos de assinatura. Dados de aplicação e de Codex devem permanecer em pipelines/serviços separados, mesmo quando visualizados na mesma UI.

**Stack inicial de baixo custo sugerida para avaliar (não obrigatória):** Bun/TypeScript strict + SQLite para um único operador e baixo volume; Postgres se surgirem múltiplos operadores ou retenção alta. UI estática ou Astro e backend autenticado; OpenTelemetry Collector enviando para Prometheus (métricas), Loki (logs), Tempo (traces) e Grafana (investigação técnica). O Cockpit lê agregados com cache e vincula evidências profundas ao Grafana/GitLab em vez de recriar um APM. Se o usuário já tiver backend observability, reusar. Habilitar deploy/integrations somente com autorização explícita. <https://grafana.com/about/grafana-stack/>.

## Eventos normalizados mínimos

Todos os registros: `event_id`, `type`, `occurred_at` UTC, `observed_at` UTC, `project_id`, `environment`, `source_system`, `source_ref`, `verification_state`, `schema_version`. IDs de alta cardinalidade só em banco/traces, nunca em labels de métricas.

- `work_item`: objetivo, fase, estado, risco, deadline opcional, critérios de aceite e commit/release.
- `agent_run`: task_id, run_id, agent_role, model, status, duration, retries, input/output/cache tokens, fonte da medição; custo `null` quando desconhecido.
- `ci_result`: commit_sha, pipeline_id, job_id, nome do gate, resultado **obtido da API do CI**, URL de evidência.
- `security_finding`: finding_id, severity, status, asset, repro_scope, evidence_ref, remediated_commit, reviewed_by.
- `app_sli`: service, environment, window, request_rate, error_rate, latency p95, SLO target, burn rate, source query.
- `decision`: ADR/issue, autor, challengers, impacto, alternativas, gatilho de revisão, status de aprovação externa.
- `ownership_record`: task_id, commit_sha, critical_flow, code_refs, risk, review_state (`unreviewed|explained|practiced|verified|deferred|stale`), exercise_evidence, next_revisit_trigger. Confirmar compreensão humana por evidência/ação, não por inferência.
- `runtime_incident`: severity, start/end, owner, signals/trace refs, mitigation, postmortem.

Evitar ingestão de credenciais, corpos de prompts, PII, dados de clientes e payloads sensíveis. Endpoints de telemetria exigem autenticação, TLS, controle de acesso por projeto, retenção/backup e mecanismos de redaction. Não armazenar prompts completos por padrão; `log_user_prompt=false` no Codex. Segurança ofensiva só em alvos explicitamente autorizados.

## Alertas / sinalização no topo

- **Vermelho (bloqueante):** release com HIGH/CRITICAL confirmado aberto, CI obrigatório falhou, indisponibilidade além de SLO ou aprovação ausente. É baseado em fonte verificável, não em julgamento solto do agente.
- **Amarelo (precisa atenção):** fonte stale, orçamento próximo do limite acordado, p95 excede objetivo, retries crescentes, mudança de arquitetura sem ADR, regressões.
- **Cinza (sem visibilidade):** `not_configured`, `not_measured`, `not_verified`, `stale`; **nunca** pintar verde por ausência de dados.
- **Verde:** somente verificação real dentro da janela e versão avaliadas. Sempre permitir clicar e ver evidência.

Alertas disparam eventos ou notificações somente após integração e configuração de limites de produto/privacidade; definir janela anti-ruído, deduplicação e responsável. Nenhum agente aciona automaticamente produção/ações irreversíveis.

## MVP incremental (ordem de implementação)

1. **P0 — contrato e provas:** identidade de projeto/commit/release, estados de medição e fontes; manter dados de exemplo marcados como DEMO, isolados.
2. **P1 — cockpit read-only:** API + UI com eventos reais **já disponíveis** (GitLab CI/MR e registros agent_usage), ingestão idempotente, refresh seguro e link para origem.
3. **P2 — dois planos OTel:** telemetria Codex autorizada e telemetria do primeiro serviço; separar custo por agente do estado runtime; comprovar sinais ponta a ponta e redaction.
4. **P3 — Ownership + Security/Challenger:** incluir cards de conhecimento e pontos de atenção, além de ingestão de findings validados, ADRs e bloqueios por release; nunca deixar agente aprovar próprios findings ou mudar permissão de deploy.
5. **P4 — alertas e operação:** orçamento e SLO monitorados, histórico e runbooks; somente após P1–P3 verificadas e aprovação explícita.

### Critérios de aceite antes de declarar cockpit operacional

- Um projeto com repo/CI real e uma API em execução; verificar timestamps, identidade e links para commit/trace/job.
- Pelo menos uma falha de CI e um erro de aplicação simulados aparecem corretamente na UI.
- Uma fonte desligada vira cinza/sem dados (não sucesso). Um finding confirmado pode bloquear release de forma verificável.
- Exemplo de prompt com segredo não aparece em exportador/log; teste de autorização impede ver projeto não permitido.
- Mostrar `null`/"não medido" quando não há tokens por subagente ou custo faturado confiável.
- Testar retenção, falhas de ingestão, atualização idempotente, deduplicação, revogação de acesso e backups conforme risco.

## Pergunta padrão do Engineering Challenger

> "Qual decisão esta métrica muda? Qual é a fonte? Qual o custo de armazená-la? O que acontece se ela estiver incorreta ou desatualizada?"

Se a métrica não suporta decisão de produto, segurança, custo ou operação, **não** adicioná-la ao cockpit inicial.
