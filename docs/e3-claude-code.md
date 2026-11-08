# E3 — Claude Code como provider operacional do Cockpit

**Estado (2026-11-08, F0):** **aceito no Arch por atestado do operador**. Pelo navegador, com o Claude real, funcionaram:
- envio e resposta;
- aprovação e rejeição de Bash;
- AskUserQuestion;
- interrupção, com continuidade da sessão;
- retomada de contexto após reinício.

Registro e limites: [`docs/evidence/e3-browser-arch.md`](evidence/e3-browser-arch.md). Não há saída bruta nem resultado do passo (e). O streaming incremental não foi informado em separado.

O restante deste documento preserva a análise e o roteiro como foram escritos antes do aceite. Onde ele diz "INCONCLUSIVO" ou "não comprovado" sobre aprovação e AskUserQuestion, vale o atestado acima, mas só no nível funcional: os frames continuam sem registro.

*Estado anterior (mantido para auditoria):* implementado e testado com o Claude falso (Debian). O E2 real rodou no Arch (Claude Code 2.1.319). Aprovação e AskUserQuestion continuam **INCONCLUSIVAS**: a causa provável foi achada e corrigida, mas falta confirmar no Arch. **O aceite do E3 depende da homologação no Arch** (roteiro abaixo).

## Evidência E2 real (`docs/evidence/e2-claude-spike-arch.json`)
| Check | Arch | Leitura |
| --- | --- | --- |
| streaming_turn | PASS, `incremental=false`, `delta_count=1` | O prompt pedia só "OK", e uma resposta de 1 token gera 1 delta. **Streaming incremental não comprovado**: no teste de interrupção a interrupção saiu já no 1º delta. Vai ser verificado no passo (a). |
| multi_turn / process_exit / resume | PASS | Batem com o adapter: vários turnos por processo, fechamento pela stdin, `--resume` com o mesmo `session_id` e contexto. |
| interrupt | PASS, `ack=true`, `result_subtype=error_during_execution`, processo vivo | O adapter já mapeia esse `result` para `interrupted`, porque o Cockpit pediu a interrupção. |
| init.permissionMode | `default` | Bate com a checagem fail-closed do adapter. O `--help` 2.1.319 não lista `default` (lista `manual`, `auto`…), mas o CLI aceita e reporta `default`. |
| approval_reject | **INCONCLUSIVE** `no_permission_request_seen` | Turno de 3,4 s encerrado sem nenhum `can_use_tool`. Ver causa abaixo. |
| question_answer | **INCONCLUSIVE** `no_question_seen` | Mesmo mecanismo. |
| error_classification | NOT_VERIFIED | Não dá para forçar sem esgotar a quota. |

### Causa dos inconclusivos (achado demonstrável: **opções da CLI**, não prompt nem protocolo)
Fiz uma leitura estática, só de leitura, do binário `claude` 2.1.319 instalado neste Debian (mesma versão do Arch):
- Quem responde as permissões é decidido assim: `L2(permissionPromptTool, …, permissionPrompts)`. Só com `--permission-prompt-tool stdio` o CLI cria o `canUseTool` que manda `control_request {subtype:"can_use_tool", tool_name, input, tool_use_id}` ao host. Sem essa opção (o nosso argv tinha só `--permission-prompts host`), o handler é **local**: um pedido `ask` vira **deny automático**, emitido como `system/permission_denied` e somado em `result.permission_denials`. O host nunca vê nada.
- `--permission-prompt-tool` é uma opção **oculta** (`hideHelp()`). O E2 concluiu pelo `--help` que ela "não existe" e escolheu só `--permission-prompts host`. Essa flag apenas diz que os pedidos *não* são negados por política (`none`); ela não abre a rota stdio. O Agent SDK passa `--permission-prompt-tool=stdio`.
- O AskUserQuestion usa o mesmo canal `can_use_tool`, então foi afetado do mesmo jeito.
- O spike não registrava `tool_use`, `permission_denied` nem `permission_denials`. Por isso o relatório **não distingue** entre "o CLI negou sozinho" e "o modelo não chamou a ferramenta". As outras hipóteses (regra `permissions.allow` ou sandbox na VM liberando o Bash; modelo sem chamar a ferramenta) **não estão descartadas pela evidência**. Agora o Cockpit sinaliza as duas primeiras na tela.

**Situação:** aprovação e pergunta continuam **não comprovadas**. A correção vem da leitura do código do CLI, não de uma execução real.

### Correções (com testes de regressão)
- `claudeStreamArgv` passa a enviar `--permission-prompts host --permission-prompt-tool stdio`.
- O CLI falso agora reproduz o 2.1.319: **sem** a rota stdio, nega localmente e emite `system/permission_denied`. Os testes de aprovação e de pergunta só passam com a rota correta. Há também um teste que reproduz o argv do Arch e espera a negação automática.
- O parser lê `system/permission_denied` (ferramenta, id e tag do motivo; nunca a mensagem) e `result.permission_denials` (contagem).
- No adapter:
  - Ferramenta negada pelo próprio CLI: o item fica `declined` com `notice:"auto_denied"`.
  - Bash ou ferramenta de arquivo executada sem nenhum pedido ao Cockpit: `notice:"unapproved_execution"` (regra da VM).
  - Nos dois casos a UI mostra um aviso no item.
  - O deny do próprio operador não é confundido com negação automática.
- No spike do E2 (não executado de novo):
  - Responde com erro a pedidos de controle desconhecidos.
  - Registra `tool_use_seen`, `auto_denied` e `result_permission_denials`.
  - Negação local passa a ser `FAIL prompt_not_routed_to_host`, e não mais INCONCLUSIVE.

## Resultado dos testes
**236/236 testes passaram em ambiente simulado.** Eram 217 no commit `c1630c1`; foram somados 19 de regressão do roteamento de permissões e da preparação da homologação. O typecheck está limpo. A suíte rodou numa cópia do repositório com o pin de Bun ajustado à versão local. Isso **não** substitui a homologação: **o E3 ainda depende de homologação real no Arch.**

## Arquitetura (sem plataforma paralela)
Mesmo `ExecutionService`, `RuntimeStore` (sessões, runs, journal, idempotência, aprovações), `EventHub`/SSE, `LocalSecurity`, revalidação de discovery e UI do Codex. O `ExecutionService` passou a ter um **registro de adapters por provider** (`adapters: [codex, claude]`); nada no fluxo de envio/aprovação/recuperação foi duplicado.

`ClaudeCodeAdapter` (`src/claude-adapter.ts`): uma `ProviderConnection` por VM; dentro dela, **um processo `claude -p` stream-json por sessão aberta** (`msb exec --stream <vm> -- claude ... --permission-mode default --permission-prompts host --permission-prompt-tool stdio`), vários turnos pela mesma stdin (decisão do E2). Reutiliza `ClaudeStreamProcess`, `MsbChild`, `minimalChildEnv` (só `PATH/LANG/LC_ALL`).

### Capabilities (particularidades preservadas, sem imitar o Codex)
| Capability | Codex | Claude Code | Consequência |
| --- | --- | --- | --- |
| `sessionListing` | `provider` | `cockpit` | A UI só oferece sessões abertas pelo Cockpit (o canal não lista sessões). |
| `history` | `paged` | `cockpit` | Desde o E3.1, o Cockpit grava no SQLite o que observou e serve o histórico sem consultar o Claude (ver `docs/e31-historico.md`). |
| `usage` | `session_cumulative` | `run` | Tokens por execução (`token_scope='run'`). |
| `reconcile` | `provider` | `process` | Só o processo vivo confirma um run; após queda/restart o run fica `unknown` (nunca reenviado). |
| `questions` | `false` | `true` | `AskUserQuestion` vira um registro na **mesma tabela de aprovações** (`action_type='question'`). |

### Contrato comum (mudanças)
- `ProviderCapabilities` + `questions`, `sessionListing`, `history:"cockpit"` (era `session_memory` até o E3.1), `reconcile`; `ProviderAdapter.capabilities` e `acceptsTarget()`.
- `ApprovalSummary.actionType`: `command | file_change | tool | question`, com `toolName`, `detail` (entrada exata, limitada a 8 KiB, `truncated` avisado na UI), `files`, `questions`.
- `decideApproval(ref, { decision, answers? })`; evento `session.lost` (processo do provider morreu → run em andamento vira `unknown`).
- `resumeSession(ref, { hasRuns })`: sessão que nunca teve turno é reaberta com `--session-id` (não há transcript para `--resume`).
- `RuntimeStore` schema **v3**: reconstrução transacional de `approvals` (novos `action_type`) e `run_metrics` (`token_scope='run'`), linhas preservadas; só migra de v2 exato (v1→v2→v3 encadeado).

## Invariantes e como são garantidas
| Invariante | Mecanismo | Teste |
| --- | --- | --- |
| Prompt no máximo uma vez | `startRun` escreve uma vez; idempotency key do `RuntimeStore`; falha de escrita → `unknown` | `e3…`: retry com mesma chave; `prompts` do fake = 1 |
| `unknown` nunca reenvia | Reconcile do Claude só lê memória do processo; nenhuma rota reenvia | `e3…`: crash → `unknown` → reconcile `unknown` → mesma chave devolve o mesmo run |
| Recusas antes de escrever não viram dúvida | Códigos `NOT_SENT` (sessão não carregada etc.) → `failed` | `e3…`: "adapter refusal raised before writing" |
| Sem aprovação automática | Toda ferramenta passa por `can_use_tool` → humano; pedido fora de turno → **deny**; acima de 8 pendentes → deny; `control_request` desconhecido → resposta **error** | `claude-adapter`: stray, hook, limites |
| Aprovar = exatamente o que foi exibido | `allow` ecoa o `input` original guardado no adapter; nunca editado | `allowedInputs` iguais ao pedido |
| Perguntas/aprovações no run certo | ref `(sessionId, turnId, requestId)` validada no adapter; `ExecutionService` só aceita evento do turno ativo | refs trocadas → `provider_approval_invalid` |
| Respostas validadas antes de mudar estado | chaves = perguntas pendentes, valores 1..2000, só propriedades próprias | `e3…`: respostas erradas/`__proto__` → 400, aprovação segue `pending` |
| Sem bypass | argv fixo `--permission-mode default`; `init` com outro `permissionMode` derruba a sessão | argv sem `dangerously/bypass/acceptEdits`; teste `bypassPermissions` |
| Credenciais ficam na VM | Nada é copiado; ambiente mínimo; `auth status --json` só gera um booleano (e-mail/org descartados) | identidade ausente da saída |
| Projeto/VM validados | `revalidate` antes de sessão/envio/histórico/reconcile; VM `claude-engineering-cockpit` recusada (`acceptsTarget`) | `e3…`: VM parada, VM reservada, projeto sem grant |
| Encerramento controlado | stdin fechada → 3 s → SIGKILL, por sessão; `close()` do Cockpit fecha todas | fake `ended`/`closedByStdin` |
| Limites explícitos | 4 processos/VM (reaproveita só ociosos), ocioso 20 min, turno 2 h (interrupt → 30 s → kill), fila de eventos 20 000, transcript 500 itens × 64 sessões, frame 4 MiB | testes de limite/ociosidade/tempo |

## Comprovado × simulado
| Comportamento | Situação |
| --- | --- |
| Fluxo completo pelo navegador/HTTP (sessão, envio, streaming, ferramentas, aprovação, pergunta, interrupção, limite de uso, queda, retomada) | **Comprovado com Claude falso** (testes + smoke do `index.ts` em modo mock) |
| `init` (session_id, `permissionMode=default`), `result` ok, vários turnos, interrupção (`control_response` ok, `error_during_execution`, processo vivo), encerramento pela stdin, `--resume` com contexto | **Comprovados no Arch** (E2, 2.1.319) |
| Forma de `can_use_tool` (`tool_name`, `input`, `tool_use_id`), `system/permission_denied`, `result.permission_denials` | Conferidos por **leitura estática** do CLI 2.1.319; não observados no Arch |
| Pedido de aprovação e AskUserQuestion chegando ao host; resposta allow/deny/`answers`; streaming incremental; `thinking_delta`; `api_error_status` | **Não comprovados** (INCONCLUSIVOS ou não exercitados) |
| Classificação real de quota/autenticação | Não forçável sem esgotar quota; só estrutural (nunca por texto) |

## Limitações reais do protocolo (CLI stream-json)
1. Não lista sessões nem lê transcript. Desde o E3.1 o Cockpit persiste o que observa; turnos feitos fora do Cockpit, ou antes do E3.1, continuam só na VM.
2. Não há id de turno: o Cockpit cria um por envio e serializa turnos por processo.
3. Não há estado de turno consultável: após restart do Cockpit ou queda do processo, o run fica `unknown` para sempre (o operador confere na VM). O processo filho morre com o Cockpit; o turno pode ter terminado na VM sem o Cockpit saber.
4. Interrupção vira um `result` comum: o Cockpit marca `interrupted` porque pediu a interrupção.
5. `--resume` de sessão inexistente faz o processo sair; se isso ocorrer depois da escrita, o run fica `unknown` (conservador).
6. Pedidos de controle desconhecidos (hooks, MCP) são respondidos com erro: recursos que dependam deles não funcionam pelo Cockpit.

## Roteiro de homologação no Arch (operador)
O E2 **não** é repetido. Pré-requisitos:
- A VM `claude-cockpit-e2-test` está Running e logada (por você, dentro dela).
- O diretório `$HOME/sandboxes/agent/projects/cockpit-e2-test` existe.
- O commit com esta correção está no checkout do Arch.

Nada abaixo cria, inicia ou altera VM, e nada mexe no Cockpit em execução (E0: porta 8787, ACL `cockpit-e0-test`, `data/`).

1. **Preparar (um comando).** Faz o preflight só de leitura, sem prompt: consentimento, host Arch, VM exclusiva `claude-cockpit-e2*`, ACL explícita, diretório do projeto, VM Running, `claude --version`/`--help`/`auth status`, porta livre e diretório de dados. Só se tudo passar, sobe **outra** instância:
   - porta 8788;
   - `data/e3-homologation/`;
   - ACL = `cockpit-e2-test`;
   - token novo, mostrado uma vez no terminal.

   Uma `COCKPIT_ALLOWED_PROJECTS` diferente no ambiente é **recusada**, não sobrescrita. O token do E0 nunca é reaproveitado.
   ```sh
   COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes COCKPIT_E3_CONFIRMED=yes COCKPIT_E3_VM=claude-cockpit-e2-test COCKPIT_ALLOWED_PROJECTS=cockpit-e2-test COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" ./scripts/cockpit e3-homologation
   ```
   A 1ª linha do stdout é o JSON do preflight, que não traz segredos. Exit 1/2 = não subiu nada; traga o JSON.
2. **No navegador** (`http://127.0.0.1:8788`, login com o token impresso), na VM `claude-cockpit-e2-test`:
   - (a) Nova sessão e um prompt que peça um parágrafo. Esperado: o texto aparece aos poucos (**streaming incremental**) e termina em "Concluído", com tokens "desta execução".
   - (b) Prompt que peça `Bash` (`touch /tmp/e3-probe`). Esperado: card com o comando e a entrada completa → **Rejeitar**.
     - Se aparecer o aviso "Negado automaticamente", a rota stdio não funcionou.
     - Se aparecer "Executado sem aprovação", existe regra de permissão na VM.
     - Nos dois casos é FAIL; anote qual aviso apareceu.
   - (c) Prompt que peça `AskUserQuestion`. Esperado: card de pergunta → responder.
   - (d) Prompt longo → **Interromper**. Esperado: "Interrompido", e o próximo prompt funciona.
   - (e) Ctrl+C na instância durante um prompt, depois o mesmo comando do passo 1. Esperado: run "Não confirmado" e nada reenviado.
   - (f) Novo prompt na mesma sessão depois de (e). Esperado: retoma com contexto (`--resume`).
3. Registre em `docs/evidence/e3-browser-arch.md` só os estados observados (PASS/FAIL por passo e qual aviso apareceu), sem conteúdo de prompt ou resposta. Ctrl+C encerra só a instância E3.

## Pendências para o aceite E3
*Atualização F0 (2026-11-08):* as pendências 2a (envio e resposta), 2b, 2c, 2d e 2f foram atendidas por **atestado do operador** ([registro](evidence/e3-browser-arch.md)). Continuam em aberto:
- o streaming *incremental*;
- o passo 2e;
- a versão mínima testada;
- `ERROR_CLASS` real.

A lista original segue abaixo, sem alteração.

- Aprovação e AskUserQuestion **comprovadas no Arch** (passos 2b/2c). Até lá continuam INCONCLUSIVAS. A correção da rota stdio vem só de leitura estática do CLI.
- Streaming incremental comprovado (2a). Recuperação e retomada pelo navegador (2e/2f).
- Fixar versão mínima/testada do Claude Code após o passo 1 (hoje: major ≥ 2 + flags exigidas presentes).
- Revisar `ERROR_CLASS` com um erro real de quota/autenticação quando ocorrer naturalmente.
- Bun local desta VM é 1.4.3 (pin 1.4.4, mantido): no repositório real 29 testes falham só por `bun_version_mismatch` (conjunto idêntico ao baseline).
