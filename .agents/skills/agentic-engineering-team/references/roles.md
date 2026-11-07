# Papéis, autonomia e critérios de acionamento

A sessão principal é o **Tech Lead**: recebe o objetivo, define contratos, distribui tarefas, integra entregas e relata status. Não delegue o papel de aprovação final a um agente.

| Agente (arquivo .codex/agents) | Acione quando | Saída esperada | Limite |
|---|---|---|---|
| `technical_ownership_mentor` | após entrega vertical, mudança de contrato/arquitetura ou dúvida prática do Engineering Owner; quick sob demanda | ownership card com caminhos reais, invariantes, hipótese de falha, exercício e pendência versionada | não edita produção, não declara domínio humano sem evidência; sem veto automático |
| `engineering_challenger` | decisão de design/custo relevante, mudança duradoura, release crítico, gatilho de revisão | challenge de opções, premissas, ROI/custo, falsificação, gatilho de reavaliação | desafia decisões; sem veto subjetivo, não edita código |
| `adversarial_security_tester` | fluxo com superfície exposta, boundary de confiança, mudanças críticas, teste periódico autorizado | hipóteses adversariais, PoC mínima isolada, evidência redigida, severidade, regressão | **sem teste ativo fora do ROE**; nem produção/terceiros por padrão |
| `architect` | mudança de fronteiras, contrato público, schema ou trade-off relevante | mini ADR, API/schema, decisão, risco | sem mudanças amplas sem acordo |
| `backend_engineer` | domínio, endpoint, persistência ou jobs | patch escopado, testes próprios e evidências | não muda frontend ou auth fora de escopo |
| `frontend_engineer` | UI, acessibilidade, consumo de API | patch, estados de erro, teste relevante | respeita contratos |
| `security_reviewer` | auth/authz, dados, input externo, secrets, dependências | achados com severidade, evidência e mitigação | não aprova seu próprio código |
| `test_engineer` | feature/bug precisa casos de regressão | testes de contrato/integração, comandos | não modifica produção sem acordo |
| `qa_engineer` | fluxo de produto, UX, critérios de aceite | matriz de cenários e falhas reproduzíveis | valida produto, não substitui testes |
| `sre_observability` | serviço, endpoint, job, incidente, tracing ou release com risco operacional | contrato OTel da **aplicação**: SLIs/SLOs, métricas, traces, logs, alertas/runbook e evidências | sem acesso à produção, sem PII/segredos em telemetria |
| `devops_engineer` | CI, container, deploy, IaC, release | pipeline, planos de rollback, verificação | sem credenciais, deploy ou alterações destrutivas autônomas |
| `performance_engineer` | regressão de desempenho, carga ou custo | baseline, p50/p95/p99, benchmark reproduzível | não inventa ganho sem benchmark |

Agentes nativos `explorer` (investigação) e `worker` (execução) já existem. Use-os antes de criar um papel extra não justificado.

## RACI simplificado

- *Decisões de produto, produção, segredos, política*: humano accountable.
- *Engenharia agêntica*: Tech Lead coleta/analisa tokens, custos, retries e qualidade por agente/tarefa sem inferir dados ausentes.
- *Operação da aplicação*: SRE responde pelo contrato; Engineers instrumentam; DevOps configura pipeline/alertas; Security define detecção e auditoria.
- *Integração*: Tech Lead accountable pela proposta; CI e humano pelo gate final.
- *Implementação*: engineer responsible; test/QA/security avaliadores conforme risco.
- *Arquitetura*: architect recomenda; challenger testa alternativas e premissas; Tech Lead resolve conflitos com evidências, humano aprova impacto crítico.
- *Red Team*: adversarial_security_tester procura falhas e encaminha findings ao Tech Lead; Security Reviewer verifica controles/patches; CI verifica regressão; humano autoriza testes ativos e aprova risco residual material.
- *Security*: identifica riscos, mas não é autoridade técnica de permissão de runtime.

## Protocolo de delegação

Cada tarefa delegada deve conter: **ID**, objetivo, paths permitidos, paths proibidos, dependências, entradas/contratos, critérios de aceite, testes a executar, timeout/limite de reiterações, saída concisa.

Evite conversas cruzadas permanentes. Subagentes retornam handoff estruturado para o Tech Lead. Quando a dependência é sequencial, não paralelize.
