# M0b Fatia 4: Discovery no Arch e workspace utilizável

**Estado (2026-11-07):** correção e nova interface implementadas e verificadas localmente (testes + Chromium real contra o modo mock). **Aceite no Arch: pendente.** Exige você executar o roteiro abaixo; nenhum MSB real foi acessado aqui.

## P0: `Discovery indisponível (invalid_vm_name)`

**Caminho:** `msb list --format json` → `parseVmList` (`src/parser.ts`) → `vmIdentity` (`src/model.ts`) → `Discovery` → `/api/dashboard` → painel.

**Causa:**
- O campo é `name` de cada registro do `msb list`.
- `parseVmList` aplicava a gramática de VM de agente, `^(codex|claude|opencode)-[a-z0-9][a-z0-9_-]{0,62}$`, a **todos** os registros.
- Lançava `invalid_vm_name` no primeiro registro que não era VM de agente: uma sandbox criada à mão (`msb run --name devbox`), de outra ferramenta, ou um `codex-<Projeto>` com maiúsculas ou ponto.
- Com isso, a lista inteira falhava e as VMs válidas (`codex-<projeto>`) sumiam.
- O smoke de 26/10 passou porque, naquele momento, todas as sandboxes do host seguiam o padrão.

**O valor exato no seu host não é visível daqui.** Rode `./scripts/cockpit discovery-report` (ver roteiro): ele mostra, para cada registro, o nome (escapado) e o motivo.

**Correção (sem relaxar a validação):**
- A gramática e `vmIdentity` estão iguais.
- Duplicatas, estados desconhecidos e linhas malformadas continuam derrubando a lista inteira (fail-closed).
- Registros cujo nome não é VM de agente agora são **ignorados um a um e só contados** (`not_agent_vm`, `invalid_project_name`). Esses nomes nunca chegam à API, a um grant ou ao `msb exec`.
- O painel mostra só contagens: VMs fora de `COCKPIT_ALLOWED_PROJECTS`, sandboxes ignoradas e nomes de projeto fora do padrão.
- Regressão em `tests/discovery-regression.test.ts`, com a lista real (`codex-charybdis-nano`, `claude-catus-2026`) mais sandboxes estranhas. **No código antigo, o painel retorna exatamente `discovery_error: "invalid_vm_name"`**; no novo, mostra a VM autorizada.

## P1: interface

| Problema observado | Causa / mudança |
| --- | --- |
| Login visível após autenticar | `#login { display: grid }` sobrepunha o atributo `hidden`. Regra global `[hidden] { display: none !important }`, com teste |
| Cartões desalinhados, espaço desperdiçado | Grid de 3 áreas com altura total; cada área rola sozinha |
| Estados confusos | Uma cor por estado em todo lugar (executando, aguardando, concluído, falha, não confirmado, offline). Topo com origem (SIMULAÇÃO/Host) e conexão (ao vivo/reconectando/offline) |
| Pouco adequado a vários agentes | Esquerda: projetos → VMs, com filtro. Centro: sessão com editor fixo. Direita: "Precisa de você" de todos os projetos, com contagem e "Abrir sessão" |

- **Estados distintos:** "Carregando agentes…", vazio com diagnóstico, erro de discovery com o código e a dica, e desconexão do SSE com o selo "reconectando…".
- **Mensagens e logs longos** rolam dentro da conversa; nunca causam overflow horizontal.
- **Até 900 px:** uma área por vez, com abas no topo (Agentes, Sessão, Precisa de você + contagem).
- Sem dependências novas; CSP inalterada.

## P2: evidência local

- `./scripts/cockpit verify`: typecheck ok, **139 testes, 0 falhas**.
- `scripts/visual-check.ts` roda o processo real em modo mock, controlado por um Chromium real via CDP. Resultado em [evidence/ui-2026-11-07/results.json](evidence/ui-2026-11-07/results.json): **23/23 PASS**.
  1. Login visível antes de autenticar e escondido depois.
  2. Discovery agrupado por projeto.
  3. Seleção do agente e nova sessão.
  4. Streaming e histórico.
  5. 1440, 1024 e 390 px sem overflow horizontal; editor visível; 3 áreas no desktop e abas no mobile.
  6. Refresh restaura a sessão sem nova execução (runs 2 → 2).
  7. Logs sem a credencial e sem prompts.

  Além disso: credencial fora do DOM e do storage, aprovação pela inbox, interromper, e zero erros de JS/CSP.
- Capturas: [login](evidence/ui-2026-11-07/01-login-1440.png), [1440](evidence/ui-2026-11-07/02-session-1440.png), [1024](evidence/ui-2026-11-07/02-session-1024.png), [390 sessão](evidence/ui-2026-11-07/02-session-390.png), [390 inbox](evidence/ui-2026-11-07/03-inbox-390.png), [390 agentes](evidence/ui-2026-11-07/04-agents-390.png), [após refresh](evidence/ui-2026-11-07/05-after-refresh-1440.png).

Para repetir (precisa de um Chromium local; não faz parte do `verify`):

```sh
CHROMIUM=$(command -v chromium) bun scripts/visual-check.ts /tmp/cockpit-visual
```

## Aceite no Arch (mínimo)

```sh
git switch develop
export COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes
export COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects"
export COCKPIT_ALLOWED_PROJECTS=charybdis-nano          # seus projetos, separados por vírgula, sem espaço

# 1. Diagnóstico somente leitura: um único `msb list`; nada é alterado.
./scripts/cockpit discovery-report
#    Espere "shown": N > 0. Para cada registro: o motivo (por exemplo, not_agent_vm para sandboxes avulsas).
#    Esta linha identifica o nome que causava invalid_vm_name.

# 2. Cockpit
export COCKPIT_LOCAL_TOKEN=$(openssl rand -hex 32); echo "$COCKPIT_LOCAL_TOKEN"
PORT=8787 ./scripts/cockpit start
```

Abra `http://127.0.0.1:8787` e confirme:

1. Depois do login, o formulário some.
2. Suas VMs aparecem à esquerda, agrupadas por projeto, sem "Discovery indisponível".
3. Clique na VM `codex-…` (ligada) → "Nova sessão" → envie um prompt inócuo → a resposta chega em streaming.
4. F5: a sessão e o histórico voltam e nada é reenviado.
5. Peça "rode os testes" → a aprovação aparece em "Precisa de você" → aprove ou rejeite.
6. Reduza a janela (ou use as DevTools, 390 px): aparecem as abas e não há rolagem horizontal.

Se o passo 1 mostrar `shown: 0`, o próprio relatório diz o motivo de cada VM: projeto fora de `COCKPIT_ALLOWED_PROJECTS`, diretório ausente, nome fora do padrão ou VM parada.
