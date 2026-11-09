# E4 — Confiabilidade e recuperação

**Estado (2026-11-08, F0):** **aceito no Arch por atestado do operador**: 278 testes e 11/11 verificações do drill PASS ([registro](evidence/e4-arch.md)).
- O drill exercita o **Cockpit** real com agentes simulados. A queda com providers reais não faz parte deste aceite e está na F2 do [master plan](master-plan.md).
- Integrado à identidade visual v1.1 no `develop` (`a11a1d9`). Na reexecução automatizada da integração: 283/283 testes e drill 11/11 PASS.
- A numeração E5+ foi substituída pelas fases F0–F6 do master plan v2.

*Estado anterior (mantido para auditoria):* implementado e testado localmente: suíte determinística (278/278) e drill de recuperação com processos reais do Cockpit em modo simulado. **O aceite depende da homologação no Arch**, com o comando único do fim deste documento. O E5 não foi iniciado.

Princípio mantido: diante de uma falha, o Cockpit guarda o que sabe, não repete nada sozinho, não transforma `unknown` em sucesso ou falha sem evidência e diz claramente o que não sabe. Tudo reutiliza `ExecutionService`, `RuntimeStore`/SQLite e os adapters existentes. Não existe uma segunda plataforma.

## 1. Auditoria orientada a falhas

### Lacunas encontradas e corrigidas

| # | Falha | Gravidade | Risco | Correção |
| --- | --- | --- | --- | --- |
| 1 | Uma **segunda instância** no mesmo diretório de dados roda a recuperação de inicialização contra a instância **viva**. Ela marca os runs dela como `unknown`, expira as aprovações que o operador está para decidir e libera o lock do projeto para um segundo escritor. | **Alta** | duplicação, autorização | Posse exclusiva do banco de runtime (§4) |
| 2 | **Processos órfãos.** Depois de um `kill -9` ou crash do Cockpit, os filhos `msb exec` (app-server do Codex, `claude -p`) continuam vivos e podem continuar executando um turno na VM, sem supervisão e sem canal de aprovação. Um novo prompt na mesma sessão ou VM criaria um **segundo agente** ao lado do primeiro. Nada disso aparecia na interface. | **Alta** | duplicação, vazamento | Registro de processos, detecção e bloqueio de envio (§5) |
| 3 | **Cauda da resposta parcial só em memória.** O texto parcial só era regravado quando chegava o próximo trecho. Se o streaming pausava (ferramenta, aprovação, modelo lento), a cauda ficava indefinidamente em memória, e um `kill -9` perdia mais do que o ~1 s documentado no E3.1. | **Alta** | perda de dados | Gravação de cauda por temporizador (§6) |
| 4 | **Causa da queda indistinguível.** VM desligada, processo morto e conexão caída davam o mesmo motivo. | Média | incerteza mal sinalizada | Motivo `vm_stopped` por evidência do discovery (§3) |
| 5 | **Reconciliação silenciosa.** "Reconciliar" devolvia o run inalterado, sem explicar por quê, para o Claude depois de uma queda ou reinício e para runs sem id do provedor. No Claude, ainda abria 3 `msb exec` de sonda na VM só para responder "não sei". | Média | incerteza; interferência desnecessária na VM | Resultado explícito, sem contato com a VM quando não há como confirmar (§2) |
| 6 | **Decisão de aprovação com registro obsoleto.** `decide()` confiava na cópia do chamador. Repetir uma decisão já entregue virava um falso `approval_expired`. Isso não é alcançável pela rota HTTP atual, que relê o banco, mas é frágil. | Média | autorização (robustez) | Sempre o estado gravado: repetição idêntica não faz nada; qualquer outra dá conflito |
| 7 | Códigos crus na interface (`cockpit_shutdown`, `provider_handle_lost`, `run_ended`, `ttl_elapsed`, `provider_resolved`). O histórico não era recarregado quando um run virava `unknown`, então a resposta "incompleta" só aparecia depois do F5. | Média | visibilidade | Rótulos para todos os motivos; recarga do histórico também em `unknown` |
| 8 | Transições recusadas eram engolidas em silêncio, e não havia contadores de falhas. | Baixa | observabilidade | Log `run.transition_rejected` e contadores de confiabilidade (§7) |
| 9 | No E3, o Ctrl+C no wrapper chega duas vezes ao Cockpit, e o segundo handler podia fechar o SQLite durante a gravação do primeiro. | Baixa | perda de dados (parcial) | Desligamento executado uma única vez |
| 10 | O mapa de arquivos por conexão não tinha limite (Codex, conexões longas). | Baixa | memória | Limite de 500 itens |

### Auditado e mantido (sem lacuna)
- Um run `prepared` encontrado no reinício **nunca** foi enviado: `dispatching` é gravado antes de qualquer escrita no provedor. Por isso ele vira `failed` (`not_dispatched_before_restart`).
- Runs `dispatching`, `running` e `awaiting_approval` viram `unknown` (`process_restarted`) no reinício, e as aprovações pendentes expiram. O E0 já tinha comprovado isso para o Codex.
- Idempotência: a mesma chave com o mesmo prompt devolve o mesmo run, mesmo com a VM fora do ar. A interface nunca reenvia sozinha; "Confirmar envio" usa a mesma chave.
- Aprovações: CAS por versão no banco. O adapter confere o turno vivo e o pedido exato (Claude: `turn.id` e `request_id` no processo atual; Codex: requisição pendente na conexão). Uma decisão é retirada antes da escrita e nunca é reenviada.
- Um estado terminal nunca é deixado. `unknown` só sai com evidência do provedor: reconciliação confirmada ou evento terminal do próprio turno ainda vivo.

## 2. Máquina de estados de execução

```
prepared ─▶ dispatching ─▶ running ⇄ awaiting_approval ─▶ completed | failed | interrupted
   │             │            │              │
   ▼             ▼            ▼              ▼
 failed       failed       unknown ◀─────────┘      (dispatching também → unknown)
(nada enviado) (nada enviado)  │
                               └─▶ running | completed | failed | interrupted   só com evidência do provedor
```

O status `unknown` nunca é resolvido por inferência. A partir do E4, o **motivo** de um `unknown` pode ficar mais preciso com evidência posterior (`refineUnknownReason`), mas o status continua `unknown`: evidência sobre a causa não é evidência sobre o resultado.

**Reconciliação explícita** (`POST /api/runs/:id/reconcile` → `reconciliation: { result, reason_code }`):

| Situação | Resultado | Contato com a VM |
| --- | --- | --- |
| Codex, o provedor lê o estado do turno | `confirmed` (`reconciled`) ou `unconfirmed` (`provider_reports_unknown`) | sim (`thread/read`) |
| Claude, o processo que executava o turno ainda vive nesta instância | `confirmed` ou `unconfirmed` | não (memória do processo) |
| Claude depois de uma queda do processo ou de um reinício do Cockpit | `unconfirmed` (`provider_cannot_confirm`) | **não**: uma conexão nova não sabe nada (`reconcile: "process"`) |
| Prompt possivelmente enviado, sem id de execução devolvido | `unconfirmed` (`provider_run_unbound`) | não |
| Codex com o app-server de uma instância anterior (órfão) ainda vivo na mesma VM (F2, D10) | `unconfirmed` (`orphan_owns_turn`): o run fica `unknown`, nada é reatado | **não**: a reconciliação não consulta o provedor enquanto o órfão viver. Depois do `kill <pid>`, a próxima reconciliação consulta o provedor normalmente |
| Codex com o registro de processos ilegível (falha de leitura do banco) (F2) | `unconfirmed` (`orphan_check_unavailable`): falha fechada, o run fica `unknown` | não |

## 3. Falhas distinguidas

| Situação | Estado | Motivo |
| --- | --- | --- |
| Cockpit morto abruptamente (kill -9, crash) e reiniciado | `unknown` | `process_restarted` |
| Cockpit encerrado de forma ordenada (Ctrl+C/SIGTERM) | `unknown` | `cockpit_shutdown` |
| Conexão ou transporte com a VM caiu (Codex) | `unknown` | `transport_lost` |
| Processo do agente terminou durante o turno (Claude) | `unknown` | `provider_session_lost` |
| **VM parada ou ausente** no discovery feito logo após a queda | `unknown` | **`vm_stopped`** |
| Turno passou do tempo máximo (Claude) | `unknown` | `turn_time_limit` |
| Envio ou decisão sem confirmação | `unknown` | `dispatch_unconfirmed` / `approval_delivery_unconfirmed` |
| Falha comprovadamente antes do envio | `failed` | código classificado; nada foi enviado |
| VM fora antes do envio | — | `409 target_unavailable`; nenhum run é criado |

O `vm_stopped` vem de uma única consulta ao discovery logo após a queda. Se a VM aparece em execução, ou se o discovery falha, o motivo original fica, e o log registra `run.loss_classified` com `vm_running` ou `discovery_failed`.

## 4. Posse exclusiva do banco de runtime

Ao abrir o banco, depois de abrir o arquivo e **antes** de migração ou recuperação, o `RuntimeStore` procura em `/proc/*/fd` outro processo com o mesmo arquivo aberto (comparando dispositivo e inode). Se encontrar, recusa com `runtime_database_in_use`: a instância viva continua intacta.
- Duas instâncias que iniciam ao mesmo tempo se veem e param as duas, o que é seguro.
- Os descritores do SQLite são close-on-exec, então os próprios filhos `msb` do Cockpit nunca contam. Isso foi verificado com processos reais, e por isso o reinício do E0 não é afetado.
- Uma instância antiga, de antes do E4, também é detectada, porque o critério é o arquivo aberto e não uma tabela de lease.
- Fora do Linux, `runtime_ownership: "not_verified"` aparece na linha `listening`.

## 5. Processos órfãos

- **Schema v5**: tabela aditiva `child_processes`, com PID, instante de início no kernel, identidade do dono, tipo (`codex_app_server`, `claude_session`, `claude_command`), VM e id da sessão do provedor. Não guarda argv nem conteúdo.
- A migração vale só a partir do v4 exato, numa única transação. A cadeia v1 → v5 roda numa única abertura, e as linhas existentes ficam intactas.
- Todo filho real `msb` é registrado quando é criado e esquecido quando sai.
- No start seguinte:

| Encontrado | Ação |
| --- | --- |
| Dono ainda vivo (outra instância) | não mexe |
| Processo morto, ou PID reutilizado (outro instante de início) | esquece |
| Processo vivo com a mesma identidade | **órfão** |

- **Efeitos de um órfão:**
  - aparece em "Precisa de você", com PID, tipo e o que bloqueia;
  - gera o log `process.orphan_detected`;
  - bloqueia `startRun` com `409 orphan_process_alive` para a **mesma sessão Claude** ou para a **VM inteira**, no caso do app-server do Codex. Nada é criado nem enviado.
- O bloqueio é reavaliado a cada leitura e some assim que o processo termina.
- **O Cockpit nunca sinaliza um órfão.** O efeito de matar o `msb exec` dentro da VM não é observável daqui, então quem decide é o operador (`kill <pid>`).
- A reconciliação não é bloqueada: o fluxo comprovado no E0 (matar, reiniciar, reconciliar) continua igual.

## 6. Histórico parcial após interrupções e quedas

A cada trecho recebido, se o intervalo de 1 s ainda não passou, fica agendada **uma** gravação de cauda. Ela é cancelada quando o run termina. Assim, uma pausa no streaming não deixa texto só em memória, e o limite "um `kill -9` perde no máximo ~1 s de texto", documentado no E3.1, passa a valer também durante as pausas. A forma final continua substituindo a parcial, e um item concluído nunca volta a parcial. Na interface, quando um run vira `unknown`, o histórico persistido é recarregado e mostra "Resposta incompleta" sem precisar de F5.

## 7. Métricas e logs

- O dashboard (autenticado) ganha `reliability`, com contadores desde o start e medidores atuais:
  - **contadores**: `runs_dispatched`, `dispatch_failed`, `dispatch_unconfirmed`, `dispatch_blocked_orphan`, `transport_lost`, `provider_session_lost`, `vm_stopped`, `approval_delivery_unconfirmed`, `transitions_rejected`, `transcript_write_failed`, `reconcile_confirmed`, `reconcile_unconfirmed`;
  - **medidores**: `orphan_processes`, `provider_connections`, `active_runs`, `approval_handles`.
- Novos eventos de log: `run.dispatch_blocked`, `run.loss_classified`, `run.transition_rejected`, `process.orphan_detected`, `process.ledger_recovered`, `process.ledger_failed` e `shutdown.repeated_signal`. A linha `listening` ganha `runtime_ownership`.
- Os logs carregam só códigos de vocabulário fechado, ids internos e contagens. Um teste roda um turno com segredo no prompt, aprovação e queda, e confirma que nem o segredo, nem o prompt, nem a resposta, nem o comando aparecem nos logs ou nas métricas.

## 8. Testes (278/278, typecheck limpo; eram 250)

- **`tests/e4-runtime-lease.test.ts`**: um processo real (`sleep` com o arquivo aberto) faz a segunda instância ser recusada sem tocar no estado vivo. Depois que ele sai, a próxima abertura recupera uma única vez. Os filhos do Cockpit nunca contam como donos. Uma plataforma sem `/proc` é reportada como `not_verified`.
- **`tests/e4-recovery.test.ts`** (CLI Claude roteirizado, `tests/support/`): cobre
  - cauda persistida durante uma pausa;
  - parcial completa e incompleta depois de um "kill -9";
  - nenhuma ressurreição de parcial;
  - `provider_session_lost`, `vm_stopped` (VM parada ou ausente) e discovery com falha;
  - reconciliação sem contato com a VM depois de uma queda ou de um reinício, e `provider_run_unbound`;
  - aprovação de um turno interrompido que não alcança o turno seguinte;
  - aprovações que não sobrevivem ao processo nem ao reinício;
  - decisão repetida entregue uma única vez;
  - logs sem conteúdo.
- **`tests/e4-process-ledger.test.ts`** (processos `sleep` reais e o `/proc` real): cobre
  - órfão detectado, bloqueio por sessão ou VM, e desbloqueio quando o processo sai;
  - PID reutilizado e dono vivo, que são ignorados;
  - falhas do ledger, que nunca quebram um spawn;
  - migração v4 → v5;
  - envio recusado sem criar run e alerta só para projetos com permissão.
- **`tests/e4-homologation.test.ts`**: roda o drill completo (abaixo) e confere que o relatório não carrega segredo, conteúdo, ids nem caminhos.
- **`tests/frontend.test.ts`**: card de processo órfão, envio bloqueado explicado, `vm_stopped` e reconciliação sem evidência explicada.
- Ajustes em testes existentes: as asserções de migração passam a esperar v5. Os testes HTTP de Codex e Claude também verificam o campo `reconciliation`. Nenhuma expectativa antiga foi removida.

## 9. Homologação no Arch: comando único

Na raiz do checkout, com o Bun 1.4.4 pinado:

```sh
./scripts/cockpit e4-homologation
```

**O que faz:**
1. Roda o typecheck e a suíte completa.
2. Roda o drill de recuperação com **processos reais do Cockpit em modo simulado**:
   - (a) inicia uma instância e confirma a posse exclusiva;
   - (b) faz o agente simulado transmitir uma resposta longa e confirma que a parcial está no SQLite;
   - (c) tenta uma segunda instância nos mesmos dados: ela deve ser recusada enquanto a primeira mantém o run;
   - (d) aplica **SIGKILL** no meio do streaming e reinicia;
   - (e) depois do reinício, confere:
     - run `unknown` (`process_restarted`);
     - texto transmitido preservado e marcado incompleto;
     - prompt uma única vez;
     - retry com a mesma chave devolvendo o mesmo run;
     - reconciliação `unconfirmed` com motivo;
     - alerta visível;
   - (f) envia SIGTERM duplo, e a instância deve sair com 0;
   - (g) testa o ledger de órfãos com processos `sleep` controlados e o `/proc` real.

**Por que é seguro:**
- Modo mock: não chama `msb`, não usa VM, não envia prompt real nem consome quota.
- Usa uma porta escolhida pelo sistema, um diretório próprio e descartável em `.cache/e4-homologation/` (removido no PASS) e um token aleatório que nunca é impresso.
- Ignora as variáveis `COCKPIT_*` de quem chama.
- Os Cockpits em execução (8787/8788, `data/`) nunca são contatados, sinalizados nem abertos. O único contato é a leitura do `/proc` feita pela verificação de posse.
- Só os processos criados pelo próprio drill recebem sinais.

**Resultado:** a saída é um JSON com PASS, FAIL ou NOT_VERIFIED por verificação, só com códigos e contagens. Exit `0`, `1` ou `2`. Com `COCKPIT_E4_KEEP=yes`, os dados do drill são mantidos em caso de falha, para diagnóstico. Registre em `docs/evidence/e4-arch.md` só o veredito por verificação.

## 10. Riscos e limitações remanescentes

- **Claude: um turno interrompido por queda nunca é confirmado.** O canal stream-json não lê transcripts nem estado de turno, então fica `unknown` (`provider_cannot_confirm`) para sempre. O operador confere na VM. Isso é uma limitação real da CLI, não algo a contornar.
- **O que acontece na VM ao matar o `msb exec`** (o processo remoto morre ou não) não foi observado. Por isso o Cockpit nunca mata órfãos. O tempo de vida real de um órfão também não foi medido no Arch: `claude -p` tende a sair no EOF do stdin depois do turno, e o app-server do Codex tende a sair no EOF.
- **Órfãos de instâncias anteriores ao E4** não estão no registro e não podem ser detectados. Só os filhos criados com o código do E4 em diante são registrados.
- **Codex reconciliado como `running`** depois de um reinício (lacuna L4): **resolvido na F2 (D10)** enquanto o app-server antigo estiver vivo e registrado como órfão. A reconciliação devolve `orphan_owns_turn` sem consultar o provedor e o run fica `unknown`, sem segurar o lock do projeto. Novos envios na VM continuam recusados com `409 orphan_process_alive` até o órfão terminar (regra do E4). Se o registro não puder ser lido, a reconciliação de runs Codex falha fechada (`orphan_check_unavailable`). Continua em aberto o caso em que o órfão já terminou, ou não foi registrado (filho de antes do E4, host sem `/proc`), e o provedor ainda lê o turno como `inProgress`: aí o comportamento do E0 continua, reatando e prendendo o projeto até o reinício ou a interrupção. Isso pode acontecer logo depois do `kill <pid>`, porque o efeito dentro da VM de matar o `msb exec` não foi observado. Por isso o operador confirma na VM que a tarefa terminou **antes** de encerrar o órfão. Também continuam abrindo um app-server ao lado do órfão as leituras do histórico, da lista de threads e a abertura de sessão. São só leitura e não mudam o estado de nenhum run. Veja `docs/f2-prova-provider-real.md` §5.
- **Prazo de aprovação**: a expiração por tempo (12 h) só é aplicada quando alguém tenta decidir. O provedor continua esperando, e o run aparece "aguardando você" até ser interrompido.
- **Um `unknown` some da caixa "Precisa de você"** quando a sessão recebe um run mais novo. Ele continua no histórico do run, mas não existe um "ciente" explícito.
- A posse exclusiva e o registro de processos dependem do `/proc` do Linux. Processos de **outro usuário** com o arquivo aberto não são visíveis, mas o banco é 0600 num diretório 0700.
- Um `kill -9` ainda perde até ~1 s do texto transmitido. O desligamento ordenado não perde nada.
- **Rollback**: um banco migrado para o v5 é recusado (`foreign_runtime_database_denied`) por código anterior ao E4, como já acontecia do v4 para o E3. Para voltar atrás, preserve uma cópia de `data/` antes do primeiro start com o E4.
- O drill homologa o **Cockpit** no host real (processos, sinais, `/proc`, SQLite e sistema de arquivos do Arch), com agentes simulados. Ele não exercita o Claude nem o Codex reais, por exigência do E4 (sem prompts reais e sem tocar nas VMs).
