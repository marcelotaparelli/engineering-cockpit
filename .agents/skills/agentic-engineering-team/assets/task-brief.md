# Task Brief — <id>

**Objetivo:** uma frase, resultado observável.
**Tier:** quick | standard | critical
**Agente responsável:** <role>
**Escopo (pode editar):** `src/x.ts`, `tests/x.test.ts`
**Fora de escopo:** outros diretórios, CI, deployment, migrations (editar somente com autorização explícita)
**Entradas/contratos:** links para arquivos, interfaces, ADRs e exemplos estritamente necessários
**Critérios de aceite:** checks verificáveis
**Testes/comandos:** o menor subconjunto suficiente + gates de integração
**Dependências:** task IDs bloqueadoras, recursos compartilhados
**Risco:** superfícies de segurança/dados/produção
**Challenge do design:** por que a decisão? Alternativas, custos e gatilho de reavaliação (ou N/A)
**Segurança adversarial:** scope e ROE autorizados para testes ativos; hipóteses prioritárias, versão e modo `static-local` ou `staging-active`
**Plano de observabilidade da aplicação:** sinais afetados (métrica/trace/log/security), contrato SLI/SLO, validação e N/A justificado quando pertinente
**Controle do agente:** registrar tokens/custo/duração/retries somente quando observados
**Saída exigida:** arquivos, diff/commit, testes executados + resultado, telemetria validada/não verificada, falhas, dúvidas, próximo passo

> Não envie transcrição nem todo o repositório; passe paths e contexto mínimo. Não execute push, deploy ou ações destrutivas sem aprovação.
