# E0 — homologação real no Arch (VM Codex exclusiva de testes)

**Estado final (2026-11-07): E0 ENCERRADO — E0-D7 PASS real no Arch** (ver “Resultado real” no fim). O texto abaixo é o roteiro original de homologação, mantido como referência.

## 1. Diagnóstico desta rodada

| Achado | Evidência | Ação |
| --- | --- | --- |
| **Bloqueio certo:** o gate de versão só aceitava 0.163.0/0.164.0; o Arch tem 0.166.0 → `initialize` falharia com `provider_version_unsupported` antes de qualquer coisa | `SUPPORTED_CODEX_APP_SERVER_VERSIONS` em `src/codex-adapter.ts` | Fixado **0.166.0** (única mudança de comportamento). 0.165.0 e 0.167.0 continuam rejeitados (teste) |
| 0.166.0 é estruturalmente compatível com o que o adapter usa | (a) `codex app-server generate-json-schema` do CLI 0.166.0: `InitializeResponse` com os mesmos 4 campos; `Thread{id,status,updatedAt}`, `Turn`, `TurnStatus`, `ThreadStatus`, `AskForApproval="on-request"`, params/decisões de approval (`accept`/`decline`), notificações usadas. (b) Execução **real** do `codex 0.166.0` local (CODEX_HOME vazio e temporário) pelo `MsbStdioTransport` + adapter reais: framing sem `jsonrpc` aceito, `initialize` com os 4 campos, `thread/list` ok, `thread/start` ok | Validators **não** foram relaxados |
| Campos aditivos no 0.166.0 em `thread/list` (`backwardsCursor`, `readStates`, campos extras na thread) | idem (b) | Ignorados pelo adapter; o diagnóstico os lista como não-bloqueantes |
| **Comportamento novo a conhecer:** numa thread **recém-criada e sem nenhum turno**, `thread/read(includeTurns)` e `thread/resume` falham com `-32601 "list_turns is not supported yet"`; depois de materializada, funcionam | probe local (b) | Sem correção necessária: sessão nova não faz `resume` (já é marcada carregada) e a UI degrada para "Histórico indisponível (provider_request_failed)… acompanhada ao vivo". **Não é FAIL** na etapa 2. Efeito residual: reabrir/resumir uma thread que nunca recebeu prompt falha — esperado |
| Não verificável sem a VM real | — | `turn/start`, streaming, approvals, interrupt com Codex 0.166.0 + modelo real só existem no Arch (etapas 4–8) |

Mudanças no repositório: `src/codex-adapter.ts` (pin + exports), `src/protocol-diagnose.ts`, `scripts/protocol-diagnose.ts`, subcomando `./scripts/cockpit protocol-diagnose`, `fixtures/m0b/codex-0.166.0.json`, `tests/protocol-diagnose.test.ts`. `./scripts/cockpit verify` → typecheck 0, **145 pass / 0 fail**.

## 2. Diagnóstico read-only (`protocol-diagnose`)

`initialize` → `initialized` → `thread/list(limit=1)` → fecha. Sem `thread/start`, `turn/*`, prompt ou HTTP. Exige consentimento exato, host Arch, VM Codex **já `Running`** (não inicia nada). Saída: só nomes de campos, tipos, tags de enum e a versão. Nunca valores, ids, caminhos, nome da VM ou conteúdo.

## 3. Provisionar a VM de testes (você executa)

Nome fixo: **projeto `cockpit-e0-test` → VM `codex-cockpit-e0-test`**. Não é `codex-engineering-cockpit` nem toca `claude-engineering-cockpit`. Projeto novo ⇒ diretório de código e `state/codex/cockpit-e0-test` novos; só `shared/codex-auth` é compartilhado (risco já documentado).

**Limite do que sei:** os launchers (`codex-sandbox.sh`) não estão neste repositório e eu não os li. Não invento sua CLI. Faça primeiro a leitura (sem efeito):

```sh
# 3.0 localizar e ler o launcher SEM autodeploy (nada é executado)
type -a codex-sandbox.sh 2>/dev/null || ls ~/sandboxes/agent/*.sh ~/bin/*sandbox* 2>/dev/null
sed -n 1,80p "$(command -v codex-sandbox.sh)"   # confirme como ele escolhe o <projeto> (argumento ou diretório atual) e se tem 'status'

# 3.1 inventário antes (guarde para comparar no final)
msb list --format json > /tmp/e0-msb-before.json
```

Autorizado por você, **só depois de confirmar em 3.0 que o projeto é derivado do diretório/argumento**:

```sh
# 3.2 projeto descartável (diretório novo e vazio)
mkdir -p ~/sandboxes/agent/projects/cockpit-e0-test && cd ~/sandboxes/agent/projects/cockpit-e0-test && git init -q

# 3.3 subir a VM com o launcher existente, a partir DESTE diretório (ajuste à sintaxe vista em 3.0).
#     Ele abre um shell interativo; saia com 'exit' — a VM permanece Running.
codex-sandbox.sh
```

Verifique: `msb list --format json | grep -c codex-cockpit-e0-test` ⇒ 1, e que `/tmp/e0-msb-before.json` vs lista atual só difere por essa VM nova.
**Se o launcher não derivar o projeto como esperado ou tocar outra VM: pare e me traga a saída — não improvise.**

## 4. Roteiro PASS/FAIL

Todos os comandos da raiz do repositório no Arch.

### Etapa A — diagnóstico (antes de subir o Cockpit)
```sh
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes COCKPIT_E0_DIAGNOSE_CONFIRMED=yes \
COCKPIT_DIAGNOSE_VM=codex-cockpit-e0-test ./scripts/cockpit protocol-diagnose; echo "exit=$?"
```
- **PASS:** exit 0, `"overall":"PASS"`, `server_version":"0.166.0"`, `version_pinned:true`, nenhuma divergência com `blocking:true`.
- **FAIL (exit 1):** `reason` = `version_not_pinned` (versão diferente de 0.163/0.164/0.166 na VM), `structural_divergence` (lista dos campos) ou código de transporte. **Pare e me envie o JSON** (ele é seguro para colar).
- exit 2 = pré-condição (consentimento, VM ausente/parada). Não é aceite.

### Etapa B — smoke M0b.1a existente (opcional, redundante com A)
`COCKPIT_M0B1A_SMOKE_CONFIRMED=yes COCKPIT_SMOKE_VM=codex-cockpit-e0-test` com os mesmos `COCKPIT_MODE/HOST_CONFIRMED` e `./scripts/cockpit m0b1a-smoke` ⇒ PASS esperado (exit 0).

### Etapa C — subir o Cockpit isolado ao projeto de teste
```sh
export COCKPIT_LOCAL_TOKEN=$(openssl rand -hex 32); echo "$COCKPIT_LOCAL_TOKEN"   # digite no login
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes \
COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" \
COCKPIT_ALLOWED_PROJECTS=cockpit-e0-test PORT=8787 \
./scripts/cockpit start 2>&1 | tee /tmp/e0-cockpit.log
```
`COCKPIT_ALLOWED_PROJECTS` contém **somente** o projeto de teste: as VMs `*-engineering-cockpit` não ficam executáveis.

### Etapa D — no navegador (`http://127.0.0.1:8787`)
Use a palavra-canário `CANARIO-E0-7731` nos prompts (para a checagem de logs).

| # | Ação | PASS | FAIL |
| --- | --- | --- | --- |
| D1 | Login com o token. Painel mostra `codex-cockpit-e0-test` como executável; **nenhuma** `*-engineering-cockpit` selecionável | VM de teste executável, as outras não | token rejeitado; VM de produção executável |
| D2 | "Nova sessão" | sessão ativa abre. "Histórico indisponível (provider_request_failed)" ou "Sessão sem mensagens ainda" são **aceitáveis** (seção 1) | erro de versão/protocolo, sessão não abre |
| D3 | Enviar: `Responda apenas com a palavra OK. CANARIO-E0-7731` | texto chega **em streaming**, estado final "Concluído" | sem resposta, "Falhou", travado em "Trabalhando" > 2 min |
| D4 | Recarregar (F5) | histórico e estado voltam; nenhum prompt reenviado (conferir que existe **1** mensagem do usuário) | histórico vazio após turno concluído, ou prompt duplicado |
| D5 | Enviar `Escreva um texto de 3000 palavras sobre a história da computação.` e, durante o streaming, "Interromper" | estado "Interrompido"; novo envio posterior funciona | continua "Trabalhando", ou erro sem estado final |
| D6a | Enviar `Tente executar o comando: touch /etc/e0-approval-probe` | item em "Precisa de você" → **Rejeitar** → turno segue/encerra, sem execução | nenhum item de aprovação **e** o comando executou |
| D6b | Enviar `Execute: curl -sI https://example.com` | item em "Precisa de você" → **Aprovar** → comando roda, resultado aparece | aprovação não chega/não resolve, ou resolve duas vezes |
| D7 | Durante um prompt longo (como D5) mate o Cockpit (Ctrl-C), suba de novo (Etapa C, mesmo token **novo** é aceitável), reabra a sessão | run em "Não confirmado" → "Reconciliar" → estado real (Concluído/Interrompido), **sem reenvio** | prompt reenviado, ou "Reconciliar" não resolve |

D6a/D6b dependem de o modelo realmente pedir a ação e de o sandbox da VM exigir aprovação sob `on-request`. Se nenhuma aprovação surgir e a ação foi bloqueada/recusada pelo modelo, marque **INCONCLUSIVO** (não PASS) e tente outro comando fora do workspace; se o comando executou sem pedir, é FAIL a me reportar.

### Etapa E — higiene e isolamento (após D)
```sh
grep -c 'CANARIO-E0-7731' /tmp/e0-cockpit.log            # PASS = 0 (prompt/resposta não vão para o log)
grep -c "$COCKPIT_LOCAL_TOKEN" /tmp/e0-cockpit.log       # PASS = 0
msb list --format json > /tmp/e0-msb-after.json; diff <(jq -S . /tmp/e0-msb-before.json) <(jq -S . /tmp/e0-msb-after.json)
                                                         # PASS = só a VM codex-cockpit-e0-test adicionada
git -C ~/sandboxes/agent/projects/engineering-cockpit status --short   # PASS = inalterado vs. antes
```

## 5. Critério de aceite E0
**PASS** = A + D1…D5 + D7 PASS, D6a e D6b PASS (ou INCONCLUSIVO justificado, com pelo menos um approval real resolvido), E com 0 ocorrências/diferenças inesperadas. Qualquer FAIL ⇒ traga o JSON da etapa A, o trecho do log (sem conteúdo) e o `code` exibido na UI; não prossiga para E1.

## 6. Bloqueios que dependem do operador
1. Ler o launcher (3.0) e **autorizar** a criação/início de `codex-cockpit-e0-test` (3.2–3.3). Eu não conheço a CLI exata do launcher.
2. Autenticação do Codex via `shared/codex-auth` precisa estar válida na VM nova; sem isso D3 falha por autenticação do provider (não é defeito do Cockpit). Prompts D3–D7 usam o modelo real (custo/quota).
3. Se a VM do Arch reportar versão ≠ 0.163/0.164/0.166, A falha com `version_not_pinned`: fixar a nova versão exige o JSON de A (nunca relaxar para "qualquer versão").
4. Riscos residuais herdados e não tratados aqui: janela TOCTOU do `msb exec --stream` em VM parada; `shared/codex-auth` cruzando projetos; sessão local expira em 30 min.

## D7 automatizado (`e0-recovery-test`)

Substitui o D7 manual. No Arch, na raiz do repositório, com o Cockpit E0 **rodando** (host, `COCKPIT_ALLOWED_PROJECTS=cockpit-e0-test`, token em arquivo `0600`):

```sh
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes COCKPIT_E0_RECOVERY_CONFIRMED=yes \
COCKPIT_PORT=<porta do Cockpit> COCKPIT_TOKEN_FILE=<caminho absoluto do arquivo do token> \
./scripts/cockpit e0-recovery-test; echo "exit=$?"
```

Sequência: pré-condições → 1 prompt (consome quota; `sleep 300`) → run ativo confirmado → `SIGKILL` só do PID identificado (porta + comando `bun src/index.ts` + cwd + env) → reinício com o mesmo comando/cwd/env → `unknown/process_restarted` → reconcile → sem reenvio. Recusa (sem tocar em nada) se faltar consentimento, houver run ativo, o processo não for o Cockpit E0, outra VM for executável ou o token não corresponder. Se o reinício falhar, tenta de novo; ao final interrompe o comando de teste se ainda ativo. Saída: JSON sanitizado, `exit 0` = PASS. Log do servidor reiniciado: `.cache/e0-cockpit-restart.log`.


## Resultado real (Arch, reportado pelo operador) — E0 encerrado

| Item | Resultado |
| --- | --- |
| E0-D7 (recuperação após `SIGKILL` do Cockpit, reconciliação sem reenvio/duplicação) | **PASS real** |
| Codex 0.166.0 | homologado (pin em `SUPPORTED_CODEX_APP_SERVER_VERSIONS`) |
| Login, sessões, prompts reais, histórico | funcionando |
| Interrupção | validada |
| Aprovação e rejeição reais | validadas |
| Testes automatizados | 160 pass / 0 fail (reproduzido no checkpoint; typecheck 0) |

**Ressalvas conhecidas (não bloqueiam E1):**
1. **Streaming incremental não foi comprovado isoladamente** no Arch (só indiretamente, pelos prompts reais). Fica como item de validação pendente.
2. `codexErrorInfo` → classe de erro (`usage_limit`, `auth`, …) segue o *schema* do app-server, **ainda não observado ao vivo** no 0.166.0. Variantes desconhecidas permanecem sem classificação (`provider_turn_error`/`provider_turn_failed`), nunca inferidas do texto.
3. Thread recém-criada sem turno: `thread/read` e `thread/resume` falham com `-32601 list_turns is not supported yet` (comportamento do Codex; a UI degrada para "Histórico indisponível").
4. Riscos herdados, sem mudança: TOCTOU do `msb exec --stream` em VM parada; `shared/codex-auth` cruza projetos; sessão local expira em 30 min.

**Revisão de segurança/higiene/observabilidade do E0:** sem pendência relevante. Logs não contêm prompt/resposta/token (checagem da etapa E feita pelo operador; classes de erro vêm de códigos estruturados e a mensagem bruta do provider não é persistida — teste `e2e-execution`). Ambiente de CI local: o `.bun-version` exige Bun 1.4.4; com outro Bun, 17 testes de host-check/smoke falham pelo gate de versão (não é defeito do código).
