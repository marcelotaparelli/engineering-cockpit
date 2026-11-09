# F2-M3 / L8 — Queda abrupta com Claude real, sob o systemd do Arch

**Fonte:** relatório JSON gerado pelo próprio smoke (`./scripts/cockpit f1-systemd-smoke`, modo prova). O operador o executou no host Arch em 2026-11-09, e o executor o leu do checkout compartilhado (`.cache/f2-m3/`). Os arquivos brutos foram copiados **byte a byte** para [`f2-m3-arch-2026-11-09/`](f2-m3-arch-2026-11-09/), com `SHA256SUMS` conferido contra a origem: 12/12 OK.
**Commit testado:** `de29ef92adcaca1415ecc75732252906341ac14e` (`feat/f2-real-provider-proof`), gravado pelo procedimento em `commit`.
**VM:** `claude-cockpit-e2-test`, VM de teste e não a de desenvolvimento. **Unit:** `engineering-cockpit-f1-smoke.service` (unit de runtime isolada, porta própria 21758). **Relatório:** `2026-11-09T08:06:45.402Z`.
**Resultado geral: `NOT_VERIFIED`.** Esse é o veredito do próprio smoke. Ele não foi reinterpretado.

## O que é executado e o que é atestado

| Item | Natureza |
| --- | --- |
| Os veredictos abaixo | **executado**: checagens automáticas do smoke sobre o Cockpit real, o systemd real, o `msb` real e o Claude real; lidos do JSON arquivado |
| Commit, VM e porta | **executado**: gravados pelo procedimento e pelo relatório |
| Serviço da porta 8787 intacto | **executado**: `systemctl --user show` antes (07:57) e depois (08:26) de toda a janela, que cobre as provas Claude e Codex: `ActiveState=active`, `MainPID=66227`, `NRestarts=0` nos dois instantes ([`service-8787-before.txt`](f2-m3-arch-2026-11-09/service-8787-before.txt), [`-after.txt`](f2-m3-arch-2026-11-09/service-8787-after.txt)) |
| Código de saída `2` do passo 3 | **atestado** pelo operador: o arquivo `3-claude-proof.exit` não foi gravado. É coerente com `overall: NOT_VERIFIED`, que o script mapeia para 2 |
| VM ociosa e sem outro uso, quota autorizada | **atestado** pelo operador |
| Execução única do passo 3 | **atestado**: há um único relatório; o repositório não registra tentativas anteriores |

Passos anteriores do mesmo procedimento, todos executados no Arch no mesmo commit:
- passo 1: typecheck limpo, **455 pass / 0 fail**, drill E4 `overall: PASS` (11 checagens PASS), `PASS artifact manifest` ([`1-e4-homologation.log`](f2-m3-arch-2026-11-09/1-e4-homologation.log), [`1-artifact.log`](f2-m3-arch-2026-11-09/1-artifact.log)). O arquivo `1-e4.exit` não foi gravado; o resultado vem do log;
- passo 2 (smoke base Claude, sem quota): todas PASS, exceto `orphan_ledger` NOT_VERIFIED `no_surviving_msb_child`, `exit=2`. É o portão esperado da §8.4 ([`2-claude-base.json`](f2-m3-arch-2026-11-09/2-claude-base.json)).

## Resultado por verificação (passo 3, prova Claude)

| Verificação | Resultado | Evidência no JSON |
| --- | --- | --- |
| `preconditions`, `unit_loaded`, `start`, `credential_file`, `msb_list`, `msb_exec`, `msb_exec_after_restart`, `orderly_stop`, `refused_start_not_restarted`, `journal_clean`, `cleanup` | **PASS** | unit do template real: `no_new_privileges: yes`, `kill_mode: process`, `restart: on-failure`, `prevent: 78`; início recusado sai com 78 e **0** reinícios automáticos; journal sem credencial, prompt ou texto do modelo; limpeza completa |
| `no_new_privileges` | **PASS** | `proc_status_NoNewPrivs: 1` (lido em `/proc`) |
| `orphan_turn_started` | **PASS** | run `running`, `provider_bound: true`, 1 filho `msb exec` na unit, `partial_text_persisted_before_kill: true`. **Um** prompt real enviado |
| `crash_restart` | **PASS** | SIGKILL do processo principal, 1 reinício pelo systemd |
| `partial_preserved` | **PASS** | 1 item; 209 caracteres antes do kill e 209 depois; prefixo preservado; marcado `incomplete`; **1** mensagem do usuário (prompt não duplicado) |
| `run_unknown_after_crash` | **PASS** | `unknown` / `process_restarted`: o run não virou resultado sem evidência |
| `orphan_ledger` | **NOT_VERIFIED** | `no_surviving_msb_child`: o `msb exec` do host terminou junto com o Cockpit morto |
| `orphan_blocks_send` | **NOT_VERIFIED** | `no_surviving_msb_child`. Sem órfão, a sonda **não** foi enviada (só sai com um órfão que bloqueie) |
| `reconcile_conservative` | **PASS** | HTTP 200, `unknown`, `unconfirmed` / `provider_cannot_confirm`; 0 filho `msb exec` novo; 0 ilegível; `provider_connections` 0 → 0; `orphan_alive: false` |
| `orphan_released` | **NOT_VERIFIED** | `no_surviving_msb_child` |
| `reconcile_after_release` | **PASS** | continua `unknown` / `unconfirmed` / `provider_cannot_confirm` (`orphan_existed: false`) |

## O drill L8 do master plan, item por item

| Esperado (master plan §7 F2) | Resultado real |
| --- | --- |
| parcial preservada | **comprovado** (`partial_preserved` PASS) |
| órfão listado | **não verificado**: nenhum filho sobreviveu |
| envio bloqueado | **não verificado**: nenhum órfão para bloquear |
| `kill <pid>` libera | **não verificado**: nenhum órfão |
| (implícito, D3) run não resolvido sem evidência, nada reenviado | **comprovado**: `unknown` após a queda e após duas reconciliações; prompt uma vez; nenhum `msb exec` aberto pela reconciliação |

## O que este resultado comprova e o que não comprova

**Comprovado (executado):**
- sob o systemd real, com `NoNewPrivileges=yes` e um turno Claude real em voo, um SIGKILL do Cockpit preserva a parcial já persistida, marcada como incompleta;
- o run fica `unknown`, a reconciliação não o resolve sem evidência (`provider_cannot_confirm`) e não abre conexão com a VM;
- o prompt não é reenviado;
- isso fecha a parte "queda com Claude real" que a L8 pedia e que nunca tinha sido exercitada.

**Não comprovado:**
- o caminho do **órfão real** com Claude (listado, bloqueando, liberado). Nesta execução nenhum filho `msb exec` sobreviveu ao SIGKILL do Cockpit;
- isso **não** prova que órfãos sejam impossíveis sob o systemd. A unit usa `KillMode=process`, que não mata os filhos, e por que o `msb exec` terminou não foi observado. O registro E4 §10 já lista hipóteses: EOF do stdin, fim do pipe. O resultado de uma execução não é regra;
- o que aconteceu **dentro da VM** depois da queda (`claude -p` continuou ou parou): não observado;
- aprovação e `AskUserQuestion` reais (L1, pergunta P2): fora da M3.

## Decisão do Tech Lead (atestado, 2026-11-09)

O Tech Lead deu **CONDITIONAL GO para o fechamento técnico**: não repetir provas reais só para tentar produzir um órfão, não reinterpretar NOT_VERIFIED como PASS e não afirmar que órfãos são impossíveis sob o systemd. O risco do caminho de órfão real fica **aberto e aceito**. O mecanismo é coberto pelo drill E4 (processos reais, agentes simulados) e pelos testes herméticos da F2.
