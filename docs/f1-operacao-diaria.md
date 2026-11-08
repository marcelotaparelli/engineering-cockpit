# F1 — Operar todo dia

**Branch:** `feat/f1-daily-ops`, a partir do `develop` `60644bd`. **Escopo:** §7 do [master plan v2](master-plan.md), lacunas L2, L3, L5 e L6. **Decisões:** [ADR-0003](adr-0003-f1-sessao-deslizante-e-servico.md).
**Estado:** implementada e verificada **nesta VM (Debian, modo mock)**. A homologação no Arch (um dia de uso real) está **pendente**, sem nenhum atestado registrado. Nada foi instalado nem iniciado no Arch.

## 1. Previsto × implementado

| Item do master plan (§7 F1) | Implementado | Onde |
| --- | --- | --- |
| L2 sessão deslizante, ociosa 30 min, máx. 12 h | sim. Renovação só por atividade do operador (ver divergência no ADR-0003 §1) | `src/local-security.ts`, `src/server.ts` (nenhuma rota nova) |
| V1 §8.4 nova aba reaproveita a sessão | sim, por `BroadcastChannel` da mesma origem | `public/app.js` |
| Indicador de sessão | sim: aviso no topo só nos últimos 5 min | `public/index.html`, `public/app.js`, `public/style.css` |
| L3 serviço systemd de usuário, token em arquivo 0600 | sim: `service install/start/stop/restart/status/doctor/logs/enable/disable/token-path/rotate-token/uninstall` | `tools/systemd/cockpit.service`, `src/service.ts`, `scripts/service.ts`, `scripts/cockpit`, `src/config.ts` |
| L5 stream sem perda quando o histórico recarrega | sim | `public/app.js` |
| L6 estado `unsupported` no lugar de `offline` | sim ("Sem suporte" + motivo) | `src/dashboard.ts`, `public/app.js`, `public/style.css` |
| D8 `COCKPIT_RESERVED_VMS` | sim, só para **acrescentar** VMs reservadas; a VM de desenvolvimento fica sempre reservada. A D8 continua do Tech Lead | `src/config.ts`, `src/execution.ts`, `src/claude-adapter.ts`, `src/claude-protocol.ts` |
| Testes `local-security`, `server`, `frontend`, unit file gerado | sim, mais o teste de processo do serviço | `tests/f1-*.test.ts`, `tests/local-security.test.ts`, `tests/frontend.test.ts` |
| Revisão independente da política de sessão (Codex) | **não**: houve revisão independente por outro agente (Claude), §4. A do Codex continua pendente | — |
| Aceite no Arch: um dia de uso real sem terminal | **pendente** (operador) | §6 |

**Fora do escopo, não feito:** F2 (L4/L8), F3 (CI), F4 (tiles, "ciente"), persistência de sessões HTTP entre reinícios (o ADR-0002 mantém a revogação no restart), novas telas e novas métricas.

## 2. Comportamento

### Sessão
- **Encerramento:** a sessão termina 30 min após a última atividade do operador ou 12 h após o login.
- **O que é atividade:** uma ação confirmada por CSRF, ou entrada real na página (teclado, ponteiro, roda, toque). A entrada é informada ao servidor no máximo 1×/min, por `X-Session-Activity: user` em `GET /api/auth/session`.
- **O que não é atividade:** polling, SSE e heartbeats. Uma aba esquecida expira, e o stream é fechado no prazo.
- **Aviso:** "Sessão expira em N min sem atividade" ou "Sessão termina em N min (limite de 12 h)", nos últimos 5 min.
- **Nova aba:** reaproveita a prova de uma aba aberta da mesma porta. Logout numa aba devolve as outras ao login.
- **Reinício do Cockpit:** revoga todas as sessões. O login é necessário de novo, como antes.

### Serviço
O `install` só escreve arquivos e faz `daemon-reload`. A unit:
- reinicia apenas após queda (até 3 em 5 min);
- nunca reinicia um início recusado (status 78: configuração, credencial, porta, banco de outra instância);
- no stop, manda SIGTERM só para o Cockpit e não mata os filhos `msb` após uma queda, que continuam visíveis como órfãos (E4);
- usa `NoNewPrivileges`, `UMask=0077` e a credencial fora do ambiente e da linha de comando.

### Stream (L5)
- **Causa:** o histórico recarregado apagava os nós ao vivo, e os deltas seguintes recomeçavam um nó vazio. Deltas chegados durante a requisição do histórico também se perdiam.
- **Correção:** o texto recebido por item fica fora do DOM, limitado a 64 itens × 256 KiB, e é combinado com o prefixo persistido, sem duplicar a sobreposição. O texto de outras sessões também é guardado, então trocar de sessão no meio da resposta não perde nada. Uma conclusão substitui o texto, e um delta tardio não ressuscita uma cópia.

## 3. Verificação (executada nesta VM, Bun 1.4.4, modo mock)

| Verificação | Resultado |
| --- | --- |
| `bun run typecheck` | limpo |
| `./scripts/cockpit verify` | **321 pass / 0 fail**: 283 anteriores + 38 da F1 |
| `./scripts/cockpit e4-homologation` | 321 pass; drill **PASS 11/11**, overall `PASS` |
| `scripts/visual-check.ts` (fluxo Codex) | **23/23 PASS** |
| `scripts/brand-visual-check.ts` (marca, 390–1440) | **23/23 PASS** |
| `scripts/f1-visual-check.ts` (novo: BroadcastChannel real entre duas abas, L5, L6, credencial em arquivo) | **12/12 PASS** |
| Controle negativo: `f1-visual-check` com o `public/app.js` do `develop` | L5 e "nova aba" **FAIL**, como esperado |
| Reprodução da L5 em teste antes da correção (`tests/frontend.test.ts`) | 3 testes falhavam ("o agente" em vez de "Olá, eu sou o agente"); passam após a correção |
| Filhos `Bun.spawn` herdam o descritor do SQLite? | **não** (`procDatabaseHolders` vazio após SIGKILL do pai com o filho vivo): um reinício com órfãos vivos não é recusado por posse do banco |
| `systemd-analyze verify` da unit gerada (systemd 252) | sem avisos |
| `./scripts/cockpit artifact --check` | PASS, após regenerar o manifesto (inclui `tools/systemd`) |

Testes novos, por requisito do brief:

| Requisito | Testes |
| --- | --- |
| reinício do serviço, retomada do uso | `tests/f1-service-process.test.ts`: o Cockpit é iniciado como a unit o inicia; SIGKILL → reinício pela política da unit; o run em voo fica `unknown`; nada é reenviado; o operador usa de novo; SIGTERM → 0, sem reinício |
| instância duplicada | mesmo teste: a segunda instância sai com 78 (`runtime_database_in_use`), não é reiniciada, e a primeira e seu run ficam intactos; `doctor` acusa o PID dono (`tests/f1-service.test.ts`) |
| configuração ausente ou inválida | `tests/f1-config.test.ts` (arquivo de credencial: permissões, link, diretório aberto, formato, ambiguidade, `COCKPIT_RESERVED_VMS`); `tests/f1-service.test.ts` (install recusa antes de escrever); teste de processo (credencial 0644 → 78) |
| expiração e renovação | `tests/local-security.test.ts` (F1), `tests/f1-session-http.test.ts` (HTTP real, relógio injetado, SSE fechado no prazo) |
| revogação e CSRF | `tests/f1-session-http.test.ts` (logout, CSRF forjado não renova, teto de 12 h, fixação); `tests/local-security.test.ts` (replay por 1000 mutações) |
| preservação do banco e das sessões | teste de processo: mesma sessão, mesmo run, parcial preservado após a queda |
| interface operacional | `tests/frontend.test.ts` (11 testes F1: L5 ×6, atividade, aviso, nova aba, logout entre abas, "Sem suporte"); `scripts/f1-visual-check.ts` |

## 4. Revisão de segurança

**Revisão independente:** outro agente (Claude), em modo só leitura, sem receber as conclusões do autor. Ele leu todo o diff e rodou 65 testes (65 pass). **Nenhum achado alto.** Os achados e o tratamento:

| # | Sev. | Achado | Tratamento |
| --- | --- | --- | --- |
| 1 | média | `COCKPIT_RESERVED_VMS` vazio ou com erro de digitação desprotegia `claude-engineering-cockpit` | **corrigido**: a VM de desenvolvimento fica sempre reservada; a variável só acrescenta. Testes em `tests/f1-config.test.ts` |
| 2 | baixa | `mergeText`: `includes` podia descartar um delta curto, e uma sobreposição espúria de 1–2 caracteres podia "comer" texto | **corrigido**: sem `includes`; sobreposição só com ≥ 8 caracteres; sem evidência, concatena. O resíduo transitório está em §5 |
| 3 | baixa | Histórico lido antes da conclusão sobrescrevia a resposta já concluída | **corrigido**: o item concluído recebido ao vivo prevalece sobre uma cópia mais curta. Teste com controle negativo |
| 4 | baixa | Delta tardio após o fim do run recriava um fragmento | **corrigido**: deltas de runs encerrados são ignorados. Teste com controle negativo |
| 5 | baixa | Gravações da unit e da credencial não atômicas; `.tmp` órfão; unit invisível se o `XDG_CONFIG_HOME` do shell diferir do gerenciador | **corrigido**: gravação atômica (temp `O_EXCL|O_NOFOLLOW` + fsync + rename, temp removido em falha) para credencial, configuração e unit; doctor `unit_loaded` (FAIL se o systemd usa outra unit, WARN se não carregou). **Aceito**: a janela `lstat(dir)`/`open` em `readLocalCredentialFile` só é explorável por quem já escreve no `~/.config` do próprio usuário |
| 6 | info | `KillMode=process` deixa órfãos de uma queda vivos após `stop` | **documentado** no runbook (linha "Órfãos continuam vivos depois de `service stop`") |
| 7 | info | Filhos herdam o socket ou o descritor do SQLite? | verificado pelo revisor e pelo autor: **não**. O reinício após queda com órfãos vivos não é recusado |
| 8 | info | Teto de 4096 nonces sem decaimento; ao atingi-lo, até o logout falha | aceito: equivale a uma mutação a cada 10 s por 12 h; novo login resolve |

**Áreas sem achado** (avaliação do revisor, conferida pelo autor):
- renovação só por CSRF ou pelo sinal de atividade, e o teto de 12 h é inviolável;
- sem fixação de sessão;
- CSRF, Origin e vínculo cookie+prova inalterados;
- `BroadcastChannel` restrito à origem, sem laço;
- credencial fora da unit, do argv, do ambiente e dos logs;
- sem injeção no arquivo de configuração nem na unit;
- toda operação de VM passa por `revalidate` → `supports()`.

**Pendente:** a revisão da política de sessão pelo Codex, pedida pelo master plan §7.

Autoverificação do autor:
- **Logs:** o teste de processo confere que a credencial não aparece em stdout/stderr de nenhuma instância (válida, recusada, reiniciada).
- **Doctor:** nunca imprime o conteúdo da credencial (teste).
- **Navegador:** o check visual confere que a credencial não fica no DOM nem no storage.
- **Manifesto:** `artifact --check` PASS.

## 5. Riscos e limitações

- **Nada disto foi executado no Arch.** Não foram executados no Arch: systemd real, `KillMode=process` com `msb` real, `NoNewPrivileges` com `msb`, linger, Chromium/Firefox do operador. A unit foi verificada com systemd 252 (Debian); o Arch usa uma versão mais nova.
- **`NoNewPrivileges=yes`:** se o `msb` do Arch depender de binário setuid (não esperado), `msb exec` falha. O sintoma aparece no doctor/logs como erro de transporte. Remover a linha da unit resolve.
- **`KillMode=process`:** é proposital (órfãos visíveis, E4). Versões futuras do systemd podem emitir aviso sobre esse modo.
- **Sessões em memória:** reinício e queda pedem novo login. É a decisão do ADR-0002, mantida.
- **Atividade:** quem lê uma resposta longa por mais de 30 min sem tocar na página precisa entrar de novo. O aviso de 5 min existe para isso.
- **Nova aba:** só funciona com uma aba autenticada aberta na mesma porta. Navegadores sem `BroadcastChannel` pedem login.
- **L5:** se a página abrir no meio de uma resposta e o histórico persistido estiver atrás do que já foi transmitido (intervalo de flush de 1 s do Claude), pode faltar um trecho no meio até a resposta terminar. Na conclusão o texto final substitui tudo. Uma correção exata exigiria o servidor enviar o deslocamento de cada delta. Isso não foi feito (fora do escopo de UI da F1) e fica como melhoria possível.
- **Mock do Claude:** as sessões vivem na memória do processo, então `--resume` de uma sessão anterior à queda falha no modo simulado. Por isso o teste de processo retoma o uso com sessão nova. O CLI real guarda as sessões no disco da VM.
- **Dados:** o serviço usa o `data/` do checkout onde foi instalado, salvo `COCKPIT_DATA_DIR`. A F1 não muda o schema.

## 6. Homologação no Arch (operador)

**Pré-condição:** nenhuma execução de agente em andamento quando for trocar o Cockpit do terminal pelo serviço. Os passos A e B não tocam no Cockpit em uso.

**A. Suíte, drill e manifesto** (seguro: sem msb, sem VM, sem quota, sem tocar no Cockpit em uso)
```sh
cd <checkout da branch feat/f1-daily-ops> && ./scripts/cockpit bootstrap && ./scripts/cockpit e4-homologation && ./scripts/cockpit artifact --check
```
Esperado: 321 pass, drill `"overall": "PASS"` e `PASS artifact manifest`.

**B. Serviço em modo simulado, isolado** (porta 8788 e dados próprios, sem VM)
```sh
COCKPIT_MODE=mock COCKPIT_ALLOWED_PROJECTS=demo,lab PORT=8788 COCKPIT_DATA_DIR="$HOME/.local/state/engineering-cockpit-f1-mock" \
  ./scripts/cockpit service install
./scripts/cockpit service doctor && ./scripts/cockpit service start && ./scripts/cockpit service status
```
No navegador, em `http://127.0.0.1:8788`:
1. Entre com o conteúdo de `$(./scripts/cockpit service token-path)`.
2. Abra uma segunda aba: ela não pede login.
3. Mande um prompt com "lento" e clique de novo no agente durante o stream: nenhum caractere some.
4. Saia numa aba: a outra volta ao login.

Depois, com uma resposta "lenta" em andamento, simule a queda:
```sh
systemctl --user kill -s SIGKILL engineering-cockpit.service
sleep 8; ./scripts/cockpit service status
```
Esperado: ativo de novo, `reinícios: 1`. Depois de novo login, o run aparece como **Não confirmado**, sem reenvio.

Por fim, `./scripts/cockpit service stop`.

**C. Serviço real** (decisão do operador; substitui o Cockpit do terminal)
1. Pare o Cockpit do terminal (Ctrl+C) e guarde uma cópia do diretório de dados que ele usa:
   ```sh
   cp -a <data em uso> <data em uso>.bak-f1
   ```
2. No mesmo shell em que você iniciava o Cockpit, com as mesmas variáveis:
   ```sh
   COCKPIT_DATA_DIR=<caminho absoluto do data em uso> PORT=8787 ./scripts/cockpit service install --force --import-env-token
   ```
   Com `--import-env-token`, a credencial atual (`COCKPIT_LOCAL_TOKEN`) é mantida. Sem a opção, uma nova é gerada.
3. `./scripts/cockpit service doctor && ./scripts/cockpit service start`. Opcional: `./scripts/cockpit service enable`.
4. **Aceite** (master plan §7):
   - um dia de uso real com Codex e Claude, sem terminal (exceto para iniciar VMs);
   - `reliability` sem contadores inesperados;
   - capturas de tela;
   - registro em `docs/evidence/f1-arch.md`, separando o executado do atestado.

**Voltar atrás:** `./scripts/cockpit service stop` (e `disable`, se habilitado), depois o `./scripts/cockpit start` de sempre. O banco é compatível, porque a F1 não migra o schema.
