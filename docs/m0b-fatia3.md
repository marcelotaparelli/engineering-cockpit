# M0b Fatia 3 — fluxo de execução pelo navegador

**Estado (2026-11-07):** implementado e verificado localmente (Debian, modo mock e testes). **Aceite no Arch: pendente** — exige você executar o roteiro abaixo com uma VM Codex real.

## O que funciona

Selecionar VM → abrir/retomar sessão → enviar prompt → streaming → histórico/estado → interromper → aprovar/rejeitar → refresh sem duplicar; mais um painel único de atenção para vários projetos.

| Peça | Arquivo | Garantia |
| --- | --- | --- |
| Rotas HTTP | `src/server.ts` | toda mutação exige sessão + prova + CSRF + nonce + `Origin` exato + JSON com chaves exatas |
| Execução | `src/execution.ts` | uma conexão App Server por VM; VM revalidada antes de cada envio; prompt enviado **no máximo uma vez**; envio não confirmado ou queda de transporte → `unknown`, nunca reenvio |
| Persistência | `src/runtime-store.ts` (schema v2) | approvals sem conteúdo com CAS; 1 execução ativa por projeto; migração v1→v2 aditiva; restart → `unknown`/approvals expiradas |
| Eventos | `src/event-hub.ts` + `GET /api/events` | SSE autenticado, heartbeat 15 s, retomada por `Last-Event-ID`; journal durável filtrado por projeto; deltas transitórios |
| Painel | `src/dashboard.ts` + `public/` | estado por agente (trabalhando, aguardando você, concluído, falhou, não confirmado), próximo passo, inbox única |
| Simulação | `src/fake-codex.ts` | só em modo mock/testes, rotulada "SIMULAÇÃO"; nada é executado |

API nova: `GET /api/dashboard`, `GET /api/events`, `GET /api/vms/:vm/threads`, `POST /api/sessions`, `GET /api/sessions/:id[/history]`, `POST /api/sessions/:id/runs` (`Idempotency-Key`), `POST /api/runs/:id/interrupt|reconcile`, `GET /api/approvals`, `POST /api/approvals/:id/decision`.

## Decisões técnicas tomadas

- **Adapter alinhado ao schema real.** O histórico esperava itens `message` e tokens no topo de `tokenUsage`; o schema (gerado do Codex CLI 0.166 local) usa `userMessage`/`agentMessage` e `tokenUsage.total`. Corrigido e coberto por teste. Ainda assim a forma exata no 0.164 do Arch só é confirmada no aceite.
- **`approvalPolicy: "on-request"`** em `thread/start` e `thread/resume`, para que ações sensíveis parem para aprovação. O sandbox continua o configurado na VM.
- **Tokens:** só o acumulado da sessão informado pelo Codex (`session_cumulative`); sem evento → "não medido". Duração = relógio do host.
- **Pedidos do servidor não suportados** (input do usuário, permissões, tool calls) aparecem como bloqueio; a saída é interromper. Nenhuma resposta automática.
- **Refresh sem duplicar:** a aba guarda o envio pendente (chave + texto) em `sessionStorage` até a confirmação; "Confirmar envio" reutiliza a mesma chave.

## Evidência local

- `./scripts/cockpit verify` → typecheck exit 0; **128 pass, 0 fail**.
- `tests/e2e-execution.test.ts`: HTTP real → `ExecutionService` → adapter real → App Server fake: fluxo completo, idempotência (`turnStarts == 1`), approval CAS/replay/conflito, rejeição, interrupt, `project_busy`, falha, queda de transporte → `unknown` → reconcile sem reenvio, VM parada → zero turns, isolamento entre projetos (inclusive SSE), logs sem conteúdo, restart.
- `tests/frontend.test.ts` (happy-dom): CSRF/chave no envio, render como texto, envio não confirmado sobrevivendo ao refresh com a mesma chave, aprovação com `expected_version`.
- Smoke do processo `src/index.ts` em modo mock: aprovação → concluído; logs sem o prompt.

## Aceite no Arch (roteiro)

```sh
export COCKPIT_LOCAL_TOKEN=$(openssl rand -hex 32); echo "$COCKPIT_LOCAL_TOKEN"   # digite no login
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes \
COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" \
COCKPIT_ALLOWED_PROJECTS=<seu-projeto> PORT=8787 \
./scripts/cockpit start
```

Abra `http://127.0.0.1:8787` e verifique:

1. Sua VM `codex-<projeto>` aparece como executável → clique.
2. "Nova sessão" (ou retome uma thread existente) → envie um prompt inócuo.
3. A resposta chega em streaming.
4. Recarregue a página: histórico e estado voltam; nada é reenviado.
5. Envie um prompt longo e clique "Interromper" → estado "Interrompido".
6. Peça algo que exija comando (ex.: "rode os testes") → item no "Precisa de você" → aprove ou rejeite.
7. Desligue a rede/feche o Cockpit no meio de uma execução → ao voltar, estado "Não confirmado" → "Reconciliar".

## Riscos residuais

Sessão local expira em 30 min sem renovação (login de novo); máximo de 256 mutações por sessão (nonces). A identidade da VM é por nome + estado (o MSB não expõe um ID imutável). O lock de projeto vale só para escritores do Cockpit; terminais externos continuam fora de controle. As credenciais do provider são compartilhadas entre projetos (`shared/codex-auth`). O processo do mesmo UID não fica isolado.
