# E3 — Aceite no Arch (Claude Code pelo navegador)

**Fonte:** atestado do operador. A primeira mensagem é de 2026-11-08 09:11 UTC, no brief do E3.1. O mesmo resultado foi repetido no kickoff do E4 (10:16 UTC) e no brief da revisão do master plan v2 (14:04 UTC). Não há saída bruta, JSON nem capturas do Arch neste workspace. Nenhuma sessão de desenvolvimento (Debian) reproduziu o teste com o Claude real. Por isso este registro é **atestado manual do operador**, e não execução automatizada. O formato segue `docs/evidence/e31-historico-arch.md`.

Ambiente informado pelo roteiro (`docs/e3-claude-code.md`, "Roteiro de homologação no Arch"): instância isolada `./scripts/cockpit e3-homologation`, porta 8788, `data/e3-homologation/`, VM `claude-cockpit-e2-test`, ACL `cockpit-e2-test`. O operador **não informou** a versão do Claude Code usada no E3. O E2 rodou com a 2.1.319.

## Resultado atestado, por item

| Item do roteiro E3 (passo 2) | O que o operador atestou | Classificação |
| --- | --- | --- |
| (a) Prompt e resposta, com **streaming incremental** | "Prompts […] funcionando"; "Envio e resposta" | envio e resposta **atestados**. O streaming *incremental* não foi informado em separado: **não comprovado** |
| (b) `Bash` → card com o comando → **Rejeitar** | "aprovações, rejeições […] funcionando"; "Aprovação de Bash", "Rejeição de Bash" | **atestado** (aprovação e rejeição). Qual aviso apareceu (nenhum, "Negado automaticamente" ou "Executado sem aprovação") não foi informado |
| (c) `AskUserQuestion` → card de pergunta → responder | "AskUserQuestion funcionando" | **atestado** |
| (d) Prompt longo → **Interromper**; o próximo prompt funciona | "Interrupção funcionando"; "Continuidade da sessão após interrupção funcionando" | **atestado** |
| (e) Ctrl+C durante um prompt → run "Não confirmado", nada reenviado | não informado | **sem resultado**. Não se atribui PASS nem FAIL |
| (f) Novo prompt na mesma sessão depois do reinício → retoma com contexto | "Após reiniciar o servidor Cockpit, a sessão anterior reaparece"; "O Claude preserva o contexto: respondeu corretamente 'Segurança' sobre uma escolha anterior" | **atestado** para reinício com retomada de contexto. Não foi informado se o reinício ocorreu durante um prompt, como pede o passo (e) |

**Problema relatado no mesmo atestado:** depois do reinício, a interface mostrava "Sessão sem mensagens ainda", embora a conversa existisse. Esse problema originou o E3.1 (`5f5b566`, histórico persistente), aceito no Arch conforme `docs/evidence/e31-historico-arch.md`.

## Commit sob teste

O operador não informou o commit. Fatos verificáveis no Git:
- O comando `e3-homologation` e a correção da rota de permissões (`--permission-prompt-tool stdio`) entraram no commit `ea2f4e5`, de 2026-11-08 09:13:52 UTC.
- A mensagem do operador com o atestado é de 09:11 UTC, cerca de 2 min antes desse commit.

A árvore exata testada, portanto, **não é identificável por commit**. O que se sabe é que o teste exigia o comando e a correção que hoje estão em `ea2f4e5`.

## O que continua não comprovado
- **Streaming incremental** com o Claude real. No E2 havia 1 delta e `incremental=false`, e o E3 não informou esse ponto em separado.
- **Recuperação após Ctrl+C durante um prompt** (passo e): run `unknown`, nada reenviado. Esse comportamento está coberto por testes com o Claude falso, mas não foi atestado com o Claude real.
- **Queda abrupta (`kill -9`) com o Claude real.** Fica para a F2 do master plan, registro previsto em `docs/evidence/e4-claude-real-arch.md`.
- **Formato exato dos frames** `can_use_tool`, `system/permission_denied` e `result.permission_denials`. Ele foi conferido só por leitura estática do CLI 2.1.319. O atestado funcional (aprovação, rejeição e resposta funcionando) indica que o CLI aceitou as respostas do Cockpit, mas nenhum frame foi registrado. No código, essas formas continuam marcadas `UNVERIFIED` (`src/claude-protocol.ts:85,93,127`).
- **Classificação real de quota e autenticação** (`ERROR_CLASS`). Não é forçável sem esgotar a quota.
- **Versão mínima testada do Claude Code.** Hoje o adapter exige major ≥ 2 e a presença das flags.
