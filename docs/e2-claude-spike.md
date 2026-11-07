# E2 — spike do Claude Code (CLI stream-json sobre `msb exec --stream`)

**Estado (2026-11-07):** spike implementado e testado só com um Claude **falso** (Debian). **Nada foi executado no Arch, nenhuma VM Claude foi tocada, nenhum prompt real foi enviado, nenhuma quota foi consumida.** O adaptador definitivo (E3) está em `docs/e3-claude-code.md`; o relatório real deste spike ainda não está no repositório.

## Decisão de arquitetura
`msb exec --stream <vm> -- claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode default --permission-prompts host [--session-id <uuid> | --resume <uuid>]`. Um processo longo por sessão, vários turnos pela mesma stdin, encerrado fechando a stdin. Reutiliza `MsbChild`/`minimalChildEnv`/`JsonlObjectParser` do transporte Codex. **Sem Agent SDK, daemon ou bridge.** Nunca `--dangerously-skip-permissions`/`bypassPermissions`: toda ferramenta passa por decisão humana.

## Arquivos
`src/claude-protocol.ts` (argv, codificadores, parser/classificador, sonda de capacidades), `src/claude-process.ts` (driver do processo: fila de eventos, stderr drenado e descartado, close→SIGKILL com relatório), `src/e2-claude-spike.ts` + `scripts/e2-claude-spike.ts` (runner de homologação), `src/fake-claude.ts`, `tests/claude-protocol.test.ts`, `tests/e2-claude-spike.test.ts`, subcomando `./scripts/cockpit e2-claude-spike`.

## Capacidades
| Capacidade | Situação |
| --- | --- |
| Versão (`claude --version` → `X.Y.Z (Claude Code)`), flags exigidas no `--help` (CLI local 2.1.319 expõe todas) | **Comprovado localmente** (só `--help`/`--version`); dentro da VM do Arch: pendente |
| Argv seguro, isolamento do alvo (`claude-cockpit-e2*`, nunca `claude-engineering-cockpit`), sem bypass de permissões | **Comprovado** (testes) |
| Ciclo do processo: multi-turno na mesma stdin, close→SIGKILL, sem processo órfão, stderr nunca exposto | **Comprovado com fake**; real: pendente |
| Classificação de erro/quota só por código estruturado (`api_error_status` 429/401/529…, `subtype`), nunca pelo texto | **Comprovado com fake**; nomes de campo reais: NÃO verificado (impossível forçar sem esgotar a quota) |
| Streaming (`stream_event`/`text_delta`), `session_id` no `init`, resultado (`result`) | Formato **assumido** do protocolo SDK; confirmar no Arch |
| Retomada explícita (`--resume`, contexto preservado, mesmo `session_id`) | Pendente no Arch |
| Interrupção (`control_request{interrupt}`, turno encerra, processo continua vivo) | Pendente no Arch |
| Aprovação (`control_request{can_use_tool}` → `control_response` allow/deny) | Formato assumido; pendente |
| AskUserQuestion (chega como `can_use_tool`; resposta = allow com `updatedInput.answers`) | Formato assumido; pendente (o modelo pode não chamar a ferramenta → INCONCLUSIVO) |
| Autenticação | O runner só lê `claude auth status --json` **na VM** e guarda `logged_in` + enum de método; e-mail/organização/tokens são descartados. Nenhuma credencial é copiada ou lida pelo Cockpit |

## Riscos de protocolo e autenticação
1. O `--help` local lista `--permission-prompts host`; o canal clássico `--permission-prompt-tool stdio` não aparece. O runner escolhe pelo que a VM expõe e reporta qual (`permission_prompt`).
2. Nomes de campos de `control_request`/`result` vêm do protocolo SDK conhecido, não de observação; divergência aparece como FAIL por turno, sem vazar conteúdo.
3. Com `--resume`, a CLI persiste a sessão em disco **na VM**; credenciais e sessões compartilhadas entre VMs (como `shared/codex-auth`) ampliam o raio de dano — a VM E2 deve ser exclusiva, logada à parte (`claude auth login` dentro dela, por você).
4. Interrupção de ferramenta em andamento e `--include-partial-messages` com *thinking* podem emitir tipos de evento novos: viram `other` (ignorados), nunca erro.
5. Sem verificação de versão mínima ainda: o E2 só registra a versão; a fixação (pin) é decisão do E3 após o resultado real.

## Homologação no Arch (consome quota: 6 prompts curtos)
Pré-requisitos (você): VM `claude-cockpit-e2-test` já **Running**, logada no Claude dentro dela. O runner não cria, inicia nem altera VM.
```sh
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes COCKPIT_E2_CONFIRMED=yes COCKPIT_E2_REAL_PROMPTS=yes COCKPIT_E2_VM=claude-cockpit-e2-test ./scripts/cockpit e2-claude-spike; echo "exit=$?"
```
Sem `COCKPIT_E2_REAL_PROMPTS=yes` roda só a parte somente-leitura (versão, flags, estado de login; sem quota). Saída: JSON com booleanos, contagens, tags e versão; nunca prompt, resposta, comando, caminho ou identidade. `exit 0` = tudo PASS; `1` = FAIL; `2` = não verificado/inconclusivo (ex.: o modelo não pediu aprovação/pergunta). Recusa sem tocar em nada se faltar consentimento, o host não for Arch, o alvo não for `claude-cockpit-e2*` ou for `claude-engineering-cockpit`.
