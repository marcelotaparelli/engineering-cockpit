# Runbook mínimo do Engineering Cockpit

Este runbook consolida a §11 do [master plan](master-plan.md). Ele vale para o Cockpit local no Arch, em loopback, com um operador. Regra geral: **o Cockpit nunca reenvia prompts nem decisões sozinho**. Antes de repetir qualquer coisa, confira o estado na VM.

| Situação | O que significa | Ação |
| --- | --- | --- |
| Run **Não confirmado** (`unknown`) | O Cockpit perdeu o contato durante o turno (queda, reinício, transporte, VM parada) e não sabe o resultado | Clique em **Reconciliar**. Se vier `unconfirmed`, confira o resultado dentro da VM. Nunca reenvie sem checar. No Claude, depois de uma queda ou reinício, o resultado é sempre `unconfirmed` (`provider_cannot_confirm`), porque o canal não lê o estado do turno |
| **Processo órfão** em "Precisa de você" (`409 orphan_process_alive` no envio) | Um filho `msb exec` de uma instância anterior continua vivo e pode estar executando um turno na VM | Confira o resultado na VM e depois rode `kill <pid>` no host, com o PID mostrado no card. O bloqueio some sozinho quando o processo termina. O Cockpit nunca sinaliza órfãos |
| `runtime_database_in_use` no start | Outra instância viva usa o mesmo diretório de dados | Não force. Encontre e encerre a outra instância ou use outro `data/`. As duas instâncias que iniciam ao mesmo tempo param, o que é seguro |
| `provider_version_unsupported` (Codex) | A versão do App Server não está em `SUPPORTED_CODEX_APP_SERVER_VERSIONS` (`src/codex-adapter.ts`), e o Cockpit falha fechado | Siga "Upgrade do Codex" abaixo |
| `provider_version_unsupported` / `provider_capability_missing` (Claude) | `claude --version` falhou, o major é < 2 (`MIN_CLAUDE_MAJOR`) ou faltam flags exigidas no `--help` | Confira a instalação do CLI dentro da VM. O Cockpit não instala nada |
| `provider_auth_required` (Claude) | `claude auth status` dentro da VM reporta que não há login | O operador faz login **dentro da VM**. O Cockpit não lê nem copia credenciais |
| `foreign_runtime_database_denied` no start | O banco tem outro schema ou outra aplicação, por exemplo um código anterior ao E4 abrindo o schema v5 | Não apague o banco. Volte ao código correspondente ou restaure a cópia de `data/` (veja "Voltar atrás") |
| Sessão HTTP expirada (volta para o login) | A sessão local dura 30 min absolutos (`src/local-security.ts`), e uma nova aba exige novo login | Faça login de novo com a credencial local. A expiração deslizante é a F1 do master plan |

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
| `./scripts/cockpit e4-homologation` | suíte e drill de recuperação com processos reais do Cockpit em modo simulado (veja `docs/e4-confiabilidade.md` §9) |
| `CHROMIUM=$(command -v chromium) bun scripts/visual-check.ts <dir>` e `bun scripts/brand-visual-check.ts <dir>` | fluxos de UI no Chromium headless contra o Cockpit mock (opcional, só na máquina de desenvolvimento) |
