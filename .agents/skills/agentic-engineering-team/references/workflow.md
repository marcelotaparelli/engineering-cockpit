# Fluxo SDLC proporcional ao risco

| Tier | Exemplo | Agentes | Gates mínimos |
|---|---|---|---|
| quick | copy, CSS local, bug restrito | Tech Lead sozinho por padrão | mini-challenge (necessário/alternativa menor/risco); teste específico, static security review proporcional; telemetria N/A justificada |
| standard | endpoint novo, módulo isolado | Engineer + Test; Challenger quando há trade-off; Red Team quando superfície exposta; SRE se operacional | testes + challenge e teste adversarial quando aplicáveis, observabilidade proporcional ao código alterado |
| critical | auth, multitenancy, migrar DB, infra/prod | Architect + Challenger + Red Team + Security Reviewer + executor + Test + SRE/DevOps, em ondas | challenge documentado, ROE para testes ativos, threat model, ataques negativos reproduzíveis, observabilidade+auditoria verificadas, CI e aprovação humana |

## Fases

1. **Intake**: requisito, escopo, invariantes, contratos, definição de pronto.
2. **Design / Challenge**: mini ADR para decisão duradoura ou trade-off não trivial; Challenger questiona necessidade, alternativas, custo total, segurança e reversibilidade; Tech Lead registra decisão, evidência e gatilho de revisão. Preferir solução simples e aderente ao produto.
3. **Plan**: decompor no máximo em 3 linhas paralelas. Carimbar ownership por arquivo. Identificar recursos mutáveis compartilhados (banco, migrations, config).
4. **Build**: mudanças pequenas, testes cedo, commits reversíveis (nunca forçados ou automáticos sem autorização explícita).
5. **Verify / Attack**: Red Team gera hipóteses e testes de abuso em ambiente autorizado, encaminha findings ao Tech Lead e Security Reviewer valida remediação. Executar gates determinísticos; quando aplicável, exercitar sucesso/erro/authz negada e provar geração/correlação de métrica, trace e log seguro; reportar resultados de comandos. Reviews LLM agregam cobertura, não substituem CI.
6. **Integrate**: comparar com base, resolver conflitos, executar suite integrada, PR/MR com evidências, challenge/resposta e relatório Red Team (ou motivo de não acionamento).
7. **Ownership**: após fatias verticais significativas, o mentor apresenta fluxo com código e teste, um cenário de depuração e pendências ligadas ao commit. No risco crítico, briefing antes de decisão humana. Sem checkpoint a cada arquivo; domínio humano não é inferido de saída da IA.
8. **Deploy**: aprovação + plano de rollout/rollback + dashboard, alerta e runbook testáveis + validação pós-deploy, apenas após autorização.
9. **Learn / Reassess**: revisar o registro de decisões somente quando incidentes, SLOs, custo ou requisito invalidarem hipóteses; programar testes de segurança em CI para recorrência real, com autorização. Além disso, comparar tempo, custo e retrabalho com baseline single-agent; correlacionar incidentes/regressões pós-release ao commit, sem misturar PII ou conteúdo de usuários aos dados dos agentes.

## Anti-padrões

- Spawn de todos os papéis por padrão.
- Nove especialistas repetindo a leitura de todo o repo.
- Review circular: o mesmo agente escreve e certifica o próprio código.
- Challenger travando trabalho por preferência sem evidência; Red Team lançando testes sem ROE, em loops infinitos, ou afirmando que falta de findings é segurança.
- Paralelismo de código no mesmo working tree.
- Repetir build/test completo após cada microedição, sem sinal de benefício.
- "Passou" baseado em texto sem execução real.
- Ganhos de performance inventados ou custos calculados de tokens estimados como se fossem faturamento.

## Critérios de saída da tarefa

Mudança funcional comprovada, testes relevantes (ou falha explicitada), impacto de segurança e operações identificado, aplicação instrumentada quando necessário (métricas, traces, logs, sinais de segurança), diff inspecionado, evidências vinculadas ao commit final. Fatores bloqueantes não são omitidos para declarar conclusão.
