# Runbook mínimo do Engineering Cockpit

Este runbook consolida a §11 do [master plan](master-plan.md). Ele vale para o Cockpit local no Arch, em loopback, com um operador. Regra geral: **o Cockpit nunca reenvia prompts nem decisões sozinho**. Antes de repetir qualquer coisa, confira o estado na VM.

| Situação | O que significa | Ação |
| --- | --- | --- |
| Run **Não confirmado** (`unknown`) | O Cockpit perdeu o contato durante o turno (queda, reinício, transporte, VM parada) e não sabe o resultado | Clique em **Reconciliar**. Se vier `unconfirmed`, confira o resultado dentro da VM. Nunca reenvie sem checar. No Claude, depois de uma queda ou reinício, o resultado é sempre `unconfirmed` (`provider_cannot_confirm`), porque o canal não lê o estado do turno. No Codex, enquanto o app-server de antes da queda estiver vivo na VM, o resultado é `unconfirmed` (`orphan_owns_turn`). Confirme **dentro da VM** que a tarefa terminou, só então rode `kill <pid>` do card "Processo órfão" e reconcilie de novo. Se o órfão for encerrado com a tarefa ainda rodando, a reconciliação seguinte pode reatar o run sem eventos (lacuna aberta, E4 §10). `orphan_check_unavailable`: o registro de processos não pôde ser lido; nada foi consultado. Veja `process.ledger_failed` nos logs |
| **Processo órfão** em "Precisa de você" (`409 orphan_process_alive` no envio) | Um filho `msb exec` de uma instância anterior continua vivo e pode estar executando um turno na VM | Confira o resultado na VM e depois rode `kill <pid>` no host, com o PID mostrado no card. O bloqueio some sozinho quando o processo termina. O Cockpit nunca sinaliza órfãos |
| `runtime_database_in_use` no start | Outra instância viva usa o mesmo diretório de dados | Não force. Encontre e encerre a outra instância ou use outro `data/`. As duas instâncias que iniciam ao mesmo tempo param, o que é seguro |
| `provider_version_unsupported` (Codex) | A versão do App Server não está em `SUPPORTED_CODEX_APP_SERVER_VERSIONS` (`src/codex-adapter.ts`), e o Cockpit falha fechado | Siga "Upgrade do Codex" abaixo |
| `provider_version_unsupported` / `provider_capability_missing` (Claude) | `claude --version` falhou, o major é < 2 (`MIN_CLAUDE_MAJOR`) ou faltam flags exigidas no `--help` | Confira a instalação do CLI dentro da VM. O Cockpit não instala nada |
| `provider_auth_required` (Claude) | `claude auth status` dentro da VM reporta que não há login | O operador faz login **dentro da VM**. O Cockpit não lê nem copia credenciais |
| `foreign_runtime_database_denied` no start | O banco tem outro schema ou outra aplicação, por exemplo um código anterior ao E4 abrindo o schema v5 | Não apague o banco. Volte ao código correspondente ou restaure a cópia de `data/` (veja "Voltar atrás") |
| Sessão HTTP expirada (volta para o login) | F1: a sessão termina após 30 min sem uso da página (teclado, mouse, toque, ou uma ação) ou 12 h após o login. Polling e stream não contam. Um aviso aparece no topo 5 min antes. Um reinício do Cockpit revoga todas as sessões | Entre de novo com a credencial local. Uma nova aba reaproveita a sessão de uma aba aberta da mesma porta |
| VM aparece como **Sem suporte** | O Cockpit vê a VM mas não a opera. Pode ser provider sem adapter (ex.: `opencode-*`). Uma VM de projeto **reservado** nem aparece em Agentes: o projeto aparece como *Reservado* em **Projetos** | Nada a fazer no Cockpit. Reservas (ADR-0004): `claude-engineering-cockpit` sempre; `COCKPIT_RESERVED_VMS`, e cada VM reservada reserva o projeto inteiro para todos os providers (P-D4); `COCKPIT_RESERVED_PROJECTS`. Para reservar mais, edite o arquivo de configuração do serviço e reinicie. Liberar a VM ou o projeto de desenvolvimento é decisão do Tech Lead (D8) e exige mudança de código |
| Serviço não sobe: `startup_failed` com `exit_status: 78` nos logs | Início recusado e **não** reiniciado de propósito: configuração inválida, arquivo de credencial com permissão errada, porta ocupada ou `runtime_database_in_use` (outro Cockpit no mesmo diretório de dados) | `./scripts/cockpit service doctor` mostra o item em FAIL. Corrija e rode `./scripts/cockpit service start`. Não force a posse do banco |
| Serviço caiu e voltou sozinho | `Restart=on-failure`: reinício após queda, no máximo 3 em 5 min | Igual a uma queda do E4: runs em andamento ficam **Não confirmado** e filhos `msb` sobreviventes aparecem como órfãos. Nada foi reenviado. Entre de novo no navegador |
| Órfãos continuam vivos depois de `service stop` | `KillMode=process`, de propósito: o systemd não mata filhos `msb` que sobraram de uma queda, porque podem estar executando um turno. O `stop` encerra só o Cockpit; os filhos do próprio Cockpit ele encerra em ordem | Antes de parar, confira "Precisa de você". Órfãos listados ali: confira a VM e rode `kill <pid>`. Com o serviço parado: `pgrep -af "msb exec"` |

## Serviço systemd de usuário (F1)

O Cockpit pode rodar como serviço do próprio usuário, sem terminal aberto. Nada é instalado, habilitado ou iniciado sem um destes comandos. Todos rodam do checkout que o serviço vai usar:

| Comando | O que faz |
| --- | --- |
| `./scripts/cockpit service install [--force] [--import-env-token]` | Gera três arquivos e faz `daemon-reload`. Não habilita nem inicia nada (detalhes abaixo) |
| `./scripts/cockpit service doctor` | Diagnóstico só leitura. Não exibe a credencial |
| `./scripts/cockpit service start` / `restart` | Roda o doctor, recusa iniciar se houver item bloqueante e espera `/api/health` responder |
| `./scripts/cockpit service stop` | SIGTERM só para o Cockpit, que encerra os próprios filhos em ordem |
| `./scripts/cockpit service status` / `logs [-f]` | Estado, PID, reinícios, URL. Logs do journal (JSON, sem credencial, sem prompts) |
| `./scripts/cockpit service enable` / `disable` | Iniciar ou não com a sessão do usuário. Opcional |
| `./scripts/cockpit service token-path` | Caminho do arquivo da credencial **configurado** em `cockpit.env` (`COCKPIT_LOCAL_TOKEN_FILE`), para copiar ao fazer login (ex.: `wl-copy < "$(./scripts/cockpit service token-path)"`). Nunca o conteúdo |
| `./scripts/cockpit service rotate-token` | Nova credencial no arquivo **configurado** em `cockpit.env`, gravada atomicamente e verificada. Em falha, a anterior é restaurada e a rotação é relatada como falha. Recusa se a configuração ou o arquivo não estiverem privados e válidos. Com o serviço rodando, a anterior continua aceita até `service restart`, que revoga todas as sessões. Com o serviço parado, vale no próximo `start` |
| `./scripts/cockpit f1-systemd-smoke` | Smoke real do systemd no Arch (F1-D). Unit de runtime isolada, porta, dados e credencial próprios. Não toca no serviço instalado nem em outro Cockpit. Limpa tudo ao fim, também em Ctrl+C; um remanescente de execução interrompida é removido na próxima. A VM de teste pode ser `codex-*` ou `claude-*` (nunca uma VM de projeto reservado: a de desenvolvimento, as de `COCKPIT_RESERVED_VMS` e suas VMs irmãs do mesmo projeto, e as de `COCKPIT_RESERVED_PROJECTS`, do shell **ou** do `cockpit.env` do serviço instalado, que o smoke só lê). Ctrl+C para a execução, limpa e imprime o relatório uma vez (saída 1, `interrupted`). Com `COCKPIT_SMOKE_ORPHAN_PROOF=yes` e `COCKPIT_SMOKE_QUOTA_CONFIRMED=yes` envia **um prompt real** à VM de teste (F1-P1 e F2). Veja `docs/f1-operacao-diaria.md` §6 e `docs/f2-prova-provider-real.md` §5 |
| `./scripts/cockpit service uninstall` | Remove a unit (recusa se ativa). Mantém configuração, credencial e dados |

O `install` gera:
- a credencial em `~/.config/engineering-cockpit/token` (0600): gerada só se ainda não existir; com `--import-env-token`, passa a ser a de `COCKPIT_LOCAL_TOKEN` do shell, substituindo a anterior;
- a configuração não secreta em `~/.config/engineering-cockpit/cockpit.env` (0600), lida das variáveis do shell (`COCKPIT_MODE`, padrão `host`, `COCKPIT_PROJECTS_BASE`, `COCKPIT_ALLOWED_PROJECTS`, opcional desde a [ADR-0004](adr-0004-descoberta-e-autorizacao-de-projetos.md), `PORT`, padrão 8787, `COCKPIT_DATA_DIR`, `COCKPIT_RESERVED_VMS`, `COCKPIT_RESERVED_PROJECTS`, `COCKPIT_UI_GRANTS`) e com o `PATH` do Bun 1.4.4 e do `msb`. Só é regravada com `--force`;
- a unit `~/.config/systemd/user/engineering-cockpit.service`.

Regras:
- **Projetos:** os diretórios de `COCKPIT_PROJECTS_BASE` aparecem na tela **Projetos**; os que não estão em `COCKPIT_ALLOWED_PROJECTS` são autorizados (e revogados) na própria página, com confirmação, CSRF e auditoria em `<data>/runtime-<modo>/grants.sqlite`. Detalhes em [projetos-descoberta.md](projetos-descoberta.md).
- **Preserve o histórico:** se o Cockpit em terminal usa o `data/` de outro checkout, instale com `COCKPIT_DATA_DIR=<caminho absoluto desse data>`. Sem isso, o serviço usa o `data/` do checkout onde a unit foi gerada.
- **Uma instância por banco:** pare o Cockpit do terminal antes de iniciar o serviço sobre o mesmo `data/`. Se não parar, o serviço é recusado com 78 e o doctor mostra o PID dono.
- **Voltar ao terminal:** `./scripts/cockpit service stop` (e `disable`, se habilitado). Depois, o `./scripts/cockpit start` de sempre. A F1 não muda o schema do banco.

## Upgrade do Codex (versão nova do App Server)

O pin é proposital (decisão D7): cada versão só entra depois que o formato de `initialize` e `thread/list` foi observado.

1. No Arch, com uma VM Codex de teste já `Running`, rode o diagnóstico read-only. Ele faz só `initialize → thread/list(limit=1) → close` e o relatório mostra apenas nomes de campos e tipos:
   ```sh
   COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes COCKPIT_E0_DIAGNOSE_CONFIRMED=yes \
   COCKPIT_DIAGNOSE_VM=<vm-codex-de-teste> ./scripts/cockpit protocol-diagnose; echo "exit=$?"
   ```
2. Exit `0` (PASS estrutural, sem divergência bloqueante): em uma branch, acrescente a versão a `SUPPORTED_CODEX_APP_SERVER_VERSIONS`. Adicione uma fixture em `fixtures/m0b/` e um teste, como foi feito para a 0.166.0 em `docs/e0-homologacao.md`. Rode `./scripts/cockpit verify` e `./scripts/cockpit artifact` e faça o commit.
3. Exit `1` (divergência bloqueante): não fixe a versão. O adapter precisa de mudança. Até lá, mantenha o CLI anterior na VM.
4. Exit `2`: pré-condição não atendida (confirmação, VM ausente ou parada). Nada foi verificado.

## Voltar atrás (rollback)

- O E4 migra o banco de runtime para o **schema v5**, e o código anterior ao E4 recusa esse banco. Antes de iniciar uma versão que migra o schema, guarde uma cópia de `data/` com o Cockpit parado. Para voltar, pare o Cockpit, restaure a cópia e faça checkout do commit anterior.
- A identidade visual v1.1 não altera o banco nem a API. Reverter só a UI não exige restaurar `data/`.

## Verificações locais (sem VM, sem quota)

| Comando | O que prova |
| --- | --- |
| `./scripts/cockpit verify` | typecheck e suíte determinística |
| `./scripts/cockpit artifact --check` | o manifesto `docs/artifact.sha256` confere com código, fixtures, locks e README |
| `./scripts/cockpit f1-accept hermetic` | tudo o que a F1 prova sem o host: typecheck, suíte, drill E4, Chromium (Codex, marca, duas abas, Claude, `kill -9`, timers de sessão) e manifesto; relatório em `.cache/f1-acceptance/` |
| `./scripts/cockpit f1-accept real-readonly` | no Arch, só leitura do serviço **instalado** (unit carregada, privilégios, loopback, journal). Com `COCKPIT_F1_ACCEPT_CONFIRMED=yes ... --with-login`, mais um login, uma leitura de contadores e um logout. Veja `docs/f1-aceite-automatizado.md` |
| `./scripts/cockpit e4-homologation` | suíte e drill de recuperação com processos reais do Cockpit em modo simulado (veja `docs/e4-confiabilidade.md` §9) |
| `CHROMIUM=$(command -v chromium) bun scripts/visual-check.ts <dir>` e `bun scripts/brand-visual-check.ts <dir>` | fluxos de UI no Chromium headless contra o Cockpit mock (opcional, só na máquina de desenvolvimento) |
