# F2 — Prova com provider real

**Branch:** `feat/f2-real-provider-proof`, a partir do `develop` `4e4bd9d`. **Escopo:** §7 do [master plan v2](master-plan.md), lacunas **L4** e **L8**, mais a prova estruturada com provider real que a L1 deixou para a F2 e o critério V1 §8.3.
**Estado (2026-11-09):** marcos **F2-M1 e F2-M2 implementados e verificados nesta VM** (Debian, modo simulado, sem prompt real). Nada da F2 foi executado no Arch: o drill com Claude real (L8) está **pronto para homologação** (§5, procedimento no fim da seção) e ainda **não foi executado**.

## 1. Escopo real (master plan §7 F2, sem acréscimos)

| Item do master plan | Origem | Resultado observável exigido |
| --- | --- | --- |
| **L4**: run Codex reconciliado como `running`, preso a um app-server órfão (sem eventos, sem interrupção, projeto travado) | §6 L4, decisão D10 | `reconcile` recusa reatar quando o ledger mostra órfão Codex na VM (`orphan_owns_turn`), mantendo `unknown`. Arquivos previstos: `src/execution.ts`, `tests/e4-recovery.test.ts`, `docs/e4-confiabilidade.md` |
| **L8**: queda abrupta com Claude real nunca exercitada; formas `UNVERIFIED` em `src/claude-protocol.ts` | §6 L8 | drill registrado: prompt longo real no Claude, `kill -9` do Cockpit, restart. Esperado: parcial preservada, órfão listado, envio bloqueado, `kill <pid>` libera. Registro em `docs/evidence/e4-claude-real-arch.md` |
| L1: aprovação e `AskUserQuestion` reais só atestados oralmente | §6 L1 | "a prova estruturada com provider real vem na F2". O §7 não detalha essa prova além do drill. Veja a pergunta P2 em §6 |
| V1 §8.3: queda ordenada e `kill -9` com Claude real **e** com Codex real | §8 | coberto pelo drill L8 (Claude) e pela prova F1-P1 (Codex), que a F1 já deixou pronta |

Esforço previsto no plano: 1–2 dias mais 30 min do operador, com quota mínima (1–2 prompts, §9). Depende só da F1, que está integrada (`4e4bd9d`).

**Fora da F2** (não feito e não planejado aqui): tiles e "ciente" (F4), CI (F3), OpenCode (F5), reaper de conexões Codex ociosas (§12), reatar um órfão Codex (pendência L4 do backlog de decisões; a D10 abaixo escolhe **não** reatar).

## 2. O que já existe e não será reimplementado

| Já existe | Onde | Uso na F2 |
| --- | --- | --- |
| Registro de filhos `msb` e classificação de órfãos (`codex_app_server`, `claude_session`) via `/proc` | `src/process-ledger.ts` (E4) | fonte da decisão do M1, sem mudança |
| Envio bloqueado com `409 orphan_process_alive` enquanto há órfão da sessão (Claude) ou da VM (Codex) | `src/execution.ts` `startRun` (E4) | sem mudança |
| Reconciliação do Claude após queda: `provider_cannot_confirm`, sem contato com a VM | `src/execution.ts` (E4) | é o resultado esperado no drill L8 |
| Parcial persistida a cada 1 s e marcada como incompleta após `kill -9` | `src/execution.ts`, `src/runtime-store.ts` (E3.1/E4) | é o "parcial preservada" do drill |
| Unit systemd isolada, com porta, dados e credencial próprios, SIGKILL, restart e limpeza | `src/f1-systemd-smoke.ts` (F1-D) | base do runner do drill (M2) |
| **Prova F1-P1** (opt-in, 1 prompt real Codex): `orphan_turn_started`, `run_unknown_after_crash`, `orphan_ledger`, `orphan_blocks_send`, `orphan_released` | `src/f1-systemd-smoke.ts`, `tests/f1-orphan-proof.test.ts` | já é a metade Codex do §8.3. O M2 acrescenta a reconciliação e o Claude, em vez de escrever outro runner |
| Drill E4 com processos reais do Cockpit e agentes simulados | `scripts/e4-homologation.ts` | regressão de cada marco |

## 3. Marcos propostos (ordem de valor, risco e dependência)

| Marco | Conteúdo | Por que nesta ordem | Quem executa | Estado |
| --- | --- | --- | --- | --- |
| **F2-M1** | L4/D10: `reconcile` devolve `unconfirmed`/`orphan_owns_turn` enquanto houver app-server Codex órfão vivo na VM. Não abre conexão ao lado do órfão, não reata, não trava o projeto. Texto na interface, runbook e E4 §2/§10 | Resolve um beco sem saída real do uso diário sem gastar quota nem depender do Arch. É pré-requisito para a prova Codex do M2 conferir a reconciliação | executor, nesta VM | **feito** (este documento, §4) |
| F2-M2 | Runner do drill, estendendo a prova F1-P1 em vez de criar outro: (a) a checagem `reconcile_orphan_owns_turn` na prova Codex; (b) um modo Claude na mesma unit isolada: 1 prompt longo sem ferramentas na VM Claude **de teste**, SIGKILL, restart, depois confere parcial preservada e incompleta, run `unknown`, órfão `claude_session` listado, envio na mesma sessão recusado (409), reconciliação `provider_cannot_confirm`, e liberação após o fim do órfão. Mesmo contrato do smoke: confirmação por efeito, 0/1/2, limpeza em Ctrl+C, nunca contra o serviço de uso diário. Testes herméticos com `msb` e Claude simulados | Transforma os 30 min manuais do operador em um comando. O risco (gasto de quota, sinal em processos) já foi resolvido e revisado no F1-P1, e é reutilizado | executor, nesta VM | **feito, hermético** (§5): falta a execução no Arch |
| F2-M3 | Execução no Arch pelo operador (um comando por provider, 1 prompt cada), registro em `docs/evidence/e4-claude-real-arch.md` e `docs/evidence/f2-codex-orphan-arch.md` separando executado de atestado. Atualização do master plan §5/§6/§14 em commit próprio | Só faz sentido com o runner pronto e revisado. Depende do operador e de quota | operador + executor | a fazer |

A F1-P1 (órfãos reais sob o systemd) coincide com a metade Codex do M3 e pode ser fechada na mesma execução, como a própria evidência da F1 previa.

## 4. F2-M1 — o run Codex não fica mais preso ao órfão (L4, D10)

### Decisão D10

O master plan pede uma decisão para o run preso a um órfão Codex (§6 L4) e já descreve a escolhida no §7 F2. Ela foi adotada **como escrita**:

- Enquanto o ledger mostrar um `codex_app_server` órfão **vivo na mesma VM**, a reconciliação de qualquer run `unknown` dessa VM devolve `unconfirmed` com `orphan_owns_turn`, e o run continua `unknown`.
- A reconciliação não consulta o provedor enquanto o órfão viver. Um app-server novo veria o turno só de fora: leria `inProgress` e reataria a um stream que nunca recebe os eventos, ou daria um estado de um turno cujo dono continua vivo. Nenhum dos dois é evidência (D3).
- O Cockpit não reata ao órfão nem o sinaliza. O operador confirma **dentro da VM** que a tarefa terminou, só então roda `kill <pid>`. A próxima reconciliação consulta o provedor como antes.
- Se o registro de processos não puder ser lido, um run Codex não é reconciliado: `unconfirmed`/`orphan_check_unavailable` (falha fechada). A leitura do painel continua tolerante, como no E4.
- Fica de fora: Claude (o caminho do E4 já devolve `provider_cannot_confirm` sem contatar a VM), órfãos de outra VM e verificações avulsas (`claude_command`).

### O que mudou

| Arquivo | Mudança |
| --- | --- |
| `src/execution.ts` | `reconcile`: depois de `provider_run_unbound` e antes de qualquer contato com o provedor, consulta `processes.orphans({ strict: true })` (que relê o `/proc` a cada chamada). Com `codex_app_server` órfão na VM, responde `orphan_owns_turn`; com o registro ilegível e run Codex, `orphan_check_unavailable`. Usa o contador `reconcile_unconfirmed` e o log `run.reconciled` já existentes. Nenhuma métrica nova, nenhuma rota nova, nenhum schema novo |
| `src/process-ledger.ts` | `orphans({ strict: true })` lança `process_ledger_unavailable` em falha de leitura. Sem a opção, o comportamento do E4 não muda (log e lista vazia) |
| `public/app.js` | textos de `orphan_owns_turn` (o que aconteceu; confirmar na VM que a tarefa terminou, só então encerrar o órfão do card "Processo órfão", reconciliar de novo) e de `orphan_check_unavailable` |
| `tests/f2-orphan-owns-turn.test.ts` | 4 testes, com o órfão como processo **real** (`sleep`) no `/proc` e o App Server simulado, cujo mundo sobrevive ao Cockpit como a VM sobrevive |
| `tests/frontend.test.ts` | 1 teste: a recusa vira uma frase, e não o código, e nada é reenviado |
| `docs/e4-confiabilidade.md`, `docs/runbook.md` | linha nova na tabela de reconciliação; §10 com o que foi resolvido e o que continua aberto |

O master plan propunha os testes em `tests/e4-recovery.test.ts`. Eles ficaram num arquivo próprio porque o harness daquele arquivo só monta o Claude. O comportamento coberto é o mesmo.

### Testes e evidências (executados automaticamente nesta VM, Bun 1.4.4, modo simulado)

| Verificação | Resultado |
| --- | --- |
| Linha de base no `develop` `4e4bd9d`, antes de qualquer mudança | 363 pass / 0 fail |
| `tests/f2-orphan-owns-turn.test.ts` | 4 pass. Cenário completo: turno em voo, `kill -9` do Cockpit #1 sem interromper o turno, Cockpit #2 abre o mesmo banco, o ledger classifica o órfão, `POST /api/runs/:id/reconcile` por HTTP real devolve `unknown` + `orphan_owns_turn`. Nenhuma conexão aberta, nenhum turno novo, `lifecycleVersion` inalterado, projeto livre, contadores e log conferidos. Repetir o clique não muda nada, e o envio continua `409 orphan_process_alive`. Depois que o turno termina na VM e o órfão é encerrado, a reconciliação seguinte confirma `completed` com uma única conexão de leitura, sem reenvio. Também: órfão de outra VM ou não Codex não interfere; `provider_run_unbound` e `run_not_unknown` vêm antes e não consultam o ledger. Com o registro ilegível (um `ProcessLedger` real sobre um banco fechado), a reconciliação Codex sai `orphan_check_unavailable` sem abrir conexão, e a leitura do painel continua sem erro |
| **Controles negativos** | (A) contra o `src/execution.ts` do `develop`: o cenário completo **falha** com `status: "running"`, `reason_code: "reconciled"` (a lacuna L4 reproduzida), e o fail-closed também falha; os 2 testes de fronteira passam, como esperado. (B) contra a primeira versão da correção, fail-open: só o teste fail-closed falha, também com `reconciled`. [`negative-control.txt`](evidence/f2-m1-2026-11-09/negative-control.txt) |
| Teste de interface, e controle negativo sem o texto novo | pass; sem o texto, falha com "Reconciliação sem evidência: orphan_owns_turn" |
| **Fechamento adversarial do M1** (`tests/f2-m1-adversarial.test.ts`, commit `c0e54b8`) | 8 testes com um órfão real no `/proc`: nenhum sinal por recuperação, reconciliação, envio bloqueado, interrupção ou fechamento ordenado (espião em `process.kill`; o órfão e um processo estranho seguem vivos com o mesmo tempo de início); guarda estático dos pontos de sinal; PID reutilizado por um estranho é esquecido e não bloqueia; replay devolve o run original, prompt alterado conflita, chave nova é recusada, sem linha de run nem turno novo; 8 reconciliações concorrentes e um terceiro reinício dão a mesma recusa; sem permissão: 404 sem pista do órfão; com permissão: vocabulário fechado, sem PID, nome de VM ou texto do provider; o caso L4 residual fica **fixado** como RESIDUAL/P3. 4 mutações do código de produção, todas detectadas ([`adversarial-mutations.txt`](evidence/f2-m1-2026-11-09/adversarial-mutations.txt)) |
| `./scripts/cockpit e4-homologation` (typecheck, suíte, drill) | typecheck limpo; **368 pass / 0 fail** (363 + 5); drill **11/11**, `"overall": "PASS"`. Uma execução anterior com a mesma árvore deu 367/1: o teste intermitente pré-existente da F1 descrito em §5, registrado no mesmo log. [`e4-homologation.log`](evidence/f2-m1-2026-11-09/e4-homologation.log) |
| `scripts/visual-check.ts` (fluxo Codex no Chromium), após a última mudança de texto | **23/23 PASS**. [`visual-check.log`](evidence/f2-m1-2026-11-09/visual-check.log) |
| `./scripts/cockpit artifact --check` | PASS após regenerar o manifesto |

**Não executado:** nada no Arch; nenhum provider real; nenhum prompt; o serviço da porta 8787, suas VMs, credenciais e `data/` não foram tocados. O único processo sinalizado pelos testes é o `sleep` que o próprio teste criou.

### Revisão independente

Feita por outro agente (Claude), em modo só leitura, sem receber as conclusões do autor. Ele leu o diff, rodou os testes novos (3/3) e `tests/frontend.test.ts` (40/40), e conferiu que nenhum processo `sleep` nem diretório temporário ficou para trás. Ele não teve nenhum achado alto. A revisão pelo Codex não foi feita: o CLI continua sem login nesta VM.

| # | Sev. | Achado | Tratamento |
| --- | --- | --- | --- |
| 1 | média | O check falhava aberto: com o registro ilegível, `orphans()` devolvia `[]` e a reconciliação reatava, reabrindo a L4 | **corrigido**: `orphans({ strict: true })` e `orphan_check_unavailable` para runs Codex. Teste novo com controle negativo (B) |
| 2 | média | O procedimento "encerre o órfão e reconcilie" leva ao caso que continua aberto: se o turno seguir na VM, ou um turno de dono morto ainda aparecer como `inProgress`, a reconciliação seguinte reata | **mitigado**: interface, runbook e E4 §10 agora mandam confirmar na VM que a tarefa terminou **antes** do `kill`, e avisam do risco. A correção de fundo ("depois de um reinício, nunca reatar um turno `running` que a conexão atual não iniciou") muda a política do E0 e não está no §7: virou a pergunta P3 (§6) |
| 3 | baixa | "Nada é aberto ao lado do órfão" prometia mais do que o código faz: histórico, lista de threads e abertura de sessão ainda abrem um app-server na VM | **corrigido na redação**: a promessa vale para a reconciliação. Essas leituras não mudam o estado de nenhum run (§5) |
| 4 | baixa | "O projeto não fica preso": novos envios na VM continuam recusados (409) até o órfão terminar | **corrigido** no E4 §10 |
| 5 | baixa | O documento dizia `artifact --check` PASS antes de o manifesto ser regenerado | **corrigido**: manifesto regenerado e conferido no commit |
| 6 | baixa | O título do 3º teste dizia o contrário do que ele verifica | **corrigido** |

O revisor também checou sem achados: corridas e ordem (órfãos só nascem no `recover()` da partida, antes de qualquer requisição; depois só podem sumir), bloqueio indevido (filtro por tipo e VM), interrupção e aprovações, as invariantes (nada reenviado, `lifecycleVersion` inalterado, nenhum sinal a órfãos), segurança (código de motivo literal e fechado, sem PID nem nome de VM na resposta ou no log, nenhuma rota ou schema novo) e a qualidade dos testes.

## 5. F2-M2 — prova com Claude e Codex reais no smoke isolado

**Estado:** implementado e validado **só com simuladores** nesta VM. Nada foi executado no Arch, nenhum prompt real foi enviado, nenhuma VM, unit, credencial ou `data/` real foi tocado.

### O que é

O mesmo comando e a mesma unit de runtime isolada do smoke F1-D (`./scripts/cockpit f1-systemd-smoke`), sem comando novo. A VM de teste pode ser `claude-<projeto>` ou `codex-<projeto>`; o provider vem do nome (a P1 está resolvida pela instrução do Tech Lead de reutilizar o smoke isolado). Sem a prova opt-in, uma VM Claude roda só o smoke base: o `msb_exec` é a sondagem read-only que o Cockpit já faz ao conectar (`claude --version`, `--help`, `auth status`), sem prompt e sem quota.

Com a prova opt-in (`COCKPIT_SMOKE_ORPHAN_PROOF=yes` e `COCKPIT_SMOKE_QUOTA_CONFIRMED=yes`, as duas) o smoke envia **um** prompt real, sem ferramentas, à VM de teste, leva o SIGKILL do Cockpit com o turno em voo, deixa o systemd reiniciá-lo e confere, nesta ordem:

| # | Checagem | Provider | PASS quando | NOT_VERIFIED quando | FAIL quando |
| --- | --- | --- | --- | --- | --- |
| 1 | `orphan_turn_started` | ambos | o run ficou `running` e ligado ao provider | — (um erro aborta e vira FAIL com o código) | o turno já tinha terminado, a sessão ou o envio falharam |
| 2 | `run_unknown_after_crash` | ambos | depois do restart o run está `unknown` (com o motivo, `process_restarted`) | — | qualquer outro status: o run virou resultado sem evidência |
| 3 | `partial_preserved` | Claude | cada item lido **antes** do kill continua lá com o texto como **prefixo**; o que ainda transmitia está `incomplete`; o prompt existe **uma vez** | o modelo não transmitiu texto suficiente (80 caracteres persistidos) antes do kill | item sumiu, texto encurtado ou reescrito, não marcado incompleto, prompt duplicado ou ausente |
| 4 | `orphan_ledger` (base) | ambos | todo filho `msb exec` sobrevivente aparece como `orphan_process` no painel | nenhum filho sobreviveu ao SIGKILL | um sobrevivente não está listado |
| 5 | `orphan_blocks_send` | ambos | um envio de prova recebe **409** `orphan_process_alive` **e** a sessão continua com **um** run | nenhum órfão que bloqueie a sessão (Claude: só `claude_session` dela; Codex: `codex_app_server` da VM) ou a contagem de runs ilegível | o envio foi aceito, outro status, ou o 409 criou um run |
| 6 | `reconcile_conservative` | ambos | HTTP 200, run ainda `unknown`, `unconfirmed` com o motivo documentado (Codex `orphan_owns_turn`, Claude `provider_cannot_confirm`) **e nenhum filho `msb exec` novo** na unit | Codex sem órfão (a recusa só existe por causa dele) | resposta diferente, ou a reconciliação abriu um `msb exec` ao lado do dono |
| 7 | `orphan_released` | ambos | depois de o smoke encerrar o órfão, ele sai de "Precisa de você" | nenhum sobrevivente | o órfão continua listado |
| 8 | `reconcile_after_release` | ambos | **Claude:** continua `unknown`/`provider_cannot_confirm`. **Codex:** a resposta do provider é **observada**: status final, ou `unknown` não confirmado | **Codex:** o turno ainda aparece `running` (`reattached_running_after_owner_ended`: o caso L4 em aberto, pergunta P3), ou erro do Cockpit | Claude resolveu o run sem evidência; Codex continua recusando com `orphan_owns_turn` depois do fim do órfão |

A ordem é fixa e testada: o envio de prova e a reconciliação acontecem **antes** de qualquer sinal ao órfão. O smoke só o encerra depois (SIGTERM, depois SIGKILL em 3 s), e só enquanto o PID for, naquele instante, membro do cgroup **da própria unit** e um `msb`.

### Garantias de segurança (todas com teste)

- **Isolamento do F1-D inalterado:** unit de runtime, porta, `data/` e credencial próprios; nada de `~/.config/engineering-cockpit`, do serviço instalado ou do Cockpit da porta 8787.
- **Sinais:** só `terminate()` envia sinais, só a `msb exec` do cgroup da unit. Um espião em `process.kill` confere que o único PID sinalizado é o órfão, que um processo estranho e um `msb list` transitório no mesmo cgroup não são tocados, e um guarda estático confere que só `e0-recovery.ts` e `f1-systemd-smoke.ts` podem sinalizar por PID.
- **Sobreviventes = filhos `msb exec`:** o que o ledger rastreia. Um `msb list` da descoberta não é órfão e nunca é sinalizado (o argv vem de `/proc/<pid>/cmdline`, com `argv[0]` normalizado para o nome base).
- **Quota:** no máximo **dois** envios: o prompt real e a sonda "Responda apenas: ok." que **deve** ser recusada (só é enviada se houver órfão que bloqueie). Sem laço de reenvio. Se o bloqueio falhar e a sonda for aceita, é FAIL, e o turno extra é inofensivo.
- **VM de teste:** a VM de desenvolvimento (`claude-engineering-cockpit`) e as de `COCKPIT_RESERVED_VMS` são recusadas **antes** de criar qualquer coisa.
- **Evidência sem texto:** o relatório só tem tamanhos, contagens, booleanos e códigos do vocabulário fechado `[a-z0-9_]`; nunca o prompt, o texto do modelo ou a credencial (teste).
- **Cada execução real gasta quota:** por isso as checagens da prova **registram o veredito e seguem** em vez de abortar; um FAIL não esconde as outras. Erros de transporte continuam abortando, e a limpeza roda sempre.

### Testes e evidências (executados automaticamente nesta VM, Bun 1.4.4, modo simulado)

| Verificação | Resultado |
| --- | --- |
| Linha de base no `develop` `4e4bd9d` | 363 pass / 0 fail |
| `./scripts/cockpit f1-accept hermetic` sobre o commit `6d500f5` (regressão E4/F1) | **PASS**: typecheck limpo; **446 pass / 0 fail** (363 + 5 do M1 + 78 novos); drill E4 PASS; `visual-check` 23/23; `brand-visual-check` 23/23; `f1-visual-check` 12/12; `f1-browser-acceptance` 52/52; `artifact --check` PASS. [`hermetic-report.md`](evidence/f2-m2-2026-11-09/hermetic-report.md) |
| Testes novos do M2 | `tests/f2-proof.test.ts` (34: parsers e veredictos puros, entradas malformadas e hostis), `tests/f2-provider-proof.test.ts` (33: ponta a ponta contra o stand-in de systemd/Cockpit, um cenário por falha possível), `tests/f2-proof-contract.test.ts` (3: **os mesmos parsers e veredictos contra o servidor, o `ExecutionService`, o ledger e o painel reais**, Claude e Codex, com os contadores reais do painel; e o stand-in preso às chaves do servidor real) |
| Ordem e alcance dos sinais | espião em `process.kill`: o único PID sinalizado é o órfão; um processo estranho e um `msb list` transitório no mesmo cgroup ficam intactos; o envio de prova e a reconciliação acontecem **antes** do primeiro sinal |
| Controles negativos | **14 mutações** do código de produção do M2 (encerrar o órfão antes das checagens, contar `msb list` como órfão, aceitar texto encurtado, ignorar filhos abertos pela reconciliação e os contadores, aceitar envio que criou run, não recusar VM reservada, aceitar run do Claude resolvido sem evidência, cgroup desconhecido, watcher sem amostra final, limpeza sem espera, `terminate` sem revalidar identidade, journal sem checar prompts, `provider_run_unbound` como FAIL): **todas detectadas**. [`mutations.txt`](evidence/f2-m2-2026-11-09/mutations.txt) |
| Vazamentos da execução dos testes | nenhum processo `sleep` e nenhum diretório temporário restantes; nenhuma porta 8787/8788 aberta ou contatada; o checkout `/workspace` segue em `develop` `4e4bd9d` e sem alteração rastreada |

### Não executado, e o que os simuladores não provam

- **Nada no Arch.** Que um filho `msb exec` real sobrevive a um SIGKILL real sob o systemd é a pergunta aberta desde o F1-D (E4 §10); só a execução do operador responde. Se nenhum sobreviver, as checagens de órfão saem `NOT_VERIFIED`, nunca PASS.
- **O que o Claude e o Codex reais transmitem e devolvem.** A prova exige texto persistido antes do kill; se o modelo pedir uma ferramenta, o run fica `awaiting_approval` (o smoke nunca aprova) e o parcial sai `NOT_VERIFIED`.
- **O que acontece dentro da VM** quando o `msb exec` do host é encerrado: o turno pode continuar e terminar sozinho (gasta quota do turno já pago). Por isso a VM deve ser de teste e estar sem uso.
- **A forma exata das respostas do Cockpit real** é coberta pelo teste de contrato (parsers e veredictos rodados contra o servidor, o `ExecutionService`, o ledger e o painel reais, em processo; o stand-in usado nos testes de ponta a ponta não pode ter campo que o servidor real não tem). O "kill" ali é a emulação do E4 (segundo `RuntimeStore` no mesmo arquivo), porque um processo não se mata sozinho.
- **O sinal de que o bloqueio some** é o painel do próprio Cockpit; não se envia outro prompt depois da liberação (seria um segundo turno real, possivelmente ao lado de um processo ainda vivo dentro da VM). O desbloqueio é coberto de forma determinística pelos testes do E4.

### Procedimento mínimo e seguro no Arch (não executado aqui)

Pré-condições: uma VM de **teste** do provider, ligada, com login feito, **sem turno em andamento e que ninguém use**. Nunca `claude-engineering-cockpit`. Nada abaixo para, reinicia ou altera o Cockpit da porta 8787, as VMs de uso, `~/.config/engineering-cockpit` ou `data/`.

```sh
# 1. Sem VM e sem quota (seguro): o checkout da branch e a verificação local
git worktree add ~/sandboxes/agent/worktrees/cockpit-f2 feat/f2-real-provider-proof && cd ~/sandboxes/agent/worktrees/cockpit-f2 \
  && ./scripts/cockpit bootstrap && ./scripts/cockpit e4-homologation && ./scripts/cockpit artifact --check

# 2. Smoke base com a VM Claude de teste: só leitura, sem prompt, sem quota
COCKPIT_F1_SMOKE_CONFIRMED=yes COCKPIT_SMOKE_VM=claude-<teste> COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" \
  ./scripts/cockpit f1-systemd-smoke; echo "exit=$?"

# 3. Prova com Claude real: 1 prompt real (+ a sonda, que deve ser recusada). Gasta quota. Só com autorização
COCKPIT_F1_SMOKE_CONFIRMED=yes COCKPIT_SMOKE_VM=claude-<teste> COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" \
  COCKPIT_SMOKE_ORPHAN_PROOF=yes COCKPIT_SMOKE_QUOTA_CONFIRMED=yes ./scripts/cockpit f1-systemd-smoke; echo "exit=$?"

# 4. A mesma prova com uma VM Codex de teste (fecha o F1-P1 e confere o M1 sob o systemd real). Gasta quota. Só com autorização
COCKPIT_F1_SMOKE_CONFIRMED=yes COCKPIT_SMOKE_VM=codex-<teste> COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" \
  COCKPIT_SMOKE_ORPHAN_PROOF=yes COCKPIT_SMOKE_QUOTA_CONFIRMED=yes ./scripts/cockpit f1-systemd-smoke; echo "exit=$?"
```

Saída: JSON no stdout; `exit` 0 = PASS, 1 = FAIL, 2 = NOT_VERIFIED. Traga o JSON inteiro (ele não contém prompt, texto do modelo nem credencial). Os passos 3 e 4 são independentes. Se algo for interrompido (Ctrl+C), a unit e os arquivos são removidos, e um remanescente de queda de energia é removido na execução seguinte; a remoção manual está em `docs/f1-operacao-diaria.md` §6. Os registros do M3 são `docs/evidence/e4-claude-real-arch.md` e `docs/evidence/f2-codex-orphan-arch.md`, separando executado de atestado.

### Revisão independente do M2

Feita por outro agente (Claude), em modo só leitura, sem receber as conclusões do autor, sobre processos, sinais, reconciliação e limpeza. **Nenhum achado alto.** Ele confirmou que não há caminho para um segundo prompt real (exatamente um envio real e uma sonda, cada um com chave aleatória nova e sem laço de repetição) nem para um sinal fora do cgroup da unit. A revisão pelo Codex continua não feita (o CLI está sem login nesta VM).

| # | Sev. | Achado | Tratamento |
| --- | --- | --- | --- |
| M1 | média | "Nenhum filho `msb exec` novo" podia passar sem observar nada: dois instantâneos perdem um filho que nasce e morre dentro da chamada; cgroup desconhecido ou argv ilegível contavam como zero | **corrigido**: amostragem do cgroup a cada 20 ms **durante** a chamada, mais os contadores do próprio Cockpit antes/depois (`provider_connections`, `runs_dispatched`: sem corrida). Observação incompleta é NOT_VERIFIED; cgroup desconhecido falha fechado. Um defeito real no watcher novo (contagens lidas antes da amostra final) foi achado pelo teste de argv ilegível e corrigido |
| M2 | média | Run sem id do provider (`provider_run_unbound`) ou ledger ilegível davam FAIL ou PASS enganosos | **corrigido**: NOT_VERIFIED nas duas fases; o Codex só passa um `unknown` não confirmado quando o motivo é `provider_reports_unknown` |
| M3 | média | A limpeza lia o estado uma vez logo após o SIGKILL e podia relatar `unit_deactivating` ou `cgroup_not_empty` falsos | **corrigido**: espera limitada até a unit e o cgroup assentarem |
| M4 | média | `terminate` só revalidava o cgroup e `isMsb`: um PID reutilizado por um `msb list` no mesmo cgroup podia receber sinal | **corrigido**: antes de cada sinal confere o tempo de início do kernel (o mesmo critério do ledger) e que ainda é filho `msb exec` |
| L1 | baixa | Turno real que acabou antes do kill dava FAIL | **corrigido**: NOT_VERIFIED |
| L2 | baixa | `reconcile_conservative` do Claude sem sobrevivente parecia prova com dono vivo | **corrigido**: a evidência traz `orphan_alive` |
| L3 | baixa | Valores do servidor interpolados em `reason` | **corrigido**: vocabulário fechado. O nome da VM e do projeto em `report.vm` já existia desde o F1-D e continua (veja §6) |
| L4 | baixa | `journal_clean` só procurava a credencial | **corrigido**: também rejeita os prompts e o início do texto parcial |
| L5 | baixa | Sem timeout de HTTP; uma interrupção saía sem imprimir o relatório | **corrigido**: 30 s por chamada; a interrupção imprime o que foi observado |
| L6 | baixa | "Liberado" descrevia só o `msb exec` do host | **corrigido**: a evidência diz que o lado da VM não é observado |
| T | testes | O espião não vê `Subprocess.kill()`; o guarda estático só olhava `.kill(`; faltavam cenários (filho efêmero, argv ilegível, PID substituído, interrupção, histórico ilegível, órfão que não sai) | **corrigido**: o stand-in sinaliza por `Subprocess` (separando o que é do smoke), o guarda rejeita também `kill`/`pkill`/`killall`, e há um cenário por achado |

## 6. Riscos e limitações

- **O M2 não foi executado no Arch.** Tudo acima é lógica provada com simuladores e contrato. O que só o Arch responde: se um filho `msb exec` real sobrevive ao SIGKILL do Cockpit sob o systemd (se não sobreviver, os checks de órfão saem NOT_VERIFIED, não PASS); o que o Claude e o Codex reais transmitem e devolvem; como o `argv` do `msb` aparece em `/proc`.
- **Encerrar o órfão não prova nada sobre a VM.** O smoke encerra o `msb exec` do **host**; o agente dentro da VM pode continuar o turno e terminar sozinho, gastando a quota desse turno. A evidência registra `inside_vm: not_observed`. Use uma VM de teste sem outro uso.
- **Observação de filhos tem limite.** Um filho que nasce e morre entre duas amostras de 20 ms não é visto pelo cgroup; o contador `provider_connections` do próprio Cockpit cobre esse caso, e a falta de qualquer um dos dois sinais torna o check NOT_VERIFIED.
- **Resíduo se o próprio smoke levar SIGKILL.** A unit e o cgroup são removidos na execução seguinte, mas `.cache/f1-systemd-smoke/run-*` (credencial e `data/` do smoke) fica até `rm -rf .cache/f1-systemd-smoke`.
- **O relatório traz o nome da VM de teste** (e portanto o projeto), como no F1-D. Não traz prompt, texto do modelo nem credencial.
- **Uma ferramenta pedida pelo Claude** deixa o run em `awaiting_approval` (o smoke nunca aprova): o parcial sai NOT_VERIFIED.
- **A suíte ficou mais lenta** (de ~54 s para ~128 s) porque cada cenário do stand-in espera o restart do systemd simulado. Relevante para o CI da F3.

- **Órfão já morto, turno lido como `inProgress`.** Se o app-server antigo terminou (ou nunca foi registrado: filho de antes do E4, ou ledger indisponível sem `/proc`) e um app-server novo ainda lê o turno como `inProgress`, a reconciliação reata como no E0, e o projeto fica preso até o reinício ou a interrupção. Como o Codex real lê um turno cujo dono morreu **nunca foi observado**. O M3 registra isso na prova Codex (após `orphan_released`, uma reconciliação e o estado lido). Mudar esse caminho exige essa evidência e uma decisão; não foi feito.
- **Falha de leitura do ledger.** `orphans()` devolve lista vazia se o banco falhar na leitura, e então a reconciliação segue o caminho antigo. É a mesma política do bloqueio de envio do E4 (o ledger nunca derruba a operação). A falha é logada (`process.ledger_failed`).
- **Leituras abrem um app-server ao lado do órfão.** Histórico (`thread/read`), lista de threads e abertura de sessão de uma VM Codex com órfão vivo continuam chamando o provedor, como desde o E4. A interface chama histórico e threads ao abrir a sessão. Não mudam estado de run e não são a L4. Bloqueá-las tornaria o histórico indisponível até o fim do órfão, e isso não foi feito sem decisão.
- **Encerrar o órfão cedo demais.** Se o operador rodar `kill <pid>` com a tarefa ainda rodando na VM, a reconciliação seguinte pode reatar o run sem eventos (caso aberto acima). Mitigado só pelo texto (confirmar na VM antes). Pergunta P3.
- **Teste intermitente pré-existente (não é da F2).** `tests/frontend.test.ts` "the session badge stays hidden until 5 minutes before expiry" falhou uma vez em três execuções completas e passou 8/8 isolado. Causa: o helper `sessionIn` chama `Date.now()` duas vezes, e um tique de 1 ms entre as duas faz o teto ficar 1 ms depois da ociosidade, trocando o rótulo. Existe igual no `develop` `4e4bd9d`. A correção (um só `Date.now()`) é só de teste e fica fora deste incremento; ela importa para a F3 (CI), que pegaria a intermitência.
- **Granularidade por VM.** Um app-server serve todas as threads da VM, então todo run `unknown` da VM espera o órfão, inclusive de outra thread. Isso é conservador e coerente com o bloqueio de envio, que também é por VM.
- **Aceite no Arch pendente.** O M1 não depende do Arch para funcionar, mas só a execução real (M3) prova o comportamento com Codex real.

## 7. Perguntas para o Tech Lead

- **P1 (respondida).** O modo Claude roda na **mesma** unit isolada do smoke F1-D: o Tech Lead pediu para reutilizar o smoke isolado existente. É o caminho já revisado, e também prova o Claude sob `NoNewPrivileges`.
- **P2.** A L1 pede "prova estruturada com provider real" de aprovação e `AskUserQuestion`. O §7 só detalha o drill de queda. Incluir no M2 um passo opcional com uma aprovação real e uma pergunta real (mais 1–2 prompts) ou deixar a L1 como atestado? Recomendação: deixar fora do M2 e decidir no M3, porque aumenta o gasto de quota e exige um humano clicando.
- **P3.** Depois de um reinício, um turno Codex lido como `running` por uma conexão que não o iniciou deve ser reatado (comportamento do E0, mantido) ou ficar `unknown` (`turn_owner_gone`) até o turno terminar? Recomendação: decidir com a evidência do M3, que registra o que o Codex real devolve para um turno cujo dono morreu. Sem essa observação, qualquer escolha é palpite.
