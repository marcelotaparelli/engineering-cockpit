# Engineering Cockpit — Master plan v2.0

**Data:** 2026-11-08 · **Autor:** Tech Lead (revisão independente) · **Substitui:** o roteiro implícito M0→M3 de [`engineering-cockpit-M0-kickoff.md`](../engineering-cockpit-M0-kickoff.md) (preservado, sem alteração, como registro de auditoria) e a numeração E0–E4 adotada durante a implementação.
**Fonte única de verdade** a partir desta versão. Mudanças neste documento exigem commit próprio com justificativa.

## 1. Visão e proposta de valor

O Engineering Cockpit é a **camada de operação e supervisão** dos agentes de engenharia (Codex, Claude Code e, se houver demanda, OpenCode) que rodam em micro-VMs Microsandbox no host Arch do operador. Ele substitui o terminal no dia a dia: ver quem trabalha, enviar objetivos, acompanhar, aprovar, responder, interromper, recuperar o controle após quedas, tudo de um navegador local, para vários projetos.

**Não é** o Forge (plataforma autônoma de engenharia), **não é** um painel de SDLC (CI, SAST, SLO, custo faturado) e **não** orquestra agentes entre si. A especificação de "seis instrumentos" da skill (`.agents/skills/agentic-engineering-team/references/engineering-cockpit.md`) descreve um painel do Engineering Owner alimentado por GitLab, OTel e billing: isso pertence ao Forge ou a um produto separado, e fica **fora** deste plano.

## 2. Escopo e limites

| Dentro | Fora (por desenho) |
| --- | --- |
| Descoberta read-only de VMs/projetos (`msb list`) | Criar, parar, recriar, apagar VMs (launchers do operador) |
| Sessões, runs idempotentes, streaming, histórico, interrupção | Login dos providers dentro da VM (operador) |
| Aprovações e perguntas decididas por humano autenticado | Autoaprovação, políticas permissivas, `bypassPermissions` |
| Recuperação conservadora: `unknown` nunca vira sucesso/falha sem evidência | Reenvio automático de prompt ou aprovação |
| Um operador local, loopback, um writer por projeto | Multiusuário, LAN/proxy/túnel, RBAC |
| Tokens observados por run/sessão | Custo faturado, OTel, Grafana, GitLab, findings |

## 3. Arquitetura atual (= arquitetura-alvo da V1)

```
Navegador (127.0.0.1)  ── HTTP JSON + SSE, cookie HttpOnly + prova em header, CSRF + nonce ──┐
                                                                                              ▼
Bun 1.4.4 / TS strict ── src/server.ts (rotas fixas, allowlist, authz por projeto)
                         ├─ src/dashboard.ts        visão "o que trabalha / terminou / precisa de você"
                         ├─ src/execution.ts        máquina de estados, idempotência, aprovações, parciais, perdas
                         ├─ src/runtime-store.ts    SQLite v5 (sessions, runs, journal, approvals, transcript, child_processes)
                         ├─ src/process-ledger.ts   filhos msb × /proc: órfãos bloqueiam envio
                         ├─ src/provider.ts         contrato neutro (capabilities declaradas, união fechada de eventos)
                         │    ├─ codex-adapter.ts   App Server JSONL via msb exec --stream (1 conexão por VM)
                         │    └─ claude-adapter.ts  claude -p stream-json via msb exec --stream (1 processo por sessão)
                         └─ src/msb-transport.ts    argv fixo, sem shell, env mínimo, limites, SIGKILL só do filho
                                                                                              │
                                                     msb exec --stream <vm> -- <codex|claude> ─┘ (credenciais ficam na VM)
```

A arquitetura **sustenta a V1 sem reescrita**. O contrato de provider foi provado com dois providers reais de semântica diferente (listagem/histórico/reconcile distintos) sem vazar tipos para o domínio. Dependências de runtime: zero (só `typescript` e `happy-dom` em dev).

Pontos de atenção (não bloqueiam): `ExecutionService` concentra 725 linhas de estado; ~1 350 linhas de `src/` são runners de homologação (E0, E2, E3, E4, smoke, diagnose) que merecem ir para `tools/` quando houver folga; sem reaper de conexões Codex ociosas.

## 4. Decisões técnicas fundamentais (registro)

| # | Decisão | Origem | Estado |
| --- | --- | --- | --- |
| D1 | App Server Codex por stdio em `msb exec`, sem porta/bridge | ADR-0001 | vigente |
| D2 | Autenticação local por credencial + cookie + prova + CSRF; grants por projeto | ADR-0002 | vigente |
| D3 | `unknown` é terminal até evidência do provider; nada é reenviado | kickoff, M0b plan | vigente, comprovado (E0-D7 real, E4 drill) |
| D4 | Um writer por projeto (lock cooperativo) | kickoff | vigente |
| D5 | Claude via CLI stream-json, sem Agent SDK; `--permission-mode default` + rota stdio | E2/E3 | vigente; forma de `can_use_tool` confirmada só por leitura estática + atestado do operador |
| D6 | **Desvio do kickoff:** prompts e respostas do Claude são persistidos (sanitizados, limitados, 0600) porque o canal não lê transcript | E3.1 | tomada na implementação; **ratificar** neste plano (aceita) |
| D7 | Versões do Codex App Server fixadas (fail-closed) | E0 | vigente; exige runbook de upgrade |
| D8 | VM `claude-engineering-cockpit` recusada no código | E2 | **REQUER DECISÃO** → tornar configuração (`COCKPIT_RESERVED_VMS`) |
| D9 | Identidade visual v1.1 (recortes da prancha aprovada, CSP `img-src 'self'`) | brand book | aprovada, integração GO |

## 5. Estado real dos marcos

Legenda: **H** = comprovado no Arch com provider real; **T** = só testes/simulação; **A** = atestado do operador sem registro estruturado no repositório.

| Marco | Conteúdo | Estado | Evidência |
| --- | --- | --- | --- |
| M0a/M0a.2 | discovery read-only | H/A | `docs/m0a2.md` (atestado) |
| M0b.1a/1b | transporte, runtime, segurança HTTP | H (smoke) | `docs/m0b1a-arch-smoke.md` |
| Fatia 3/4 | API, SSE, UI de 3 áreas | H via E0 | `docs/e0-homologacao.md` |
| E0 | Codex real, D1–D7 | **H** | `docs/e0-homologacao.md` §Resultado real; `e0-recovery-test` |
| E1 | agentes bloqueados | **T** | `request.unsupported` real nunca observado |
| E2 | spike Claude | H parcial | `docs/evidence/e2-claude-spike-arch.json`: 12 PASS, 2 INCONCLUSIVE (pré-correção) |
| E3 | Claude como provider | **A** | `docs/evidence/e3-browser-arch.md` (F0): atestado sem resultado do passo (e) nem streaming incremental |
| E3.1 | histórico persistente | A | `docs/evidence/e31-historico-arch.md` (só o resultado global) |
| E4 | confiabilidade | H (Cockpit) / T (providers) | `docs/evidence/e4-arch.md` (F0): 278 testes + drill 11/11 no Arch **atestados**; queda com Claude real não homologada |
| UI v1.1 | identidade | aprovada | `docs/evidence/ui-brand-v1.1-2026-11-08/` (no `develop` desde a F0) |

Integração E4 + UI: branch `integration/e4-ui-v1.1` (`a11a1d9`), sem conflitos, 283/283, drill PASS, 46/46 checks visuais. **Mesclada** no `develop` por fast-forward na F0. A reexecução na F0 teve o mesmo resultado (`docs/evidence/e4-arch.md`).

## 6. Lacunas e riscos (ordenados por impacto)

| # | Lacuna | Evidência | Impacto | Tratamento |
| --- | --- | --- | --- | --- |
| L1 | Aceites E3 e E4 no Arch sem registro no repositório | ausência em `docs/evidence/`; README contradiz `e3-claude-code.md` | a única prova de aprovação/AskUserQuestion reais é oral | **F0: registrada como atestado**; a prova estruturada com provider real vem na F2 |
| L2 | Sessão HTTP expira em 30 min absolutos, sem renovação; nova aba exige login | `src/local-security.ts:5,55`; UI só reage a 401 | inviabiliza uso diário | F1 |
| L3 | Sem empacotamento como serviço (systemd), token em variável de shell, grants fixos no start | README; `src/config.ts` | Cockpit depende de um terminal aberto | F1 |
| L4 | Run Codex reconciliado como `running` preso a um app-server órfão: sem eventos, sem interrupção, projeto travado até o órfão terminar | `src/execution.ts:287-299`; E4 §10 | beco sem saída operacional | F2 (decisão D10) |
| L5 | Stream ao vivo perde os primeiros caracteres quando o histórico recarrega durante deltas | reproduzido no `develop`; `public/app.js:722` (era `:692` antes da UI v1.1) | ruído visual, desconfiança | F1 |
| L6 | VM reservada hardcoded e `offline: VM parada` para VMs ligadas sem provider suportado (`opencode-*`, VM reservada) | `src/claude-protocol.ts:14`; `src/dashboard.ts:69` | texto enganoso; Cockpit não opera a própria VM de dev | F1 (D8) |
| L7 | Sem CI | sem `.github/`; `verify` manual | regressão só é vista por quem lembra de rodar | F3 |
| L8 | Queda abrupta com Claude real nunca exercitada; formas `UNVERIFIED` no código | `src/claude-protocol.ts:85,93,127` | risco residual de recuperação | F2 |
| L9 | Pin de versão Codex sem runbook de upgrade | `codex-adapter.ts:24` | parada após update do CLI | **F0: `docs/runbook.md`** |
| L10 | `unknown` some da inbox quando chega run novo; sem "ciente" | E4 §10 | perda de visibilidade | F4 |

## 7. Roadmap priorizado (V1 = Cockpit operacional diário)

| Fase | Prioridade | Objetivo | Resultado observável | Esforço* | Depende de |
| --- | --- | --- | --- | --- | --- |
| **F0 Fechar o ciclo** | P0 | integrar E4+UI, registrar aceites, runbook de upgrade Codex | `develop` = integração; `docs/evidence/e3-browser-arch.md`, `e4-arch.md`; README coerente | 0,5 d | — |
| **F1 Operar todo dia** | P0 | remover atritos L2, L3, L5, L6 | serviço systemd de usuário com token em arquivo 0600; sessão deslizante (ociosa 30 min, máx. 12 h) sem perder segurança; stream sem perda; VMs reservadas por config | 2–3 d | F0 |
| **F3 CI** | P1 | typecheck + suíte + `artifact --check` a cada push | workflow verde no commit de F1 | 0,5 d | F0 (paralelo a F1) |
| **F2 Prova com provider real** | P1 | L4, L8: uma queda com Claude real; decisão para run preso a órfão Codex | drill manual registrado; `reconcile` recusa reatar quando o ledger mostra órfão Codex na VM (`orphan_owns_turn`), mantendo `unknown` | 1–2 d + 30 min do operador | F1 |
| **F4 Visão operacional** | P1 | mostrar o que já existe: `reliability`, tokens por projeto/dia, "ciente" em `unknown` | tiles no painel; inbox não perde `unknown` | 2 d | F1 |
| F5 OpenCode | P2 | terceiro provider | — | 4–6 d | **REQUER DECISÃO**: só se usado |
| F6 Objetivos longos / execução supervisionada | P2 | kickoff M2 | — | a definir após 2 semanas de uso da V1 | V1 |
| DESCARTAR | — | painel de 6 instrumentos (GitLab/OTel/billing), demo "Mission Control", handoff entre providers, multiusuário, acesso remoto | — | — | pertence ao Forge ou não agrega |

\* Premissas: Claude Code como executor, revisão por Codex só onde indicado, operador disponível para 1 homologação por fase.

### Detalhe das fases P0/P1

**F0.** Arquivos: `docs/evidence/*`, `README.md`, `docs/e3-claude-code.md`, `docs/runbook.md` (novo, curto). Aceite: `git merge --ff-only integration/e4-ui-v1.1` aplicado; `./scripts/cockpit verify` 283 pass; `artifact --check` PASS; registros só com o que o operador atestou (sem inventar passo a passo). Risco: nenhum técnico.

**F1.** Arquivos: `src/local-security.ts` (expiração deslizante: `touch` em cada autenticação, teto absoluto), `src/server.ts` (nenhuma rota nova), `public/app.js` (corrida stream/histórico; indicador de sessão), `src/dashboard.ts` + `public/app.js` (estado `unsupported` em vez de `offline`), `src/config.ts` + `src/claude-protocol.ts` (`COCKPIT_RESERVED_VMS`), `scripts/cockpit service-install` + `tools/systemd/cockpit.service` (usuário, `EnvironmentFile` 0600 ou `LoadCredential`). Testes: `local-security`, `server`, `frontend`, novo teste de unit file gerado. Aceite no Arch: um dia inteiro de uso real sem terminal (exceto iniciar VM), `reliability` sem contadores inesperados, capturas. Riscos: segredo em `EnvironmentFile` (0600, diretório do usuário); mudança de política de sessão deve passar por revisão independente (Codex).

**F2.** Arquivos: `src/execution.ts` (`reconcile`: se `processes.blocking(vm, …)` indica `codex_app_server` órfão na VM → `unconfirmed`/`orphan_owns_turn`, sem reatar), `tests/e4-recovery.test.ts`, `docs/e4-confiabilidade.md`. Drill manual: prompt longo real no Claude, `kill -9` do Cockpit, restart; esperado: parcial preservada, órfão listado, envio bloqueado, `kill <pid>` libera. Registrar em `docs/evidence/e4-claude-real-arch.md`.

**F3.** `.github/workflows/verify.yml`: `oven-sh/setup-bun@v2` com `bun-version-file: .bun-version`, `bun install --frozen-lockfile --ignore-scripts`, `bun run typecheck`, `bun test`, `bun scripts/artifact.ts --check`. Runner Linux (os testes de `/proc` e processos reais passam). Visual check fica fora (Chromium opcional).

**F4.** `public/app.js` + `style.css` (tiles com os contadores de `reliability` já servidos; totais de tokens por projeto a partir de `run_metrics`), `src/runtime-store.ts` (coluna aditiva `acknowledged_at` em `runs`, schema v6 aditivo), `src/server.ts` (`POST /api/runs/:id/acknowledge`, mesma segurança das demais mutações). Não cria métrica nova: só exibe o que existe.

## 8. Critérios de aceite da V1

1. O operador usa o Cockpit um dia inteiro, com Codex e Claude em ≥ 2 projetos, sem abrir terminal exceto para iniciar VMs e fazer login do provider na VM.
2. Nenhum prompt duplicado, nenhuma aprovação automática, nenhum `unknown` resolvido sem evidência (contadores `reliability` e journal conferidos).
3. Queda do Cockpit (ordenada e `kill -9`) com Claude real e com Codex real: histórico preservado, órfãos visíveis e bloqueando, recuperação sem reenvio.
4. Sessão HTTP não exige novo login durante uso ativo; nova aba reaproveita a sessão.
5. CI verde no commit da release; `artifact.sha256` confere.
6. Aceites E0–E4 e V1 registrados em `docs/evidence/` com data, commit e o que foi atestado versus executado.

## 9. Plano de testes e homologação

- **Determinístico (CI):** 283 testes atuais + os de F1/F2/F4; HTTP real contra fakes de Codex/Claude; processos reais para posse do banco e órfãos.
- **Visual (local):** `scripts/visual-check.ts` e `scripts/brand-visual-check.ts` a cada mudança de UI.
- **Arch (operador), por fase:** F0 nenhum; F1 um dia de uso; F2 um drill com quota mínima (1–2 prompts); F4 nenhum.
- Regra: nada é "homologado" sem registro em `docs/evidence/` dizendo se foi executado automaticamente, observado no navegador ou atestado.

## 10. Integração e release

- Trabalho sempre em branch + worktree isolado a partir do `develop`; merge `--ff-only` ou `--no-ff` local pelo operador; push só com autorização explícita.
- Release V1: tag `v1.0.0` no `develop` após os critérios da §8; `main` recebe `develop` por fast-forward.
- Nenhum deploy automático; o serviço systemd é instalado pelo operador com o comando de F1.

## 11. Operação e recuperação (runbook mínimo, a consolidar em F0)

| Situação | Ação |
| --- | --- |
| Run `Não confirmado` | "Reconciliar"; se `unconfirmed`, conferir na VM; nunca reenviar sem checar |
| Processo órfão na inbox | conferir resultado na VM; `kill <pid>` no host; o bloqueio some sozinho |
| `runtime_database_in_use` no start | outra instância viva no mesmo `data/`; não force |
| `provider_version_unsupported` (Codex atualizado) | `./scripts/cockpit protocol-diagnose` → se PASS estrutural, acrescentar a versão em `SUPPORTED_CODEX_APP_SERVER_VERSIONS` com fixture, teste e commit |
| `provider_auth_required` (Claude) | login dentro da VM pelo operador |
| Voltar a versão anterior ao E4 | restaurar cópia de `data/` (schema v5 não abre em código antigo) |

## 12. Backlog posterior (fora da V1)

OpenCode (F5); objetivos longos com checkpoints humanos (F6); reaper de conexões Codex ociosas; mover runners de homologação para `tools/`; exportar `reliability` como métricas se um backend existir; fontes OFL empacotadas na UI; logos em alta resolução quando o ZIP da marca aparecer.

## 13. Indicadores concretos de conclusão

- `develop` contém F0–F4; CI verde; `artifact --check` PASS.
- `docs/evidence/` tem registros de E3, E4, Claude real e V1 (um dia de uso).
- `reliability` do dia de aceite: `dispatch_unconfirmed = transitions_rejected = transcript_write_failed = 0`; `reconcile_unconfirmed` apenas nos casos do drill.
- Nenhum item da §6 com prioridade P0 aberto.

## 14. Próxima ação executável

F0 concluída em 2026-11-08 (veja o histórico abaixo). A próxima fase é a **F1, operar todo dia**, em branch e worktree a partir do `develop`, com o escopo e o aceite da §7. A F3 (CI) pode correr em paralelo.

---

### Histórico de decisões deste plano

| Data | Versão | Mudança |
| --- | --- | --- |
| 2026-10-25 | kickoff | M0 definido; caminho M1–M3 esboçado |
| 2026-11-07/08 | implícito | numeração E0–E4 adotada nos prompts de execução; nenhum documento definia E5/E6 |
| 2026-11-08 | 2.0 | este plano: V1 = operação diária; painel de 6 instrumentos descartado do Cockpit; D6 ratificada; D8 e L4 para decisão |
| 2026-11-08 | 2.0.1 | F0 concluída: `develop` com o fast-forward da integração E4 + UI v1.1 e este plano mesclado; aceites E3/E4 registrados como atestado (`docs/evidence/e3-browser-arch.md`, `e4-arch.md`); `docs/runbook.md`; README coerente. Só o estado foi atualizado (§5, L1, L5, L9, §14), sem mudança de escopo ou prioridade |
