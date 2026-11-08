# F1 — Aceite operacional automatizado

**Branch:** `test/f1-automated-acceptance` (a partir do `develop` `611f44a`). **Escopo:** eliminar a homologação manual restante da F1 ([master plan v2](master-plan.md) §7 e §8, [runbook](runbook.md), [F1 — operar todo dia](f1-operacao-diaria.md) §6) sem consumir quota, sem tocar no serviço de uso diário e sem tocar em VMs ativas.
**Estado:** ver §7 (parecer). Este documento separa, linha a linha, o que foi **executado** do que foi **atestado** e do que **só um humano** pode fazer.

## 1. Comandos mínimos

Nada abaixo escreve no `data/`, nas credenciais, na unit instalada ou nas VMs do operador, e nada encerra processo alheio. Rode de um checkout da branch, com o Bun 1.4.4 (o launcher resolve).

| Onde | Comando | O que faz | Autorização |
| --- | --- | --- | --- |
| qualquer máquina | `./scripts/cockpit f1-accept hermetic` | typecheck, suíte, drill E4, 3 checagens Chromium existentes, a nova suíte de navegador (§4), `artifact --check`; grava `report.md/json` e logs em `.cache/f1-acceptance/hermetic-<data>/` | nenhuma (portas e dados próprios, provedores simulados) |
| Arch | `./scripts/cockpit f1-accept real-readonly` | lê o serviço **instalado** (systemctl show, /proc, journal, GETs sem login na própria porta). Não inicia, não para, não sinaliza, não escreve | nenhuma (só leitura) |
| Arch | `COCKPIT_F1_ACCEPT_CONFIRMED=yes ./scripts/cockpit f1-accept real-readonly --with-login` | o anterior + **um** login, **uma** leitura do dashboard (contadores `reliability`, órfãos) e **um** logout. Cria e revoga uma sessão em memória; nenhum run, sessão de agente ou aprovação | **explícita** (altera estado em memória do serviço) |
| Arch | `COCKPIT_F1_SMOKE_CONFIRMED=yes COCKPIT_SMOKE_VM=<codex-vm-de-teste> COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" ./scripts/cockpit f1-systemd-smoke` | smoke F1-D já aceito (unit de runtime isolada, porta/dados/credencial próprios, limpa tudo) | **explícita** (cria e remove uma unit transitória) |
| Arch | o anterior **mais** `COCKPIT_SMOKE_ORPHAN_PROOF=yes COCKPIT_SMOKE_QUOTA_CONFIRMED=yes` | **prova F1-P1**: um turno real (1 prompt, sem ferramentas) em voo quando o Cockpit isolado leva SIGKILL; confere órfão real, envio bloqueado e liberação | **explícita, com quota** (1 prompt real na VM de teste) |

Saída: 0 = PASS, 1 = FAIL, 2 = NOT_VERIFIED (algo não pôde ser exercitado: **nunca** é relatado como PASS).

**Sequência segura no Arch** (nenhuma linha altera o serviço de uso diário):
```sh
cd <checkout da branch test/f1-automated-acceptance> && ./scripts/cockpit bootstrap
./scripts/cockpit f1-accept hermetic          # 1. tudo o que não precisa do host
./scripts/cockpit f1-accept real-readonly     # 2. o serviço instalado, só leitura
```
Os dois últimos comandos da tabela (smoke e prova F1-P1) usam **unit, porta, dados e credencial próprios** (`engineering-cockpit-f1-smoke.service`, `.cache/f1-systemd-smoke/`). A prova F1-P1 **nunca** roda no serviço de produção: o código só existe dentro do smoke isolado.

## 2. Limites de segurança dos runners

- **Hermético:** o ambiente dos filhos é mínimo (`PATH`, `HOME`, `LANG`, `TMPDIR`, `CHROMIUM`); nenhum `COCKPIT_*` do chamador chega a eles. Cada instância usa porta livre sorteada, `COCKPIT_DATA_DIR` temporário e credencial em arquivo 0600. Só processos que o próprio runner iniciou são sinalizados. As portas 8787/8788 e o `data/` do checkout nunca são contatados.
- **real-readonly:** comandos permitidos: `systemctl --user show|show-environment`, `journalctl --user`, `loginctl show-user`, leituras de `/proc` e `stat`. O teste `tests/f1-acceptance-real.test.ts` **falha** se qualquer outro comando for emitido. Não abre o banco, não lê credenciais de provedor e nunca imprime a credencial do Cockpit; com `--with-login` ela é lida em processo, enviada só à porta loopback do serviço e nunca gravada no relatório (teste).
- **Sem privilégio extra:** nenhum `sudo`, nenhuma capability, nenhum acesso ao `msb` além do que o smoke F1-D já faz. O runner só lê o que o próprio usuário já pode ler; um serviço rodando como root é **FAIL** (`process_privileges`).
- **Autorização:** tudo que altera estado do host (unit transitória, sessão HTTP no serviço, prompt real) exige uma variável de confirmação **por efeito**, e sem ela o runner sai com 2 antes de criar qualquer coisa (testes).

## 3. O que foi adicionado

| Arquivo | Papel |
| --- | --- |
| `tests/support/browser.ts` | driver Chromium (CDP, sem dependência npm) compartilhado pelos novos cenários |
| `tests/support/cockpit-process.ts` | o Cockpit **real** (`src/index.ts`, modo mock) como processo filho, reiniciável na mesma porta e dados; cliente de API |
| `tests/support/mock-cockpit.ts` | o Cockpit mock composto em processo, com limites de sessão sob controle do teste (a produção não tem variável para isso) |
| `scripts/f1-browser-acceptance.ts` | 52 checagens em Chromium real: Claude (AskUserQuestion, aprovar, rejeitar, interromper, contexto), contadores e invariantes, `kill -9` e SIGTERM reais do Cockpit, e a vida da sessão com **timers reais** (30 s ociosa / 50 s de teto no lugar de 30 min / 12 h) |
| `src/f1-acceptance-real.ts` + `tests/f1-acceptance-real.test.ts` | o tier real somente leitura (unit carregada, privilégios, credencial fora do processo, só loopback, 3 sondas HTTP sem login, modos do `data/`, journal, mais o `doctor` do serviço; com `--with-login`: contadores, órfãos e journal exato) e 6 testes com o serviço simulado |
| `src/f1-systemd-smoke.ts` (estendido) + `tests/f1-orphan-proof.test.ts` | modo de prova F1-P1 (4 checagens extras, opt-in) e **o primeiro teste de ponta a ponta do smoke inteiro** (7 testes, com gerenciador systemd e `msb` simulados) |
| `scripts/f1-acceptance.ts` (`./scripts/cockpit f1-accept`) | o orquestrador dos dois tiers acima |
| `tests/f1-acceptance-matrix.test.ts` | garante que esta matriz não apodrece (§4) |

## 4. Matriz de cobertura

**Legenda — Antes:** o que a suíte de 345 testes já cobria (`sim` / `parcial` / `não`). **Classe:** `H-UNIT` teste unitário ou HTTP; `H-PROC` processo real do Cockpit em modo mock; `H-BROWSER` Chromium real; `R-RO` real, somente leitura; `R-ISO` real, isolado, exige autorização; `ATESTADO` registrado pelo operador; `HUMANO` não automatizável. **Estado:** `AUTO` executado automaticamente aqui; `AUTO+ARCH` código pronto e testado com simuladores, **ainda não executado no Arch**; `ATESTADO`; `HUMANO`; `EXTERNO`.
Referências entre crases são verificadas pelo teste da matriz: `arquivo` precisa existir; `arquivo#trecho` precisa conter o trecho num título de teste (ou, em scripts, o identificador).

| ID | Item (fonte) | Cobertura automatizada | Antes | Classe | Estado |
| --- | --- | --- | --- | --- | --- |
| F1-01 | Sessão encerra após 30 min sem atividade (§7 F1, L2) | `tests/local-security.test.ts#authenticated reads alone`; `tests/f1-session-http.test.ts#polling only`; `scripts/f1-browser-acceptance.ts#F1-01` | sim (unit); **não** em navegador | H-UNIT, H-BROWSER | AUTO |
| F1-02 | Teto absoluto de 12 h inviolável (§7 F1) | `tests/f1-session-http.test.ts#activity cannot push past the 12 h ceiling`; `tests/f1-session-http.test.ts#cookie lives up to the 12 h ceiling`; `scripts/f1-browser-acceptance.ts#F1-02` | sim (unit); **não** em navegador | H-UNIT, H-BROWSER | AUTO |
| F1-03 | Só atividade do operador renova (polling, SSE e heartbeat não) (§7 F1, ADR-0003) | `tests/f1-session-http.test.ts#the explicit activity signal renews`; `tests/frontend.test.ts#only real input sends the activity signal`; `scripts/f1-browser-acceptance.ts#F1-03` | sim (unit); **não** com teclado real | H-UNIT, H-BROWSER | AUTO |
| F1-04 | Aviso de expiração nos últimos 5 min (F1 §1) | `tests/frontend.test.ts#the session badge stays hidden until 5 minutes before expiry`; `scripts/f1-browser-acceptance.ts#F1-04` | sim (happy-dom) | H-UNIT, H-BROWSER | AUTO |
| F1-05 | Expirada, a aba volta ao login e o stream fecha (§8.4) | `tests/f1-session-http.test.ts#the live stream does not renew the session and is closed`; `scripts/f1-browser-acceptance.ts#F1-05` | parcial (HTTP); **não** na página | H-UNIT, H-BROWSER | AUTO |
| F1-06 | Nova aba reaproveita a sessão (§8.4) | `tests/frontend.test.ts#a new tab reuses the open tab's session`; `scripts/f1-visual-check.ts#nova aba reaproveita a sessão` | sim | H-UNIT, H-BROWSER | AUTO + validado à mão |
| F1-07 | Logout numa aba devolve as outras ao login | `tests/frontend.test.ts#logging out in one tab`; `scripts/f1-visual-check.ts#logout numa aba` | sim | H-UNIT, H-BROWSER | AUTO + validado à mão |
| F1-08 | Reinício revoga sessões; novo login; histórico preservado (F1 §2, §8.3) | `tests/f1-service-process.test.ts`; `tests/e31-history-restart.test.ts`; `scripts/f1-browser-acceptance.ts#F1-08` | sim (HTTP); **não** na interface | H-PROC, H-BROWSER | AUTO |
| F1-09 | CSRF, nonce único e épocas sem beco sem saída (F1-A) | `tests/local-security.test.ts#F1-A: every request of a closed epoch`; `tests/f1-session-http.test.ts#F1-A over HTTP`; `tests/frontend.test.ts#F1-A: a closed CSRF epoch` | sim | H-UNIT | AUTO |
| F1-10 | Credencial em arquivo 0600; nunca em ambiente, argv, DOM ou storage (§7 F1) | `tests/f1-config.test.ts#the credential is read from a private 0600 file`; `tests/f1-service-process.test.ts`; `scripts/f1-visual-check.ts#credencial fora do DOM`; `src/f1-acceptance-real.ts#credential_not_in_process` | sim | H-UNIT, H-PROC, R-RO | AUTO (+ AUTO+ARCH no serviço instalado) |
| F1-11 | Unit systemd: usuário, `NoNewPrivileges`, `KillMode=process`, restart conservador (L3) | `tests/f1-service.test.ts#unit: user service`; `tests/f1-service.test.ts#the restart policy the tests drive`; `src/f1-acceptance-real.ts#unit_hardening` | sim (estático) | H-UNIT, R-RO | AUTO (+ AUTO+ARCH na unit carregada) |
| F1-12 | `service install/doctor/start/stop/status/rotate-token/uninstall` (runbook) | `tests/f1-service.test.ts#install: private files`; `tests/f1-service.test.ts#doctor: green after install`; `tests/f1-service.test.ts#rotate-token replaces the credential atomically`; `tests/f1-service.test.ts#F1-B: a failed or unverifiable write is rolled back` | sim | H-UNIT | AUTO |
| F1-13 | Queda → reinício; SIGTERM → 0; início recusado (78) não reinicia (L3, runbook) | `tests/f1-service-process.test.ts`; `scripts/f1-browser-acceptance.ts#F1-13`; `tests/f1-orphan-proof.test.ts#end to end without the proof` | sim (processo, política); **não** sob systemd | H-PROC, H-UNIT | AUTO; sob systemd real: ATESTADO (smoke F1-D, 11 PASS) |
| F1-14 | Instância duplicada recusada (78) sem afetar a primeira (runbook) | `tests/f1-service-process.test.ts`; `tests/f1-service.test.ts#doctor: green after install` | sim | H-PROC | AUTO |
| F1-15 | systemd real + `msb` real + `NoNewPrivileges` (F1-D, §6 A2) | `tests/f1-systemd-smoke.test.ts`; `tests/f1-orphan-proof.test.ts#end to end, a surviving child without the proof`; `src/f1-acceptance-real.ts#process_privileges` | parcial (só pré-condições e limpeza) | H-UNIT, R-ISO, R-RO | ATESTADO (Arch: 11 PASS, `orphan_ledger` NOT_VERIFIED); fluxo completo agora testado com simuladores |
| F1-16 | **F1-P1**: recuperação de órfãos **reais** sob o systemd | `tests/f1-orphan-proof.test.ts#F1-P1 proof: one real turn is started`; `tests/f1-orphan-proof.test.ts#a send accepted while an orphan is alive is a FAIL`; `tests/f1-orphan-proof.test.ts#when no msb child survives` | não | R-ISO (quota) | AUTO+ARCH: runner pronto, **não executado**; exige o Arch e 1 prompt real |
| F1-17 | L5: stream sem perda quando o histórico recarrega | `tests/frontend.test.ts#F1 (L5): a history reload in the middle`; `tests/frontend.test.ts#F1 (L5): deltas that arrive while the history request`; `scripts/f1-visual-check.ts#L5` | sim | H-UNIT, H-BROWSER | AUTO + validado à mão |
| F1-18 | L6: "Sem suporte" no lugar de "Offline" | `tests/f1-config.test.ts#F1 (L6/D8)`; `tests/frontend.test.ts#F1 (L6)`; `scripts/f1-visual-check.ts#L6` | sim | H-UNIT, H-BROWSER | AUTO |
| F1-19 | D8: `COCKPIT_RESERVED_VMS` só acrescenta; a VM de desenvolvimento fica sempre reservada | `tests/f1-config.test.ts#F1 (D8): COCKPIT_RESERVED_VMS only adds`; `tests/f1-config.test.ts#the configured list reaches the Claude argv guard` | sim | H-UNIT | AUTO |
| F1-20 | Descoberta de VMs (somente leitura) | `tests/discovery.test.ts`; `tests/discovery-regression.test.ts`; `scripts/visual-check.ts#discovery lista VMs` | sim (fixtures) | H-UNIT, H-BROWSER | AUTO; real: validado à mão |
| F1-21 | Codex: execução, histórico, persistência | `tests/e2e-execution.test.ts`; `tests/m0b-provider.test.ts`; `tests/e4-recovery.test.ts`; `scripts/visual-check.ts#streaming em tempo real` | sim (simulado). O App Server falso guarda as threads na memória do processo: o histórico **do provedor** não sobrevive a um reinício simulado, então não há como provar a persistência dele em modo hermético | H-UNIT, H-BROWSER | AUTO (execução e banco de runs do Cockpit); histórico no provedor: ATESTADO (validado à mão no Arch) |
| F1-22 | Claude: execução, ferramentas, aprovar e rejeitar, contexto | `tests/claude-adapter.test.ts`; `tests/e3-claude-execution.test.ts`; `scripts/f1-browser-acceptance.ts#F1-22` | sim (HTTP/adapter); **não** em navegador | H-UNIT, H-BROWSER | AUTO; real: validado à mão |
| F1-23 | `AskUserQuestion`: pergunta, opções sem pré-seleção, resposta volta ao agente | `tests/claude-adapter.test.ts#AskUserQuestion: every question must be answered`; `tests/frontend.test.ts#E3: a Claude question is answered from the inbox`; `scripts/f1-browser-acceptance.ts#F1-23` | sim (adapter e happy-dom); **não** no fluxo inteiro em navegador | H-UNIT, H-BROWSER | AUTO; real: validado à mão e visualmente |
| F1-24 | Interromper; `unknown` nunca vira resultado sem evidência; nada é reenviado (§8.2, D3) | `tests/e4-recovery.test.ts`; `tests/frontend.test.ts#unknown run shows reconcile`; `scripts/f1-browser-acceptance.ts#F1-24`; `tests/e4-homologation.test.ts` | sim (HTTP e drill); **não** na interface após `kill -9` | H-PROC, H-BROWSER | AUTO |
| F1-25 | Contadores `reliability` zerados e invariantes: prompt uma vez, nenhuma aprovação sozinha (§8.2, §13) | `scripts/f1-browser-acceptance.ts#F1-25`; `tests/e2e-execution.test.ts`; `src/f1-acceptance-real.ts#reliability_counters` | parcial (por teste); **não** como invariante de fluxo completo | H-BROWSER, R-RO | AUTO; no serviço real: AUTO+ARCH com `--with-login` |
| F1-26 | **Um dia de uso real** em ≥ 2 projetos, Codex e Claude, sem terminal (§7 F1, §8.1) | nenhuma. `real-readonly --with-login` ao fim do dia confere contadores e órfãos | não | HUMANO | HUMANO |
| F1-27 | Queda (`kill -9`) com Claude real e com Codex real (§8.3) | Codex: F1-16 (AUTO+ARCH). Claude real: F2 (L8), fora da F1 | não | R-ISO, HUMANO | pendente (F1-16 / F2) |
| F1-28 | Logs, journal e relatórios sem credencial nem prompts | `tests/f1-service-process.test.ts`; `scripts/f1-browser-acceptance.ts#F1-28`; `src/f1-acceptance-real.ts#journal_clean`; `tests/e4-homologation.test.ts` | sim | H-PROC, H-BROWSER, R-RO | AUTO (+ AUTO+ARCH no journal real) |
| F1-29 | Typecheck, suíte e `artifact --check` (§8.5 sem o CI, que é a F3) | `scripts/f1-acceptance.ts#typecheck`; `scripts/f1-acceptance.ts#artifact` | sim (manual) | H-UNIT | AUTO (um comando) |
| F1-30 | Revisão independente da política de sessão **pelo Codex** (§7 F1, riscos) | nenhuma. Existe a revisão do Claude (`docs/evidence/f1-review-claude.md`) | — | EXTERNO | EXTERNO (o Codex CLI não está logado) |
| F1-31 | §6 C: instalar o serviço real sobre o `data/` em uso, preservando histórico | nenhuma (**altera o serviço de uso diário**). `real-readonly` confere o resultado depois | não | HUMANO | HUMANO |
| F1-32 | Registro de evidências com data, commit e executado × atestado (§8.6) | `scripts/f1-acceptance.ts#report.json` grava commit, árvore suja, Bun e resultado por passo | não | H-UNIT | AUTO; arquivar em `docs/evidence/f1-arch.md` é HUMANO |
| F1-33 | UI: layouts 390–1440 px, marca, sem overflow | `scripts/visual-check.ts#layout`; `scripts/brand-visual-check.ts` | sim (manual) | H-BROWSER | AUTO (agora no mesmo comando) |
| F1-34 | Serviço sobe com a sessão do usuário (`enable`, linger) | `src/service.ts#linger` (o `doctor` informa `habilitado` e linger, e o runner real o repassa) | não | R-RO, HUMANO | HUMANO (exige reiniciar a sessão) |
| F1-35 | `rotate-token` com o serviço real (muda a credencial em uso) | `tests/f1-service.test.ts#rotate-token replaces the credential atomically` (hermético) | sim (hermético) | H-UNIT, HUMANO | AUTO no hermético; no serviço real: HUMANO |

## 5. Evidências produzidas

Em [`docs/evidence/f1-aceite-automatizado-2026-11-08/`](evidence/f1-aceite-automatizado-2026-11-08/), todas **executadas automaticamente nesta VM de desenvolvimento (Debian, Bun 1.4.4, Chromium, modo mock)**, no commit `4717946` com a árvore limpa:

| Evidência | Resultado |
| --- | --- |
| `hermetic/report.md` (`./scripts/cockpit f1-accept hermetic`, 2 min 10 s) | **PASS**: typecheck limpo; **363 pass / 0 fail** (345 anteriores + 18 novos); drill E4 PASS; `visual-check` 23/23; `brand-visual-check` 23/23; `f1-visual-check` 12/12; **`f1-browser-acceptance` 52/52**; `artifact --check` PASS |
| `hermetic/f1-browser-acceptance/` | `results.json` e capturas: pergunta do Claude, aprovar e rejeitar, login após `kill -9`, run não confirmado, aviso de sessão, expiração, quase no teto |
| `new-tests.txt` | os 3 arquivos novos: 18 pass (tier real somente leitura, prova F1-P1 e smoke ponta a ponta com simuladores, matriz) |
| `real-readonly-debian-vm/` | `real-readonly` rodado **nesta VM**, que não tem systemd de usuário: resultado **NOT_VERIFIED** (`systemd_user_manager_unavailable`, exit 2), como projetado. Prova que o runner não inventa PASS; **não** é evidência sobre o serviço do Arch |

A suíte de navegador completa passou **4 vezes seguidas** (3 no desenvolvimento e 1 dentro do runner final) depois de duas correções do próprio script: um teste lia o contador `runs_dispatched` cedo demais (ele é incrementado quando a escrita ao provedor retorna, o que num turno simulado muito rápido pode ocorrer depois de o turno acabar; agora espera estabilizar), e dois Cockpits mock no mesmo perfil de navegador sobrescreviam o cookie um do outro (o cookie `cockpit_session` **não é isolado por porta**; os cenários usam um navegador por Cockpit).

## 6. O que **não** foi executado (honestidade)

- **Nada rodou no Arch.** O `real-readonly` contra o serviço instalado, o `--with-login`, o smoke F1-D e a **prova F1-P1** foram escritos e testados **só com simuladores** (gerenciador systemd falso, `msb` falso, serviço HTTP falso, processos `sleep` no lugar dos filhos `msb`). Esses testes provam a lógica do runner (sequência, recusas, limpeza, que só comandos de leitura são emitidos, que o login cria e revoga uma única sessão). **Não provam** que um filho `msb` real sobrevive a um SIGKILL real sob o systemd, nem o formato exato de `systemctl show` no systemd do Arch.
- **Provedores simulados.** Codex e Claude falsos reproduzem o contrato, não o comportamento real. As formas `UNVERIFIED` de `src/claude-protocol.ts` continuam atestadas só pelo operador. O App Server falso guarda as threads na memória do processo, então o histórico **do provedor** não pode ser provado após reinício em modo hermético.
- **Timers em escala.** A vida da sessão em navegador usa 30 s ociosa / 50 s de teto (a produção não tem variável para isso, de propósito). As constantes reais (30 min, 12 h) são verificadas por testes HTTP com relógio injetado. A janela de aviso (5 min) está sempre ativa no cenário reduzido.
- **Só Chromium.** Firefox, também citado na F1, não é coberto.
- **Revisão independente:** o código novo **não** passou por revisão independente (só autoverificação e testes). Ele é de teste e de leitura, mas o modo F1-P1 envia um prompt real quando confirmado: vale uma leitura antes da primeira execução.
- Execuções interrompidas durante o desenvolvimento deixaram diretórios temporários `cockpit-chromium-*`, `cockpit-accept-*` e `cockpit-mock-inproc-*` em `/tmp` desta VM. Uma varredura foi negada pelo ambiente e **não** foi feita. São inofensivos (sem credencial real, sem processo vivo).

### Lacunas que ainda exigem um humano

| Item | Por quê não dá para automatizar | O que o runner já ajuda a fazer |
| --- | --- | --- |
| F1-26 um dia de uso real em ≥ 2 projetos, sem terminal | é a definição de "uso real" (§7 F1, §8.1) | ao fim do dia, `COCKPIT_F1_ACCEPT_CONFIRMED=yes ./scripts/cockpit f1-accept real-readonly --with-login` confere contadores, órfãos e journal em um comando |
| F1-16/F1-27 órfãos reais (F1-P1) | exige o Arch, o systemd real, um `msb` real e **1 prompt real** (quota) | `f1-systemd-smoke` com `COCKPIT_SMOKE_ORPHAN_PROOF=yes COCKPIT_SMOKE_QUOTA_CONFIRMED=yes`, **só** na unit isolada. Decisão do operador |
| F1-27 queda com **Claude real** | é a F2 (L8), fora da F1 | — |
| F1-30 revisão da política de sessão pelo Codex | o Codex CLI não está logado | existe a revisão do Claude (`docs/evidence/f1-review-claude.md`) |
| F1-31 trocar o Cockpit do terminal pelo serviço sobre o `data/` em uso (§6 C) | altera o serviço de uso diário e exige a cópia do `data/` | `real-readonly` confere o resultado depois |
| F1-34 `enable`/linger (sobe com a sessão) | exige reiniciar a sessão do usuário | o `doctor` já informa `habilitado` e linger |
| F1-35 rotação da credencial do serviço real | muda a credencial em uso | hermético coberto |
| F1-32 arquivar o registro em `docs/evidence/f1-arch.md` | decisão e atestado do operador | `report.json` traz commit, árvore e resultado por passo |

## 7. Parecer GO / NO-GO para o aceite automatizado da F1

**GO condicional.**

- **Camada hermética: GO.** Executada e verde no commit `4717946`: tudo o que o aceite F1 pede e que não depende do host real passou, incluindo o que antes só o operador via no navegador (pergunta do Claude, aprovar e rejeitar, `kill -9` do Cockpit com a interface aberta, run não confirmado sem reenvio, expiração e teto da sessão com timers reais). Dos 35 itens da matriz, 28 têm estado `AUTO` (executados aqui; em 4 deles, F1-10, F1-11, F1-25 e F1-28, falta a confirmação no serviço instalado do Arch pelo `real-readonly`), 1 é `AUTO+ARCH` (F1-16, a prova de órfãos), 1 é `ATESTADO` (F1-15, o smoke já aceito), 1 está pendente (F1-27) e 4 dependem de um humano ou de terceiros (F1-26, F1-30, F1-31, F1-34).
- **Camada real: NO-GO até a primeira execução no Arch.** Não declare o aceite automatizado concluído antes de `./scripts/cockpit f1-accept real-readonly` retornar **PASS** no Arch com o serviço instalado (sem autorização especial, não altera nada) e de `hermetic` retornar PASS no checkout do Arch.
- **F1-P1 continua aberto** e é decisão do operador (1 prompt real, VM de teste). Sem ela, o risco residual já aceito pelo Tech Lead excepcionalmente permanece como está.
- **Fora do aceite automatizado, por natureza:** o dia de uso real (F1-26), a revisão do Codex (F1-30), a troca do serviço sobre o `data/` em uso (F1-31) e `enable`/linger (F1-34).

**Condições para virar GO pleno:** (1) `hermetic` PASS no Arch; (2) `real-readonly` PASS no Arch; (3) leitura independente do modo F1-P1 antes de autorizá-lo; (4) F1-P1 executada, ou o risco residual reaceito por escrito; (5) o dia de uso e o registro em `docs/evidence/f1-arch.md`.
