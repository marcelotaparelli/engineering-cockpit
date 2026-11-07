# Release Gate — <id>

- [ ] Objetivo e critérios de aceite confirmados
- [ ] Diff/commits revisados; mudanças fora de escopo removidas
- [ ] Typecheck/lint/testes/build conforme stack concluídos em CI
- [ ] Security findings críticos resolvidos ou formalmente aceitos pelo responsável
- [ ] Compatibilidade de dados/contratos e rollback verificados
- [ ] Health/readiness e SLIs/SLOs adequados ao serviço alterado
- [ ] Métricas (erros, latência, tráfego) aparecem no exporter/painel ou lacuna documentada
- [ ] Trace end-to-end com `trace_id` correlacionável a log em cenário real/teste
- [ ] Logs estruturados, sanitizados e eventos de segurança/authz exercitados
- [ ] Alerta acionável, runbook, política de sampling/cardinalidade/retenção verificados ou N/A fundamentado
- [ ] Custo/tokens dos agentes registrados se disponíveis, sem inferir cobrança
- [ ] Segredos ausentes do diff e dos logs
- [ ] Aprovação humana de merge/deploy registrada
- [ ] Plano pós-deploy de verificação e rollback definido

## Adversarial gates (por tier)

- [ ] Challenge: justificativa, opções, custo e gatilho de reavaliação; crítico com parecer independente
- [ ] Red Team: escopo e método registrados; sem teste ativo sem ROE; achados triados e correções verificadas
- [ ] Nenhum finding CRITICAL/HIGH confirmado pendente; aprovações de risco excepcionais via processo humano externo
- [ ] Security Reviewer inspecionou remediação e testes de regressão foram executados
- [ ] Logs/traces/métricas e alertas de abuso relevantes existem e não expõem segredos
