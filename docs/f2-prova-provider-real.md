# F2 — Prova com provider real

**Branch:** `feat/f2-real-provider-proof`, a partir do `develop` `4e4bd9d`. **Escopo:** §7 do [master plan v2](master-plan.md), lacunas **L4** e **L8**, mais a prova estruturada com provider real que a L1 deixou para a F2 e o critério V1 §8.3.
**Estado (2026-11-09):** marco **F2-M1 implementado e verificado nesta VM** (Debian, modo simulado). Nada da F2 foi executado no Arch. O drill com Claude real (L8) ainda **não começou**.

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
| F2-M2 | Runner do drill, estendendo a prova F1-P1 em vez de criar outro: (a) a checagem `reconcile_orphan_owns_turn` na prova Codex; (b) um modo Claude na mesma unit isolada: 1 prompt longo sem ferramentas na VM Claude **de teste**, SIGKILL, restart, depois confere parcial preservada e incompleta, run `unknown`, órfão `claude_session` listado, envio na mesma sessão recusado (409), reconciliação `provider_cannot_confirm`, e liberação após o fim do órfão. Mesmo contrato do smoke: confirmação por efeito, 0/1/2, limpeza em Ctrl+C, nunca contra o serviço de uso diário. Testes herméticos com `msb` e Claude simulados | Transforma os 30 min manuais do operador em um comando. O risco (gasto de quota, sinal em processos) já foi resolvido e revisado no F1-P1, e é reutilizado | executor, nesta VM | a fazer |
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

## 5. Riscos e limitações

- **Órfão já morto, turno lido como `inProgress`.** Se o app-server antigo terminou (ou nunca foi registrado: filho de antes do E4, ou ledger indisponível sem `/proc`) e um app-server novo ainda lê o turno como `inProgress`, a reconciliação reata como no E0, e o projeto fica preso até o reinício ou a interrupção. Como o Codex real lê um turno cujo dono morreu **nunca foi observado**. O M3 registra isso na prova Codex (após `orphan_released`, uma reconciliação e o estado lido). Mudar esse caminho exige essa evidência e uma decisão; não foi feito.
- **Falha de leitura do ledger.** `orphans()` devolve lista vazia se o banco falhar na leitura, e então a reconciliação segue o caminho antigo. É a mesma política do bloqueio de envio do E4 (o ledger nunca derruba a operação). A falha é logada (`process.ledger_failed`).
- **Leituras abrem um app-server ao lado do órfão.** Histórico (`thread/read`), lista de threads e abertura de sessão de uma VM Codex com órfão vivo continuam chamando o provedor, como desde o E4. A interface chama histórico e threads ao abrir a sessão. Não mudam estado de run e não são a L4. Bloqueá-las tornaria o histórico indisponível até o fim do órfão, e isso não foi feito sem decisão.
- **Encerrar o órfão cedo demais.** Se o operador rodar `kill <pid>` com a tarefa ainda rodando na VM, a reconciliação seguinte pode reatar o run sem eventos (caso aberto acima). Mitigado só pelo texto (confirmar na VM antes). Pergunta P3.
- **Teste intermitente pré-existente (não é da F2).** `tests/frontend.test.ts` "the session badge stays hidden until 5 minutes before expiry" falhou uma vez em três execuções completas e passou 8/8 isolado. Causa: o helper `sessionIn` chama `Date.now()` duas vezes, e um tique de 1 ms entre as duas faz o teto ficar 1 ms depois da ociosidade, trocando o rótulo. Existe igual no `develop` `4e4bd9d`. A correção (um só `Date.now()`) é só de teste e fica fora deste incremento; ela importa para a F3 (CI), que pegaria a intermitência.
- **Granularidade por VM.** Um app-server serve todas as threads da VM, então todo run `unknown` da VM espera o órfão, inclusive de outra thread. Isso é conservador e coerente com o bloqueio de envio, que também é por VM.
- **Aceite no Arch pendente.** O M1 não depende do Arch para funcionar, mas só a execução real (M3) prova o comportamento com Codex real.

## 6. Perguntas para o Tech Lead (não bloqueiam o M2)

- **P1.** O modo Claude do runner (M2) deve rodar na **mesma** unit isolada do smoke F1-D (exige systemd de usuário, que existe no Arch) ou num processo comum, isolado, sem systemd? Recomendação: mesma unit. É o caminho já revisado, e também prova o Claude sob `NoNewPrivileges`.
- **P2.** A L1 pede "prova estruturada com provider real" de aprovação e `AskUserQuestion`. O §7 só detalha o drill de queda. Incluir no M2 um passo opcional com uma aprovação real e uma pergunta real (mais 1–2 prompts) ou deixar a L1 como atestado? Recomendação: deixar fora do M2 e decidir no M3, porque aumenta o gasto de quota e exige um humano clicando.
- **P3.** Depois de um reinício, um turno Codex lido como `running` por uma conexão que não o iniciou deve ser reatado (comportamento do E0, mantido) ou ficar `unknown` (`turn_owner_gone`) até o turno terminar? Recomendação: decidir com a evidência do M3, que registra o que o Codex real devolve para um turno cujo dono morreu. Sem essa observação, qualquer escolha é palpite.
