# E3 — Claude Code como provider operacional do Cockpit

**Estado (2026-11-07):** implementado e testado **só com o Claude falso** (Debian). Nenhum prompt real, nenhuma VM, credencial ou processo do Arch foi tocado. **Aceite E3 pendente da homologação no Arch** (roteiro abaixo).

**Evidência E2:** o operador relatou "E2 PASS no Arch", mas **não há relatório no repositório** (`docs/evidence/` só tem UI). Os formatos reais do stream-json continuam **não comprovados** aqui; o passo 1 do roteiro recupera essa evidência sem gastar mais do que os 6 prompts do E2.

## Resultado dos testes
**217/217 testes passaram em ambiente simulado** (Claude e Codex falsos; typecheck limpo), executados numa cópia do repositório com o pin de Bun ajustado à versão local. Isso **não** substitui a homologação: **o E3 ainda depende de homologação real no Arch** (roteiro abaixo).

## Arquitetura (sem plataforma paralela)
Mesmo `ExecutionService`, `RuntimeStore` (sessões, runs, journal, idempotência, aprovações), `EventHub`/SSE, `LocalSecurity`, revalidação de discovery e UI do Codex. O `ExecutionService` passou a ter um **registro de adapters por provider** (`adapters: [codex, claude]`); nada no fluxo de envio/aprovação/recuperação foi duplicado.

`ClaudeCodeAdapter` (`src/claude-adapter.ts`): uma `ProviderConnection` por VM; dentro dela, **um processo `claude -p` stream-json por sessão aberta** (`msb exec --stream <vm> -- claude ... --permission-mode default --permission-prompts host`), vários turnos pela mesma stdin (decisão do E2). Reutiliza `ClaudeStreamProcess`, `MsbChild`, `minimalChildEnv` (só `PATH/LANG/LC_ALL`).

### Capabilities (particularidades preservadas, sem imitar o Codex)
| Capability | Codex | Claude Code | Consequência |
| --- | --- | --- | --- |
| `sessionListing` | `provider` | `cockpit` | A UI só oferece sessões abertas pelo Cockpit (o canal não lista sessões). |
| `history` | `paged` | `session_memory` | Histórico = o que este processo do Cockpit observou (limitado, só memória, nunca persistido). A UI avisa "Histórico parcial". |
| `usage` | `session_cumulative` | `run` | Tokens por execução (`token_scope='run'`). |
| `reconcile` | `provider` | `process` | Só o processo vivo confirma um run; após queda/restart o run fica `unknown` (nunca reenviado). |
| `questions` | `false` | `true` | `AskUserQuestion` vira um registro na **mesma tabela de aprovações** (`action_type='question'`). |

### Contrato comum (mudanças)
- `ProviderCapabilities` + `questions`, `sessionListing`, `history:"session_memory"`, `reconcile`; `ProviderAdapter.capabilities` e `acceptsTarget()`.
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
| Formatos reais: `init.permissionMode`, `message_start.message.id`, `thinking_delta`, `tool_use_id` em `can_use_tool`, `tool_result`, `control_response` allow/deny, `answers` do AskUserQuestion, `api_error_status` | **Não verificados** — assumidos do protocolo SDK (mesmas suposições do E2) |
| Interrupção com processo vivo; `--resume` com contexto | Não verificados no Arch (dependem do relatório E2) |
| Classificação real de quota/autenticação | Não forçável sem esgotar quota; só estrutural (nunca por texto) |

## Limitações reais do protocolo (CLI stream-json)
1. Não lista sessões nem lê transcript: histórico anterior ao processo atual do Cockpit não aparece (fica na VM).
2. Não há id de turno: o Cockpit cria um por envio e serializa turnos por processo.
3. Não há estado de turno consultável: após restart do Cockpit ou queda do processo, o run fica `unknown` para sempre (o operador confere na VM). O processo filho morre com o Cockpit; o turno pode ter terminado na VM sem o Cockpit saber.
4. Interrupção vira um `result` comum: o Cockpit marca `interrupted` porque pediu a interrupção.
5. `--resume` de sessão inexistente faz o processo sair; se isso ocorrer depois da escrita, o run fica `unknown` (conservador).
6. Pedidos de controle desconhecidos (hooks, MCP) são respondidos com erro: recursos que dependam deles não funcionam pelo Cockpit.

## Roteiro de homologação no Arch (operador)
Pré-requisitos: VM `claude-cockpit-e2-test` Running e logada (por você, dentro dela). Nada abaixo cria, inicia ou altera VM.

1. **Evidência E2 (6 prompts curtos)**: grava o relatório que falta no repositório; ele valida os formatos dos quais o adapter depende (`permission_mode`, streaming, interrupt, deny, AskUserQuestion, resume):
   ```sh
   COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes COCKPIT_E2_CONFIRMED=yes COCKPIT_E2_REAL_PROMPTS=yes COCKPIT_E2_VM=claude-cockpit-e2-test ./scripts/cockpit e2-claude-spike > docs/evidence/e2-claude-spike-arch.json; echo "exit=$?"
   ```
   `exit=0` é o pré-requisito para o passo 2. Com FAIL/INCONCLUSIVE, pare e traga o JSON (não contém conteúdo nem identidade).
2. **E3 pelo navegador** (`./scripts/cockpit start` em modo host, com o projeto `cockpit-e2-test` no grant): na VM `claude-cockpit-e2-test`, (a) nova sessão + prompt curto → streaming e "Concluído" com tokens "desta execução"; (b) prompt que peça `Bash` (`touch /tmp/e3-probe`) → card com comando e entrada completa → **Rejeitar**; (c) prompt que peça `AskUserQuestion` → responder no card; (d) prompt longo → **Interromper** → "Interrompido" e próximo prompt funciona; (e) `./scripts/cockpit` reiniciado durante um prompt → run "Não confirmado", nada reenviado; (f) mesma sessão após 20 min ou após (e) → novo prompt retoma (`--resume`) com contexto.
3. Registrar em `docs/evidence/` os estados observados (sem conteúdo de prompt/resposta).

## Pendências para o aceite E3
- Relatório E2 real no repositório (passo 1) e roteiro E3 (passo 2) executados no Arch.
- Fixar versão mínima/testada do Claude Code após o passo 1 (hoje: major ≥ 2 + flags exigidas presentes).
- Revisar `ERROR_CLASS` com um erro real de quota/autenticação quando ocorrer naturalmente.
- Bun local desta VM é 1.4.3 (pin 1.4.4, mantido): no repositório real 29 testes falham só por `bun_version_mismatch` (conjunto idêntico ao baseline).
