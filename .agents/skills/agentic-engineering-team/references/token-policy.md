# Context & Token Engineering — política operacional

Objetivo: minimizar **custo total por entrega verificada** e tempo, não tokens isoladamente. Mais raciocínio pode reduzir retrabalho. Mais subagentes podem multiplicar input/output sem melhorar o resultado.

## 1. Roteamento

- **quick**: um agente. Sem análise arquitetural formal, sem subagentes, a menos que haja incerteza relevante.
- **standard**: um executor e, se houver independência, um testador/revisor. Até 2 subagentes úteis, máximo configurado 3.
- **critical**: participação de arquitetura/segurança, Challenger + Red Team em ondas, mais executor e verificação. Não rode 11 papéis em paralelo: primeiro critique o plano e modele ameaças; após patch faça testes ofensivos controlados, depois revisão de correção.
- Abrir um subagente somente quando o ganho de foco/paralelismo ou independência de revisão superar overhead de spawn, contexto e integração.

## 2. Model routing e esforço

Recomendações, não garantias nem configuração rígida:

- **Low**: explorar caminhos, localizar definições, comparar arquivos, rotular achados.
- **Medium**: implementar feature bem especificada, testes determinísticos, refatoração moderada.
- **High**: decidir arquitetura com trade-offs, investigar falhas ambíguas, analisar authz/segurança crítica e incidentes.
- Antes de escolher modelo, verificar os disponíveis em `/model`; não fixar nomes de modelo na skill. Não degradar segurança só para economizar tokens.
- `default_subagent_reasoning_effort = "medium"` é um baseline; adaptar explicitamente para tarefas que mereçam Low/High. Recursos e sintaxe mudam conforme a versão.

## 3. Economia de contexto

- `rg -n 'padrão' src/`, `git diff --stat`, `git diff -- path`, `sed -n 'L1,L2p' arquivo` e logs filtrados antes de leituras amplas.
- Nunca passar árvore completa do repositório, `node_modules`, lockfiles longos, binários ou logs de build completos para o prompt.
- Se necessário arquivo grande, cite path + faixa de linhas ou trecho mínimo. Se arquivo for crítico, não economize omitindo requisito ou teste relevante.
- Reutilize uma especificação breve estável em `docs/tasks/<id>.md`; não reexplique a história toda em cada rodada.
- Skill `SKILL.md` é índice/procedimento curto; só consulte os references da fase corrente.

## 4. Handoff e compactação

- Ao fechar subetapa, devolva **resultado, evidência, files changed, riscos e next step**; não despeje raciocínio interno, logs enormes ou transcrição.
- Use `/compact` depois de um marco significativo quando o mesmo chat precisará continuar; preserve decisões, contratos, pendências e localização de artefatos.
- Para tarefa nova ou troca de contexto, prefira `/clear` + arquivo de handoff persistido; não dependa do resumo não verificável de outra sessão.
- Não compacte no meio de diagnóstico se evidências ainda estiverem em memória e não foram salvas em artefato.

## 5. Orçamentos e stop rules

Trate limites como **hipóteses a calibrar com medição**, não como valores precisos universais:

- `max_concurrent_threads_per_session = 3` como teto inicial, não meta. Challenger e Red Team normalmente trabalham em etapas distintas.
- Challenger: 1 challenge completo por decisão material + 1 reconsideração quando nova evidência surgir; até 3 riscos críticos para deliberação.
- Red Team: 3 hipóteses ofensivas de maior risco por rodada, com janela/limites definidos em ROE; fases adicionais seguem agenda/CI em vez de loop ilimitado.
- Invocações repetidas com o mesmo prompt sem nova evidência: pare após duas tentativas equivalentes e reformule hipótese.
- Se o mesmo agente pedir repetidamente contexto global, forneça paths/contratos ou reestruture a tarefa antes de continuar.
- Se revisor disser apenas "LGTM" sem evidência, não conte como verificação.
- Se PR/MR falhar duas vezes pela mesma causa, replaneje antes de gerar mais código.

## 6. Medição

Capture por task/tier: `input_tokens`, `output_tokens`, `cached_tokens` se disponíveis, `duration_sec`, `ci_pass_first_try`, `rework`, severidade de bugs pós-release. Distinga créditos da assinatura de tokens via API.

Indicadores:

- Tokens por tarefa **concluída e aprovada**, não por linha de código.
- Tempo até MR aprovado, aprovação de CI na primeira tentativa, defeitos/regressões pós-merge.
- `tokens_total = input_tokens + output_tokens` (somente os campos observados). `cached_tokens` pode já integrar tokens de entrada conforme fonte: não some novamente.
- Compare baseline single-agent vs multiagente em tarefas semelhantes, por pelo menos alguns exemplos representativos. Não afirme ganhos sem amostra.

Consulte também `references/metrics.md` e `references/agent-observability.md`. Custos operacionais de logs/traces da aplicação são **outro orçamento**: controle sampling, cardinalidade e retenção (`references/application-observability.md`).

## Mentor de propriedade técnica: custo proporcional

Não invocar `technical_ownership_mentor` a cada microedição. Gerar ownership card por alteração significativa ou solicitação do dono, com diff/contratos/testes selecionados. Extrair a mudança com Git primeiro; resumir localmente, usar subagente/modelo leve para cards, elevar esforço só para depuração difícil. Medir gasto observado do mentor separadamente. A aprendizagem só é comprovada por exercício/ação do usuário, não por tokens consumidos.
