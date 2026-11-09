# Projetos: descoberta automática e autorização pela interface

**Branch:** `feat/project-discovery` · **Worktree (VM de desenvolvimento):** `/worktrees/cockpit-project-discovery` · **Base:** `develop` `1ea3806`
**Decisão de arquitetura:** [ADR-0004](adr-0004-descoberta-e-autorizacao-de-projetos.md). **Não integrado**, sem push, merge ou deploy.

## 1. Experiência

1. O operador abre o Cockpit e entra com a credencial local, como antes.
2. Sem agente selecionado, o painel central mostra **Projetos**: todo diretório válido da pasta de projetos, com filtro e os autorizados primeiro. O botão **Projetos** no topo volta a essa tela a qualquer momento.
3. Cada cartão mostra:
   - o estado: *Autorizado*, *Autorizado · configuração*, *Não autorizado* ou *Reservado*;
   - um botão por agente: **Claude Code** e **Codex**.
4. Projeto não autorizado → **Autorizar** abre uma confirmação: "o Cockpit poderá abrir sessões e enviar prompts às VMs deste projeto que já existem. Nenhuma VM é criada ou ligada". Só **Confirmar autorização** envia a requisição.
5. Projeto autorizado → **Claude Code** ou **Codex** abre a sessão no fluxo existente (nova ou retomada). Um botão só fica ativo se a VM `claude-<projeto>`/`codex-<projeto>` existe, está ligada, não é reservada e o provider é suportado. Caso contrário, o botão diz por quê:

   | Situação | Texto do botão |
   |---|---|
   | VM parada | "VM parada: ligue pelo launcher (o Cockpit não liga VMs)" |
   | VM ausente | "Sem VM: crie pelo launcher (o Cockpit não cria VMs)" |
   | VM reservada | "VM reservada: o Cockpit não opera esta VM" |

   Uma VM parada com sessões anteriores ainda abre o histórico.
6. **Revogar acesso** (só para concessões da interface) também pede confirmação. Não apaga nada.

## 2. API

| Rota | Proteção | Resposta |
|---|---|---|
| `GET /api/catalog` | sessão (cookie + prova) | `{ projects: [{ name, present, authorized, grant: "config"\|"ui"\|null, granted_at, reserved, can_authorize, can_revoke, agents: [{ provider, vm_name, vm_state, status }] }], ui_grants, counts, discovery_error, observed_at }` |
| `POST /api/projects/:id/grant` | sessão + Origin + CSRF + nonce + corpo exato `{"confirm":"<id>"}` | `200 { project, action, changed, authorized, grant }`. Erros: `403 project_reserved`, `404 resource_not_found` (não descoberto agora), `409 grants_read_only`/`grant_limit_reached`, `503` (descoberta indisponível) |
| `POST /api/projects/:id/revoke` | idem | `200 …`. Erros: `409 grant_from_config`/`project_busy`/`orphan_process_alive`, `404` |

Valores de `status` de um agente: `ready`, `stopped`, `absent`, `reserved`, `unsupported`, `not_authorized`, `project_missing`, `unobserved`.

## 3. Operação no Arch (quando o Tech Lead decidir integrar)

**Instalação existente.** Nenhuma mudança obrigatória em `cockpit.env`: `COCKPIT_ALLOWED_PROJECTS` continua valendo, e seus projetos aparecem como *Autorizado · configuração*. Os demais diretórios aparecem para autorizar. Depois do merge, a nova versão só entra em uso com `./scripts/cockpit service restart`, que o operador executa (a restart revoga as sessões HTTP, como sempre). Na primeira partida, o arquivo `<data>/grants-host.sqlite` (0600) é criado.

**Instalação nova sem lista de projetos:**

```sh
COCKPIT_PROJECTS_BASE=$HOME/sandboxes/agent/projects ./scripts/cockpit service install
```

Sem `COCKPIT_ALLOWED_PROJECTS`, os projetos são autorizados na página.

**Desligar:** `COCKPIT_UI_GRANTS=off` em `cockpit.env` + restart. Volta ao comportamento anterior; as concessões gravadas são ignoradas, não apagadas.

**Proteger mais projetos:** `COCKPIT_RESERVED_PROJECTS=a,b` em `cockpit.env`. `engineering-cockpit` é sempre reservado.

**Ler a auditoria (somente leitura):**

```sh
sqlite3 -readonly "<data>/grants-host.sqlite" 'SELECT * FROM grant_audit ORDER BY seq DESC LIMIT 20'
./scripts/cockpit service logs | grep project_grant
```

**Rollback:** voltar ao commit anterior e reiniciar. A versão anterior não lê `grants-*.sqlite`, então valem só os projetos de `COCKPIT_ALLOWED_PROJECTS`, que precisa voltar a ser não vazio.

## 4. Testes automatizados

| Arquivo | O que prova |
|---|---|
| `tests/project-grants.test.ts` | Store 0600, schema exato, persistência, auditoria append-only (UPDATE/DELETE recusados), recusa de symlink (arquivo e diretório), arquivo compartilhado, banco estranho e linha adulterada, limite de 256. Regras: reservado nunca concedível, configuração nunca revogável, conjunto vivo (principal antigo vê concessão e revogação), concessão gravada que virou reservada não vale. Config/serviço: vazio aceito só com UI ligada. Catálogo: só diretórios + autorizados, status por provider, sem VM-fantasma |
| `tests/project-grants-http.test.ts` | Descoberta **real** sobre diretório temporário (com symlink para fora e nome inválido): 401 sem sessão; Origin, CSRF, prova, nonce repetido, corpo errado e GET recusados sem efeito; reservado 403; symlink, VM sem diretório e nome inventado 404; descoberta caindo 503 sem conceder; concessão vale na hora para a sessão aberta, é auditada sem segredo e persiste; revogação recusada com run ativo, efetiva depois (sessão e run voltam a 404), reconcedida traz a sessão de volta; stream SSE já aberto para de entregar eventos do projeto revogado (com controle positivo e teste de mutação: falha se o stream congelar os grants) |
| `tests/project-grants-startup.test.ts` | `src/index.ts` real (mock) **sem** `COCKPIT_ALLOWED_PROJECTS`: catálogo, autorizar, abrir sessão Codex **e** Claude Code, auditoria no log sem a credencial, arquivo 0600, persistência após SIGTERM + restart; `COCKPIT_UI_GRANTS=off` com lista vazia recusa a partida e com lista não permite autorizar |
| `tests/project-grants-race.test.ts` | Revogação durante a espera de `startRun` (revalidação da VM) → 404, **nenhum** run criado; durante `openSession` → 404, nenhuma sessão criada (achado 2 da revisão; falha sem a correção) |
| `tests/frontend.test.ts` (+5) | Tela inicial = seletor; ordem; botões desativados com o motivo; reservado sem "Autorizar"; confirmação antes de qualquer POST (cancelar não envia); um único POST com CSRF/nonce e corpo `{confirm}`; erros em linguagem simples; nomes/estados só como texto (sem injeção de marcação); "Projetos" volta ao seletor; login pelo formulário também abre o seletor |

Resultados: §5.

## 5. Resultados (executados nesta VM de desenvolvimento, 2026-11-09)

| Verificação | Resultado |
|---|---|
| Base `develop` `1ea3806`: `bun run typecheck` + `bun test` | 455 pass, 0 fail |
| Branch final: `bun run typecheck` + `bun test` | typecheck limpo; **478 pass, 0 fail** (47 arquivos, ~143 s) |
| Testes de regressão dos 3 achados da revisão | falham sem a correção (mutação: `git stash` de `src/`), passam com ela |
| Teste do stream SSE | falha se o stream congelar os grants na abertura (mutação), passa com o conjunto vivo |
| `scripts/projects-visual-check.ts` (Chromium headless, Cockpit **mock**) | 19/19 PASS: seletor como tela inicial, confirmação, autorizar, abrir Claude Code, voltar, 1440/1024/390 px sem overflow, revogar, console sem erro de JS/CSP, log sem credencial e com auditoria. Capturas em `docs/evidence/projetos-descoberta-mock/` |
| `scripts/visual-check.ts` (fluxo de sessão existente) | 23/23 PASS, sem regressão |

**Não executado (de propósito):**
- nada no Arch;
- nada contra o serviço da porta 8787, VMs reais, `msb`, credenciais ou bancos reais;
- nenhum prompt real.

O modo host foi exercitado só com descoberta real sobre diretório temporário e uma saída do `msb list` sintética (`tests/project-grants-http.test.ts`).

## 6. Revisão de segurança independente

**Quem e como:** um agente revisor novo (Claude), sem acesso às conclusões do implementador. Recebeu o diff `1ea3806..8fa2df0`, as alegações a verificar e o modelo de ameaça (ADR-0002/0003, `m0b1b-threat-model.md`). Rodou somente leitura no repositório, com PoCs em diretório temporário, sem tocar em VM, `msb`, serviço ou credencial. Não houve revisão pelo Codex nesta tarefa. É uma revisão Claude independente, a mesma forma aceita pelo Tech Lead como exceção na F1.

**Resultado:** nenhum achado crítico ou alto. Três defeitos reproduzidos, todos corrigidos neste branch, cada um com teste que falha sem a correção:

| # | Severidade | Achado | Correção |
|---|---|---|---|
| 1 | média | Concessão da UI ofuscada (projeto que virou reservado ou passou para a configuração) ficava dormente no SQLite, não era revogável pela UI e voltava escondida quando a configuração mudava | Removida na partida, com auditoria `revoke` de ator `system` e log `project_grant` |
| 2 | baixa/média | Revogação durante a espera de `startRun` criava e despachava um run num projeto já revogado, invisível ao operador (interromper e aprovações inacessíveis) | Grant relido de forma síncrona antes de `beginRun` e antes/depois do provider em `openSession` |
| 3 | baixa | Primeira partida interrompida deixava arquivo vazio, e toda partida seguinte falhava com `grant_store_denied` | Arquivo vazio, privado e próprio é inicializado |

**Informativos aceitos como risco residual** (ADR-0004 §6):
- VM reservada não reserva o projeto (decisão P-D4);
- run `unknown` não bloqueia a revogação;
- arquivo `-journal`/`-wal` regular plantado pelo mesmo UID;
- isolamento do `e0-recovery` só pelo ambiente.

A flag `reserved` no modo fixo agora respeita `COCKPIT_RESERVED_PROJECTS`.

**Propriedades confirmadas pelo revisor:**
- descoberta nunca concede;
- todas as proteções do POST;
- diretório verificado por `refresh()` autoritativo, sem link;
- reservado recusado no servidor e em `ProjectGrants`;
- configuração não revogável pela UI;
- conjunto de grants vivo em todas as verificações, inclusive replay e eventos ao vivo do SSE;
- endurecimento do store;
- nenhum segredo na auditoria ou nos logs;
- UI só com `textContent`;
- partida com `COCKPIT_UI_GRANTS=off` inalterada;
- e3 e smoke isolados;
- nenhuma criação ou partida de VM.
