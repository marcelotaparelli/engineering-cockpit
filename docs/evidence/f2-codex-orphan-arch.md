# F2-M3 / F1-P1 — Queda abrupta com Codex real, sob o systemd do Arch

**Fonte:** relatório JSON gerado pelo próprio smoke (`./scripts/cockpit f1-systemd-smoke`, modo prova). O operador o executou no host Arch em 2026-11-09, e o executor o leu do checkout compartilhado (`.cache/f2-m3/`). Os arquivos brutos foram copiados **byte a byte** para [`f2-m3-arch-2026-11-09/`](f2-m3-arch-2026-11-09/), com `SHA256SUMS` conferido contra a origem: 12/12 OK.
**Commit testado:** `de29ef92adcaca1415ecc75732252906341ac14e`. **VM:** `codex-cockpit-e0-test`, VM de teste. **Unit:** `engineering-cockpit-f1-smoke.service` (isolada, porta própria 25120). **Relatório:** `2026-11-09T08:26:04.650Z`.
**Resultado geral: `NOT_VERIFIED`.** Esse é o veredito do próprio smoke. Ele não foi reinterpretado.

## O que é executado e o que é atestado

| Item | Natureza |
| --- | --- |
| Os veredictos abaixo | **executado**: checagens automáticas do smoke sobre o Cockpit real, o systemd real, o `msb` real e o Codex real; lidos do JSON arquivado |
| Serviço da porta 8787 intacto | **executado**: o mesmo `MainPID=66227`, `NRestarts=0`, `active` antes (07:57) e depois (08:26) da janela inteira (veja [`e4-claude-real-arch.md`](e4-claude-real-arch.md)) |
| Código de saída `2` do passo 4 | **atestado** pelo operador: o arquivo `4-codex-proof.exit` não foi gravado. É coerente com `overall: NOT_VERIFIED` |
| VM ociosa e sem outro uso, quota autorizada, execução única | **atestado** pelo operador; há um único relatório |

Passo 2 (smoke base Codex, sem quota, mesmo commit): todas PASS, exceto `orphan_ledger` NOT_VERIFIED `no_surviving_msb_child`, `exit=2` ([`2-codex-base.json`](f2-m3-arch-2026-11-09/2-codex-base.json)). O resultado coincide com o do F1-D em `842cecf`.

## Resultado por verificação (passo 4, prova Codex)

| Verificação | Resultado | Evidência no JSON |
| --- | --- | --- |
| `preconditions`, `unit_loaded`, `start`, `credential_file`, `msb_list`, `msb_exec`, `msb_exec_after_restart`, `orderly_stop`, `refused_start_not_restarted`, `journal_clean`, `cleanup` | **PASS** | template real (`no_new_privileges: yes`, `kill_mode: process`); parada ordenada encerrou 1 filho; início recusado 78 sem reinício; journal limpo; limpeza completa |
| `no_new_privileges` | **PASS** | `proc_status_NoNewPrivs: 1` |
| `orphan_turn_started` | **PASS** | run `running`, `provider_bound: true`, 1 filho `msb exec` na unit. **Um** prompt real enviado |
| `crash_restart` | **PASS** | SIGKILL do principal, 1 reinício |
| `run_unknown_after_crash` | **PASS** | `unknown` / `process_restarted` |
| `orphan_ledger` | **NOT_VERIFIED** | `no_surviving_msb_child`: o `msb exec` do app-server terminou junto com o Cockpit morto |
| `orphan_blocks_send` | **NOT_VERIFIED** | `no_surviving_msb_child`. A sonda **não** foi enviada |
| `reconcile_conservative` | **NOT_VERIFIED** | `no_surviving_msb_child`. A recusa `orphan_owns_turn` (F2-M1) só existe com um órfão vivo, e não houve nenhum |
| `orphan_released` | **NOT_VERIFIED** | `no_surviving_msb_child` |
| `reconcile_after_release` | **PASS** | HTTP 200, `run_status: interrupted`, `result: confirmed`, `reason_code: reconciled`, `orphan_existed: false` |

## A observação real da reconciliação Codex

Sem órfão vivo, a reconciliação seguiu o caminho do E0: abriu uma conexão nova com o App Server da VM e perguntou pelo turno. O **Codex real relatou o turno como `interrupted`**, e o Cockpit passou o run de `unknown` para `interrupted` **com evidência do provider** (`confirmed`). Isso está de acordo com a D3 e não houve reenvio. O nome da checagem vem do caso com órfão; aqui nada foi "liberado", porque não havia órfão.

Leitura cuidadosa:
- é **uma** observação de um caso concreto: o `msb exec` do host, dono do turno, terminou junto com o Cockpit, e o provider passou a ver o turno como interrompido;
- **não** é o caso da pergunta **P3**: um turno lido como `running`/`inProgress` por uma conexão que não o iniciou, depois da morte do dono (`reattached_running_after_owner_ended`). Esse caso **não ocorreu** e continua sem observação real;
- o que aconteceu dentro da VM, se o turno parou de fato ou só foi marcado, não foi observado.

## F2-M1 e F1-P1

| Item | Estado após a M3 |
| --- | --- |
| F2-M1 (`reconcile` recusa reatar com órfão Codex vivo: `orphan_owns_turn`) | **comprovado só em teste** (processo real `sleep` no `/proc`, App Server simulado; controles negativos). Sob o systemd real com Codex real: **não verificado**, nenhum órfão |
| F1-P1 (órfão real sob o systemd: listado, bloqueando, liberado) | **executada** (passos 2 e 4). O resultado é **NOT_VERIFIED**: nenhum filho sobreviveu ao SIGKILL. Não foi repetida, por decisão do Tech Lead. Risco **aberto e aceito** |
| Queda `kill -9` com Codex real: run `unknown`, sem reenvio, resolvido só com evidência do provider | **comprovado** (executado) |

**Não se conclui** que órfãos sejam impossíveis sob o systemd: a unit usa `KillMode=process`, e não se observou por que o `msb exec` terminou.

## Decisão do Tech Lead (atestado, 2026-11-09)

**CONDITIONAL GO para o fechamento técnico.** Não repetir provas reais só para produzir um órfão; não reinterpretar NOT_VERIFIED como PASS; não afirmar que órfãos são impossíveis sob o systemd. A P3 continua **aberta**: o comportamento necessário para decidi-la (Codex lendo `running` um turno de dono morto) não foi observado.
