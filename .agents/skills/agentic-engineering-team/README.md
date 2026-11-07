# Agentic Engineering Team v1.5 — Manual de uso no Codex

Equipe de engenharia agêntica para **planejar, desenvolver, contestar decisões, testar, procurar vulnerabilidades e preparar releases**, com qualidade mensurável, segurança, economia de tokens, **propriedade técnica** e **duas observabilidades separadas**: (1) execução/custo dos agentes; (2) comportamento/segurança da aplicação.

> **Natureza do pacote:** uma **skill com especialistas Codex**, não um orquestrador autônomo externo. A sessão principal é o **Tech Lead**. Especialistas só são convocados quando há benefício. A skill não provisiona telemetria, não inicia monitoramento contínuo, não habilita permissões e **não faz push, merge ou deploy automaticamente**.

## Índice rápido

1. [Instalação e atualização segura](#1-instalação-e-atualização-segura)
2. [Configuração inicial no Codex](#2-configuração-inicial-no-codex)
3. [Primeira sessão: onboarding](#3-primeira-sessão-onboarding)
4. [Fluxo diário](#4-fluxo-diário)
5. [Equipe, permissões e decisões](#5-equipe-permissões-e-decisões)
6. [Challenger e Red Team](#6-challenger-e-red-team)
7. [Tokens, custos e observabilidade](#7-tokens-custos-e-observabilidade)
8. [Gates e evidências de release](#8-gates-e-evidências-de-release)
9. [Testes do pacote](#9-testes-do-pacote)
10. [Problemas comuns e limitações](#10-problemas-comuns-e-limitações)
11. [Engineering Cockpit](#11-engineering-cockpit)
12. [Technical Ownership — não acumular débito de compreensão](#12-technical-ownership--não-acumular-débito-de-compreensão)

## 0. Quick Start — prompts prontos (copiar e colar)

Estes prompts são **para uma sessão Codex após a instalação**, não comandos de shell. Comece pela opção A para produto novo ou pela opção C para repositório já existente.

### A — Aplicação nova: discovery e arquitetura **sem implementar**

```text
$agentic-engineering-team

Vamos criar uma aplicação. Atue como Tech Lead.
PRODUTO: [o que a aplicação fará]
OBJETIVO DE NEGÓCIO: [problema, público e resultado]
RESTRIÇÕES: [orçamento, stack, prazo, dados e requisitos]

Execute apenas Discovery + Architecture:
1. Delimite MVP em fatias verticais e critérios de aceite verificáveis.
2. Chame Architect, Engineering Challenger e Security na medida do risco.
3. Compare até 3 alternativas, custos recorrentes, performance, segurança,
   manutenção, reversibilidade e critérios para reavaliar decisões.
4. Defina estratégia de testes, CI/CD, rollback, SLOs e observabilidade da
   aplicação (logs, métricas, traces e eventos de segurança).
5. Defina observabilidade dos agentes: fontes dos tokens/custos, origem,
   limites operacionais e marcação do que ainda não é mensurado.
6. Proponha roadmap priorizado e o mínimo Engineering Cockpit read-only.

Entregue plano curto, ADRs relevantes, riscos e decisões aguardando aprovação.
Não implemente, faça push, configure exportadores ou faça deploy nesta fase.
```

### B — Arquitetura aprovada: primeira entrega vertical

```text
Arquitetura aprovada dentro das decisões registradas.
Inicie a primeira fatia vertical do MVP, com critérios de aceite e ownership.
Implemente testes, CI e observabilidade proporcional a uma API/serviço novo.
Use especialistas sob demanda; Challenger para decisões materiais e Red Team
para revisão de código e testes locais isolados autorizados.
Execute testes, capture evidências por commit e relate tokens/custos observados
(ou "não medidos"). Gere scorecard Engineering Cockpit do estado atual.
Não faça push, merge, mudanças de infraestrutura ou deploy sem autorização.
```

### C — Projeto existente: onboarding sem edição

```text
$agentic-engineering-team
Assuma o papel de Tech Lead. Analise este repositório sem editar arquivos.
Mapeie arquitetura, backlog, CI, segurança, testabilidade e dois planos de
observabilidade. Acione Challenger para questionar decisões significativas;
Red Team apenas para threat model/análise estática local, sem ataques ativos.
Mostre 3 melhorias de maior impacto com evidências, custo, riscos e esforço.
Diga que sinais o Engineering Cockpit consegue medir hoje e quais faltam.
```

### D — Trabalho diário: implementar/revisar

```text
$agentic-engineering-team
OBJETIVO: [resultado]
ACEITE: [comportamento verificável]
RESTRIÇÕES: [limites]
Classifique quick/standard/critical; convoque apenas especialistas necessários.
Faça challenge proporcional, implemente/teste, revise segurança/observabilidade.
Entregue o diff, logs de execução relevantes, findings, fonte de cada métrica,
agentes usados, tokens/custos realmente observados e pendências.
Escalone decisões arquiteturais significativas e operações sensíveis.
Não faça push ou deploy sem autorização.
```

### E — Revisão de release e incidentes

```text
$agentic-engineering-team
Revise o commit/ambiente alvo informado por mim. Confirme CI e critérios por
fontes externas verificáveis; avalie findings, mudanças, SLOs e rollback.
Separe PASS/BLOCKED/NOT VERIFIED. Não trate relatório autodeclarado como CI.
Se for incidente, comece por contenção e evidências, sem mudanças destrutivas.
Não execute ações em produção sem autorização específica.
Entregue recomendação de go/no-go e principais bloqueios.
```

### F — Quando for implementar o cockpit

```text
$agentic-engineering-team
Leia references/engineering-cockpit.md e assets/cockpit-scorecard.md da skill.
Projete o menor Engineering Cockpit read-only com dados reais já disponíveis.
Comece pelas fontes autoritativas (GitLab, consumo observado e runtime OTel).
Defina contrato de eventos, segurança/retention, gates, custo e testes. Não
invente dados de demonstração como se fossem reais. Apresente plano e custo
antes de implementar a integração; não provisione nada sem autorização.
```

### G — Revisar o que os agentes construíram (propriedade técnica)

```text
$agentic-engineering-team
Quero desenvolver propriedade técnica sobre a entrega atual.
Acione technical_ownership_mentor só para os fluxos relevantes deste diff.
Usando código, testes e commit reais, mostre: o que mudou, por quê,
entrada -> decisão -> persistência/saída, invariantes e failure modes.
Demonstre como investigar uma falha com comando/teste/log/trace e proponha
UM exercício prático que valide minha compreensão. Seja curto e técnico.
Registre dúvidas pendentes no ledger, sem afirmar que já domino o tema.
Não modifique código nesta revisão.
```

---

## 1. Instalação e atualização segura

**Pré-requisitos:** Codex CLI com suporte a skills/subagentes, Git, Python 3.11+ (para os scripts), um repositório Git. Ferramentas da aplicação (Bun, Node, Docker, etc.) são específicas de cada projeto, não dependências da skill.

Baixe `agentic-engineering-team-codex-v1.5.zip`, extraia **num diretório temporário**, confira os arquivos e rode o instalador com prévia:

```bash
mkdir -p /tmp/agentic-engineering-team-v1.5
unzip agentic-engineering-team-codex-v1.5.zip -d /tmp/agentic-engineering-team-v1.5
cd /tmp/agentic-engineering-team-v1.5
python3 install.py --repo /caminho/para/meu-repo --dry-run
```

Para **primeira instalação** (sem sobrescrever divergências):

```bash
python3 install.py --repo /caminho/para/meu-repo
```

Para **atualizar da v1.4 para v1.5**, confira o diff, e só então autorize substituição dos arquivos gerenciados:

```bash
python3 install.py --repo /caminho/para/meu-repo --dry-run --update
python3 install.py --repo /caminho/para/meu-repo --update
```

O `--update` salva cópias dos arquivos divergentes em `.agentic-backups/<data>/` **antes** da atualização. Adicione `.agentic-backups/` ao `.gitignore` do projeto; backups podem conter instruções internas. Para rollback, recupere as versões do backup ou reverta os arquivos pelo Git. Faça commit da configuração revisada para rastreabilidade, conforme sua política.

**O instalador nunca modifica `AGENTS.md` nem `.codex/config.toml` ativos.** Ele instala `AGENTS.example.md` e `.codex/config.example.toml` para que você os mescle manualmente. Se houver conflitos, a instalação padrão bloqueia. Não extrair diretamente com `unzip -n` sobre uma instalação anterior: isso preserva arquivos antigos silenciosamente e pode misturar versões.

**Instalação global alternativa:** pode copiar manualmente `.agents/skills/agentic-engineering-team/` para `~/.agents/skills/` e os TOML de `.codex/agents/` para `~/.codex/agents/`, após revisar conflitos. Prefira **por repositório** no início para controlar diferenças entre projetos.

## 2. Configuração inicial no Codex

Na raiz do repositório, inspecione `.codex/config.example.toml` e mescle as opções no `.codex/config.toml` **de um repositório confiável** ou no `~/.codex/config.toml`, conforme suas preferências. Exemplo opcional:

```toml
[agents]
enabled = true
max_concurrent_threads_per_session = 3
default_subagent_reasoning_effort = "medium"
```

O limite `3` é **teto de subagentes concorrentes**, não meta de utilização. Não declare os 12 especialistas para cada tarefa; os TOMLs são descobertos quando o ambiente está configurado corretamente. Os agentes herdam as permissões da sessão principal. Um agente que diz “não editar” **não constitui sandbox de segurança**.

Em sessão interativa local, prefira `workspace-write` + `on-request` (ou perfil equivalente de permissões), evitando acesso irrestrito. Mantenha segredos fora do repo e nunca amplie rede/filesystem só para evitar uma aprovação.

Se o repositório tiver `AGENTS.md`, integre apenas as regras permanentes úteis de `AGENTS.example.md` sem duplicar instruções. Não transforme o `AGENTS.md` em um manual de 50 páginas: a skill e `references/` contêm detalhes carregados sob demanda.

```bash
cd /caminho/para/meu-repo
codex --version
codex
```

Na sessão, confira `/skills`, invoque `$agentic-engineering-team`, use `/subagents` para acompanhar especialistas (na versão da CLI que disponibilizar esse comando), `/status` para diagnosticar estado e `/diff` para revisar mudanças. Os comandos e as opções de modelos variam conforme versão/acesso; consulte a ajuda da sua instalação.

## 3. Primeira sessão: onboarding

Faça **uma única auditoria inicial por projeto**, não uma auditoria global antes de cada tarefa. Prompt recomendado:

```text
$agentic-engineering-team
Assuma o papel de Tech Lead. Faça onboarding do repositório SEM alterar arquivos:
- Mapeie arquitetura, contratos, fluxo de execução e dependências importantes.
- Avalie testes, CI/CD, segurança, deploy, rollback e observabilidade existente.
- Identifique superfícies com risco operacional e limites de autorização.
- Use o engineering_challenger para contestar decisões arquiteturais materiais.
- Use o adversarial_security_tester somente para threat model/análise estática local.
- Priorize 3 melhorias por impacto, risco, esforço e custo; não invente métricas.
- Entregue síntese breve com paths e evidências, sem análises duplicadas.
```

Guarde os achados relevantes no registro de decisões / documentação do projeto **apenas após revisar**; evite exigir que a IA releia todo o repositório na próxima feature.

## 4. Fluxo diário

**Você descreve o resultado; Tech Lead coordena.** Use este prompt mestre para features, bugs e refatorações:

```text
$agentic-engineering-team

OBJETIVO: [resultado de produto]
CRITÉRIOS DE ACEITE: [comportamentos verificáveis]
RESTRIÇÕES: [compatibilidade, prazo, dados, orçamento]

Atue como Tech Lead. Classifique a tarefa quick/standard/critical.
Analise só o contexto relevante e defina contratos/ownership.
Acione apenas agentes cujo trabalho independente aumente qualidade ou velocidade.
Challenger deve contestar decisões relevantes com alternativas e trade-offs.
Red Team deve priorizar hipóteses de ataque e executar apenas testes locais
isolados ou em ambiente explicitamente autorizado por regras de engajamento.
Implemente, teste, revise segurança e valide observabilidade proporcional ao risco.
Otimize custo total de entrega (tokens + retrabalho + manutenção), não só tokens.
Antes de decisões arquiteturais, aumento material de custo ou operação sensível,
mostre um plano curto para aprovação. Não faça push/merge/deploy sem autorização.
Ao fim, apresente relatório verificável e riscos residuais.
```

**Após aprovação do plano:**

```text
Plano aprovado dentro do escopo. Execute e delegue tarefas realmente independentes.
Escalone apenas mudanças materiais de arquitetura/custo/risco e ações sensíveis.
Entregue diff, testes executados, findings, telemetria e consumo observado.
```

### Qual fluxo escolher?

| Tier | Quando | Prática recomendada |
|---|---|---|
| `quick` | CSS/texto/bug isolado sem superfície crítica | Tech Lead sozinho, mini-challenge, teste específico |
| `standard` | Feature de módulo ou endpoint normal | 1 executor; testador/revisor independente sob demanda; Challenger quando a decisão muda o sistema |
| `critical` | Auth/tenant, pagamentos, migrações, segredos, infra e produção | Architect + Challenger antes do design; engenheiros; Red Team/Security/Test/SRE/DevOps **em ondas**, não em paralelo indiscriminado |

Para duas implementações independentes **com alteração de arquivos**, considere Git worktrees e sessões Codex separadas. **Subagentes nativos não equivalem automaticamente a worktrees.** Testes, build e CI devem validar a versão final integrada.

## 5. Equipe, permissões e decisões

**O Tech Lead é a sessão principal**, não mais um arquivo TOML. Os 12 especialistas são: `architect`, `backend_engineer`, `frontend_engineer`, `test_engineer`, `qa_engineer`, `security_reviewer`, `sre_observability`, `devops_engineer`, `performance_engineer`, `engineering_challenger`, `adversarial_security_tester`, `technical_ownership_mentor`.

**Delegação:** cada especialista recebe um brief com objetivo, paths/ownership, contratos, evidências esperadas e limites de execução (`assets/task-brief.md`). Os resultados voltam no formato curto de `assets/handoff.md`. Releituras de todo o repo e reuniões intermináveis entre agentes são antipadrões.

**Separação de responsabilidade:** implementador não aprova o próprio patch; Challenger não decide sozinho valor de produto; Red Team não aprova sua própria correção; Security revisa remediação; CI/controles humanos aplicam aprovações e deploy. Não conceder permissões por texto de prompt.

## 6. Challenger e Red Team

**Engineering Challenger:** pergunta “por que fazer?”, “por que agora?”, “qual a alternativa menor?”, “qual custo total?”, “qual evidência?”, “o que faria reverter?”. Compara até 3 opções, apresenta objeções relevantes, registra confiança e gatilhos de revisão. **Não é um veto infinito**: uma rodada por decisão material, nova rodada só com evidência nova. Templates: `assets/challenge-review.md` e `assets/decision-register.md`.

**Adversarial Security Tester:** busca falhas reais em authz, multi-tenant, entradas, APIs, dependências, CI, prompts/MCP, infra e exposição de dados. Por padrão só análise de código, ameaças e testes **locais isolados**. Para staging ativo: autorização explícita de alvo, janela, credenciais sintéticas, taxa, stop conditions e plano de recuperação (`assets/rules-of-engagement.md`). Não faz testes em terceiros nem produção por padrão. Reporta fatos reproduzíveis, suspeitas e não testado, sem afirmar que ausência de findings significa segurança. `security_reviewer` e testes de regressão verificam correções.

## 7. Tokens, custos e observabilidade

### A. Observabilidade da equipe de agentes

O Tech Lead deve medir **quando houver fonte real**: tokens input/output/cache, agente/modelo, tentativas, duração, falhas, CI/retrabalho e custo verificado. Sem medição, use **“não medido”**, não zero. Assinatura do Codex **não equivale** a cobrança da API por token.

```bash
python3 .agents/skills/agentic-engineering-team/scripts/agent_usage.py --help
python3 .agents/skills/agentic-engineering-team/scripts/task_metrics.py --help
```

Os scripts registram dados **fornecidos** a eles; não capturam automaticamente todas as invocações. OTel para o próprio Codex é **opt-in global** em `~/.codex/config.toml`, usando `assets/codex-otel.user.example.toml` somente após revisão de privacidade e criação de Collector. Não registre prompts, segredos ou payloads pessoais. Consulte `references/agent-observability.md` e `references/token-policy.md`.

### B. Observabilidade da aplicação

Para APIs, serviços e jobs: eventos de erro e segurança, métricas RED (taxa/erros/duração), latência p50/p95/p99, logs JSON redigidos, traces correlacionados, health/readiness, SLIs/SLOs e alertas/runbooks conforme criticidade. Use OpenTelemetry e evite cardinalidade elevada, PII e excesso de retenção. `sre_observability` define o contrato (`assets/telemetry-contract.md`), engenharia instrumenta, DevOps coleta, Security audita e QA/Test comprova sinais **em execução**.

Para alterações puramente editoriais/estáticas, registre N/A justificado, sem instalar pilha de observabilidade desnecessária. Se não for possível provar ingestão ou correlação de sinais, reporte **não verificado**. Veja `references/application-observability.md`.

### Economia de tokens sem perder qualidade

- Prefira `rg`, trechos relevantes e `git diff` a despejar arquivos inteiros; não cole `.env`, lockfiles grandes ou logs extensos.
- **1 agente** em tarefas simples; 1 executor + verificação quando independente; múltiplas ondas em tarefas críticas.
- Reasoning baixo em buscas triviais; médio na implementação; alto apenas para diagnósticos/decisões difíceis, conforme modelos disponíveis.
- `/compact` após marcos e handoff persistido; tarefa nova sem relação → nova sessão, não um chat infinito.
- Após duas tentativas iguais sem evidência nova, interrompa e replaneje.
- Nunca remova gates de segurança essenciais apenas para reduzir consumo.

## 8. Gates e evidências de release

Antes de declarar **pronto para revisão/merge**: diff final e commit/branch conhecidos; comandos/exit codes de testes; typecheck/lint/build quando disponíveis; challenge respondido; findings red team e remediações; observabilidade da app verificada ou pendente; riscos residuais. Para release crítico, aprovações de produto/segurança e infraestrutura **fora do LLM**, em sistema confiável.

O utilitário `scripts/review_gate.py` analisa **consistência declarativa de relatório JSON**. Ele não autentica aprovação humana, não confirma que um teste rodou nem deve ser tratado como proteção de CI confiável por si só.

```bash
python3 .agents/skills/agentic-engineering-team/scripts/review_gate.py \
  .agents/skills/agentic-engineering-team/assets/review-gate.example.json
# Esperado: BLOCKED (é um exemplo deliberadamente reprovado).
```

Se integrar ao pipeline real, faça execução de testes e políticas de branch **em jobs protegidos** e associe evidências ao SHA do commit. O gate aceita `--expected-commit` (SHA vindo do CI), que verifica coerência declarativa do relatório com a versão avaliada, **não** autenticação ou resultados. Na CI do GitLab use, por exemplo, o valor confiável de `CI_COMMIT_SHA` e aprovação de MR/branch protegidos, sem confiar em variável fornecida pelo agente. Veja `assets/release-checklist.md`.

**Relatório final do Tech Lead (máximo ~1 página):** resultado `PASS/BLOCKED/FAIL`, mudança e paths, testes executados, decisão/alternativas do Challenger, findings Red Team, sinais de observabilidade da aplicação, tokens/custos medidos ou não medidos, riscos e autorização restante.

## 9. Testes do pacote

Depois da instalação, execute na raiz do repo:

```bash
python3 .agents/skills/agentic-engineering-team/scripts/validate_skill.py .
python3 -m unittest discover -s .agents/skills/agentic-engineering-team/scripts/tests -v
```

Para testar o instalador **antes de copiar**: no diretório extraído do pacote rode `python3 -m unittest discover -s tests -v`. Exige Python 3.11+ (biblioteca `tomllib`). O verificador valida estrutura, TOML e referências locais; não executa o Codex nem instala infraestrutura de produção.

## 10. Problemas comuns e limitações

| Sintoma | Verificação/ação |
|---|---|
| Skill não aparece | Verifique `.agents/skills/agentic-engineering-team/SKILL.md`, reabra Codex e tente `/skills` ou invocação explícita |
| Especialista não encontrado | Confira `.codex/agents/<name>.toml`, sessão na raiz certa e config `[agents]`; execute validador |
| Instalação abortou por conflito | Use `--dry-run --update`, revise diferenças e só depois `--update` com backup; **não** use `unzip -n` para atualizar |
| Contexto/tokens excessivos | Use um agente, paths e evidências compactas; inspecione rounds de review, loops e duplicação de contexto |
| “CI passou” sem prova | Solicite job/log/exit code vinculado ao commit; não aceite relatório autodeclarado |
| Red Team quer testar staging/prod | Exija ROE e autorização explícita. Sem isso, restrinja à análise estática e sandbox local |
| Telemetria não aparece | Distinguir instrumentação da app e exporter/Collector. Confirmar endpoints, contexto de trace, privacidade e ingestão. Marcar não verificado se faltar infraestrutura |
| Orçamento estourou | Pare novas delegações, registre custo real e replaneje; limite por prompt **não é limite duro** de cobrança |

## 11. Engineering Cockpit

O painel é o **cockpit do Engineering Owner**, não um segundo orquestrador nem monitoramento que a skill habilita sozinha. A especificação completa está em `.agents/skills/agentic-engineering-team/references/engineering-cockpit.md`, com scorecard inicial em `assets/cockpit-scorecard.md`.

Ele combina seis instrumentos com identidade de projeto/ambiente e evidências clicáveis: **rumo do produto, execução de agentes, combustível (tokens e custo), saúde operacional da aplicação, segurança e qualidade/CI**. No topo, mostrar **uma decisão prioritária**, aprovações pendentes e origem/idade de cada dado. Desconhecido/não configurado fica cinza, nunca verde.

**Fontes recomendadas:** GitLab (MR/CI por SHA), Codex OTel opt-in para execução e tokens quando disponíveis, billing/infra para custos monetários, OTel separado para a aplicação (métricas/logs/traces), relatórios de segurança verificados e ADRs. Integrar com Grafana em vez de reimplementar investigação de traces/APM. Nenhum desses conectores está implantado pelo ZIP.

**Implementação em fases:** 1) scorecard read-only + GitLab, 2) dados reais dos agentes e primeira aplicação, 3) decisões/segurança, 4) alertas e políticas verificadas. O Engineering Challenger questiona cada novo KPI: **qual decisão ele muda e quanto custa medi-lo?** Consulte o prompt F do Quick Start.

**Segurança do painel:** acesso autenticado, autorização por projeto, sem segredos/PII/prompts em logs, retenção limitada; operações de deploy e aprovação permanecem em sistemas externos autorizados.

### Fontes oficiais usadas no projeto

- [Codex — subagentes e definição de papéis](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex — referência de configuração](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OpenAI — práticas para skills e prompts](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)
- [OpenAI — ciclo de melhoria de skills](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex)
- [OpenTelemetry — documentação](https://opentelemetry.io/docs/)
- [OWASP — ASVS](https://asvs.owasp.org/) e [WSTG](https://owasp.org/www-project-web-security-testing-guide/)

**Escopo de validação desta versão:** arquivos/configs/scripts e testes locais. O funcionamento real de agentes e exportação de telemetria depende da sua instalação Codex e dos ambientes de aplicação/CI, não foi simulado como produção verificada.


## 12. Technical Ownership — não acumular débito de compreensão

O **12º especialista**, `technical_ownership_mentor`, ajuda o Engineering Owner a dominar o código enquanto a equipe trabalha. Não é um chatbot de aulas genéricas: cada **Ownership Card** parte de diff/commit, contrato, arquivo real e teste/log/trace observados. Foca em explicar o fluxo, prever efeitos, localizar uma falha e fazer pequena alteração com teste. Consulte `references/technical-ownership.md` e `assets/ownership-card.md`.

**Funcionamento prático:**

1. `quick`: sem mentor por padrão. `standard`: card após fatia relevante. `critical`: briefing antes de decisão importante ou release, e acompanhamento após a implementação.
2. Modos ajustáveis: `passive` (apenas mapa de mudanças), `guided` (card + um teste/questão) e `deep` (trace/debugging e alteração prática). Os modos são convenções da skill, **não uma opção já disponível na interface do Codex**.
3. Registre uma pendência real como `unreviewed`, `explained`, `practiced`, `verified`, `deferred` ou `stale` no *ownership ledger* por projeto/commit. Só marcar `verified` com evidência de ação ou confirmação explícita do usuário. Um agente não pode certificar por conta própria seu conhecimento.
4. Respeite seu ritmo: os demais agentes podem continuar tarefas independentes. Requerimentos críticos trazem briefing antes da aprovação humana, mas a camada de aprendizagem não é um bloqueio automático de CI ou deploy.
5. O futuro Cockpit exibirá **alterações que você ainda não revisou, fluxos críticos e caminho de diagnóstico**. A captura automática e UI **não existem neste pacote**; são requisitos de produto a implementar.

**Exemplo curto:** após implementar isolamento entre tenants, o mentor deve mostrar o fluxo real autenticação -> principal -> autorização -> query; o teste que tenta usar tenant de outra conta; onde depurar uma negação incorreta; e deixar uma pergunta prática sobre o ponto de enforcement. Sem adivinhar paths nem declarar teste aprovado sem rodá-lo.
