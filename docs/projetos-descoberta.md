# Projetos: descoberta automática e autorização pela interface

**Branch:** `feat/project-discovery` · **Worktree (VM de desenvolvimento):** `/worktrees/cockpit-project-discovery` · **Base:** `develop` `1ea3806`
**Decisão de arquitetura:** [ADR-0004](adr-0004-descoberta-e-autorizacao-de-projetos.md). **Não integrado**, sem push, merge ou deploy.

## 1. Experiência

1. O operador abre o Cockpit e entra com a credencial local, como antes.
2. Sem agente selecionado, o painel central mostra **Projetos**: todo diretório válido da pasta de projetos, com filtro e os autorizados primeiro. O botão **Projetos** no topo (ou no cabeçalho da sessão, em telas estreitas) volta a essa tela a qualquer momento.
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
7. **Projeto reservado** (P-D4): `engineering-cockpit`, os de `COCKPIT_RESERVED_PROJECTS` e o projeto de qualquer VM de `COCKPIT_RESERVED_VMS`.
   - Aparece como *Reservado*, sem "Autorizar" e com todos os agentes desativados.
   - Se também está em `COCKPIT_ALLOWED_PROJECTS`, o cartão diz que essa entrada não tem efeito.
   - Nada dele é aberto, executado ou exibido. Um processo órfão dele continua visível em "Precisa de você", com PID, e o Cockpit nunca o encerra.

## 2. API

| Rota | Proteção | Resposta |
|---|---|---|
| `GET /api/catalog` | sessão (cookie + prova) | `{ projects: [{ name, present, authorized, grant: "config"\|"ui"\|null, granted_at, reserved, can_authorize, can_revoke, agents: [{ provider, vm_name, vm_state, status }] }], ui_grants, counts, discovery_error, observed_at }` |
| `POST /api/projects/:id/grant` | sessão + Origin + CSRF + nonce + corpo exato `{"confirm":"<id>"}` | `200 { project, action, changed, authorized, grant }`. Erros: `403 project_reserved`, `404 resource_not_found` (não descoberto agora), `409 grants_read_only`/`grant_limit_reached`, `503` (descoberta indisponível) |
| `POST /api/projects/:id/revoke` | idem | `200 …`. Erros: `409 grant_from_config`/`project_busy`/`orphan_process_alive`, `404` |

Valores de `status` de um agente: `ready`, `stopped`, `absent`, `reserved`, `unsupported`, `not_authorized`, `project_missing`, `unobserved`.

## 3. Operação no Arch (quando o Tech Lead decidir integrar)

Migração, compatibilidade com `COCKPIT_ALLOWED_PROJECTS` e rollback: **[ADR-0004 §5](adr-0004-descoberta-e-autorizacao-de-projetos.md#5-migração-compatibilidade-e-rollback)**.

**Antes do restart, conferir em `cockpit.env`** se algum projeto de `COCKPIT_ALLOWED_PROJECTS` coincide com o projeto de uma VM de `COCKPIT_RESERVED_VMS` ou com `COCKPIT_RESERVED_PROJECTS`. Pela P-D4 ele ficará bloqueado. Leitura apenas:

```sh
grep -E '^COCKPIT_(ALLOWED_PROJECTS|RESERVED_VMS|RESERVED_PROJECTS)=' ~/.config/engineering-cockpit/cockpit.env
```

**Instalação nova sem lista de projetos:**

```sh
COCKPIT_PROJECTS_BASE=$HOME/sandboxes/agent/projects ./scripts/cockpit service install
```

**Desligar a autorização pela página:** `COCKPIT_UI_GRANTS=off` em `cockpit.env` + restart. As concessões gravadas são ignoradas, não apagadas. As reservas continuam valendo.

**Reservar:** `COCKPIT_RESERVED_PROJECTS=a,b`, ou `COCKPIT_RESERVED_VMS=codex-a`, que reserva o projeto `a` inteiro. `engineering-cockpit` é sempre reservado.

**Ler a auditoria (somente leitura):**

```sh
sqlite3 -readonly "<data>/runtime-host/grants.sqlite" 'SELECT * FROM grant_audit ORDER BY seq DESC LIMIT 20'
./scripts/cockpit service logs | grep -E 'project_grant(_ignored)?'
```

## 4. Testes automatizados

| Arquivo | O que prova |
|---|---|
| `tests/project-grants.test.ts` | Store 0600, schema exato, persistência, auditoria append-only (UPDATE/DELETE recusados), recusa de symlink (arquivo e diretório), arquivo compartilhado, banco estranho e linha adulterada, limite de 256. Regras: reservado nunca concedível, configuração nunca revogável, conjunto vivo (principal antigo vê concessão e revogação), concessão gravada que virou reservada não vale. Config/serviço: vazio aceito só com UI ligada. Catálogo: só diretórios + autorizados, status por provider, sem VM-fantasma |
| `tests/project-grants-http.test.ts` | Descoberta **real** sobre diretório temporário (com symlink para fora e nome inválido): 401 sem sessão; Origin, CSRF, prova, nonce repetido, corpo errado e GET recusados sem efeito; reservado 403; symlink, VM sem diretório e nome inventado 404; descoberta caindo 503 sem conceder; concessão vale na hora para a sessão aberta, é auditada sem segredo e persiste; revogação recusada com run ativo, efetiva depois (sessão e run voltam a 404), reconcedida traz a sessão de volta; stream SSE já aberto para de entregar eventos do projeto revogado (com controle positivo e teste de mutação: falha se o stream congelar os grants) |
| `tests/project-grants-startup.test.ts` | `src/index.ts` real (mock) **sem** `COCKPIT_ALLOWED_PROJECTS`: catálogo, autorizar, abrir sessão Codex **e** Claude Code, auditoria no log sem a credencial, arquivo 0600, persistência após SIGTERM + restart; `COCKPIT_UI_GRANTS=off` com lista vazia recusa a partida e com lista não permite autorizar. **Reinícios com reserva nova:** concessão gravada de `demo` + restart com `COCKPIT_RESERVED_VMS=codex-demo` → removida com auditoria, sessão e histórico 404, `claude-demo` recusada, nova concessão 403; restart sem a reserva → não volta sozinha; `COCKPIT_ALLOWED_PROJECTS=demo` + `COCKPIT_RESERVED_PROJECTS=demo` → ignorado e registrado; `codex-vault` (VM inexistente) reserva `vault` |
| `tests/project-grants-live.test.ts` | 3ª/4ª verificação, provider simulado: (1) `turn/start` com resposta perdida, run `unknown` e turno vivo → revogação efetiva, mas *Execução sem acesso* listada sem IDs nem prompt; autorizar de novo devolve o run. (2) Revogação durante reconcile → 409; reconcile com autorização perdida no serviço → nada muda, nada é revivido. (3) Decisão de aprovação perdida → `interrupt` aceito (antes 409, projeto preso) → revogação. (4) Alerta só para o run mais recente de cada sessão, sem `vm_stopped`; órfão de projeto revogado listado com PID e sem sessão |
| `tests/project-grants.test.ts` (troca do arquivo) | Troca do store por um arquivo com hard link, 0644 e concessão plantada em **cada** `lstat` da sequência de abertura (subprocesso `tests/support/grant-store-swap.ts`): sempre recusada ou inócua |
| Ajustados à P-D4 | `f1-config` (lista efetiva cobre os 3 providers; reservar `codex-alpha` reserva `claude-alpha` no `ExecutionService` e no guarda do argv do Claude, sem casar prefixo), `e3-claude-execution` (projeto de desenvolvimento oculto e 404, não mais listado), `f1-systemd-smoke` (+3 casos: VM irmã reservada, projeto reservado, `codex-engineering-cockpit`), `e4-process-ledger` (stub de segurança trocado por `LocalSecurity` real), `discovery`/`host-check`/startup (fixture `vault`) |
| `tests/project-grants-race.test.ts` | Revogação durante a espera de `startRun` (revalidação da VM) → 404, **nenhum** run criado; durante `openSession` → 404, nenhuma sessão criada (achado 2 da 1ª revisão). Revogação com turno ainda vivo e run `unknown` (decisão de aprovação com entrega ambígua) → 409 `project_busy`; aceita quando o turno termina (F1 da 2ª revisão). Ambos falham sem a correção |
| `tests/project-reservations.test.ts` | P-D4 com descoberta real e pilha HTTP + execução real (providers simulados). **Derivação:** `codex-beta` reserva `beta` para os 3 providers, sufixo inteiro, nunca prefixo; valores vazios não liberam `engineering-cockpit`. **Matriz de rotas** com sessão, run `unknown` e aprovação pendente criados antes da reserva: sessão, histórico, envio, run, interromper, reconciliar e decidir → 404; inventário, VM, threads, `POST /api/sessions` (Claude e Codex), aprovações, painel, catálogo e SSE (com controle positivo) fechados; `revalidate` recusa antes de qualquer spawn; a concessão por configuração do projeto reservado é ignorada; o processo órfão do projeto reservado continua visível e não é encerrado. **Revogação** de sessões, runs e aprovações existentes, também para outra sessão do operador, sem apagar ou sinalizar nada. **Concorrência:** 16 concessões simultâneas = 1 mudança + 1 linha de auditoria; 20 concessões/revogações intercaladas terminam com memória = disco = última linha da auditoria, sem duas ações iguais seguidas. **CSRF na revogação:** ausente, de outra sessão, nonce repetido, content-type e Origin. **Sistema de arquivos:** diretório trocado por symlink, apagado, recriado, renomeado (a concessão não acompanha), symlink com nome válido não concedível, base trocada por symlink → 503 |
| `tests/frontend.test.ts` (+5) | Tela inicial = seletor; ordem; botões desativados com o motivo; reservado sem "Autorizar"; confirmação antes de qualquer POST (cancelar não envia); um único POST com CSRF/nonce e corpo `{confirm}`; erros em linguagem simples; nomes/estados só como texto (sem injeção de marcação); "Projetos" volta ao seletor; login pelo formulário também abre o seletor |

Resultados: §5.

## 5. Resultados (executados nesta VM de desenvolvimento, 2026-11-09)

**Fechamento: SHA final na entrega (ver §7).** O aceite hermético foi rodado no SHA final, com árvore limpa:

| Verificação | Resultado |
|---|---|
| `./scripts/cockpit f1-accept hermetic` | ver §7 (rodada final) |
| `scripts/projects-visual-check.ts` (Chromium, mock, com `COCKPIT_RESERVED_VMS=codex-vault`) | 21/21. Capturas em `docs/evidence/projetos-descoberta-mock/` |
| Mutação das camadas de reserva | removendo **só** os grants efetivos **ou só** `LocalSecurity.allows`, a matriz de rotas continua fechada; removendo as duas, falha. Isso revelou que a lista de sessões do painel, o replay e os eventos ao vivo do SSE dependiam só da 1ª camada; corrigido |
| Mutação dos achados das revisões | todos os testes de regressão dos achados das rodadas 1–4 falham com o código anterior à correção e passam com ela |
| `brand-visual-check` | pegou uma regressão do MVP (cabeçalho de 3 linhas em 390 px), corrigida |

**MVP (rodada anterior, `bc0cfd4`):** 478 pass. `projects-visual-check` 19/19 e `visual-check` 23/23.

**Não executado (de propósito):**
- nada no Arch;
- nada contra o serviço da porta 8787, VMs reais, `msb`, credenciais ou bancos reais;
- nenhum prompt real.

O modo host foi exercitado só com descoberta real sobre diretório temporário e uma saída do `msb list` sintética (`tests/project-grants-http.test.ts`).

## 6. Revisões de segurança independentes

Todas por agentes revisores novos (Claude), sem acesso às conclusões do implementador:
- somente leitura no repositório;
- PoCs em diretório temporário;
- sem VM, `msb`, serviço ou credencial.

Não houve revisão pelo Codex nesta tarefa: é a mesma forma aceita pelo Tech Lead como exceção na F1.

### 6.0 Terceira e quarta rodadas (verificação das correções)

**3ª rodada** (`9e5a6e8..8ed353c`): F2 e F3 confirmados. Reproduziu:
- **alto:** turno com resposta de `turn/start` perdida, run `unknown`, revogação ocultando trabalho vivo;
- **alto:** revogação durante reconcile, que revivia o run num projeto revogado;
- **médio:** decisão perdida deixando o projeto sem interromper, reconciliar nem revogar até reiniciar;
- **baixos:** inode, caminho antigo.

Corrigidos em `a558dac`:
- retenção de projeto em toda operação com efeito;
- rechecagem no `reconcile`;
- trabalho incerto visível em vez de bloqueante;
- `interrupt` de run acompanhado;
- fixação de inode.

**4ª rodada** (`754e723..a558dac`): **nenhum bloqueador**. Confirmou:
- retenção no mesmo tick da autorização em todos os POSTs;
- retenções sem vazamento (liberadas no `finally`, esperas limitadas);
- `interrupt` de `unknown` sem violar E4/F2 (nunca alcança turno de órfão);
- rechecagem do `reconcile`.

Achados baixos corrigidos em `a1b03b7`:
- inode fixado na leitura errada;
- alerta contando runs que não podem mais rodar;
- histórico e threads sem retenção;
- órfãos de projeto revogado ocultos.

### 6.1 Segunda revisão (fechamento, diff `1ea3806..9e5a6e8`, foco em persistência e rotas de autorização)

**Resultado:** nenhum achado crítico ou alto. Achados corrigidos em `8ed353c`, cada um com teste que falha sem a correção:

| # | Severidade | Achado | Correção |
|---|---|---|---|
| F1 | média | Revogação aceita com turno de provider ainda vivo e run `unknown` (decisão de aprovação com entrega ambígua): trabalho em voo sumia da interface | `ExecutionService.projectBusy`: recusa com turno acompanhado ou aprovação aberta no projeto |
| F2 | média/baixa | Um `-journal` plantado ao lado do store (o diretório de dados não era verificado) era reaplicado pelo SQLite ao abrir, injetando concessão sem auditoria | Store movido para `runtime-<modo>/` (0700, nosso); diretório e `-wal/-shm/-journal` verificados antes de abrir |
| F3 | baixa | `e3-homologation` ignorava as reservas da P-D4 | Lê as reservas do shell e do `cockpit.env` instalado, recusa (`e3_target_reserved`) e as repassa ao Cockpit lançado |
| F4 | info | Histórico do Codex e lista de threads não rechecavam o grant depois da espera do provider | Rechecagem depois da espera |

Os demais informativos viraram riscos residuais (ADR-0004 §6, itens 8–10).

**Propriedades confirmadas pelo revisor:**
- todas as proteções do POST;
- concessão só de diretório real descoberto agora;
- reserva derivada só do ambiente e de `vmIdentity`, aditiva, aplicada em todas as rotas, no `ExecutionService` e no guarda de argv do Claude;
- concessões gravadas não contornam reserva nova nem voltam sozinhas;
- correções da 1ª revisão intactas;
- revogação compartilhada por todas as sessões e streams;
- órfãos de projeto reservado só com PID e VM.

### 6.2 Primeira revisão (MVP, diff `1ea3806..8fa2df0`)


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

## 7. Rodada final e parecer

**Aceite no commit `4c97b53`, árvore limpa** (`./scripts/cockpit f1-accept hermetic`, `CHROMIUM=/usr/bin/chromium`): **overall PASS**.

| Etapa | Resultado |
|---|---|
| typecheck | limpo |
| suíte completa | 497 pass, 0 fail |
| drill E4 | PASS |
| `visual-check` | 23/23 |
| `brand-visual-check` | 23/23 |
| `f1-visual-check` | 12/12 |
| `f1-browser-acceptance` | 52/52 |
| `artifact --check` | PASS |

`projects-visual-check`: 21/21.

Os relatórios estão em `docs/evidence/projetos-descoberta-hermetic/`. O commit seguinte só acrescenta este §7 e esses relatórios (documentação, fora do manifesto); `artifact --check` foi conferido de novo nele.

**Base:** `develop` `1ea3806`, com 455 testes. A branch avança por fast-forward.

**Não executado (de propósito):**
- nada no Arch;
- nada contra o serviço da porta 8787, VMs reais, `msb`, credenciais ou bancos reais;
- nenhum prompt real.

O modo host só foi exercitado com descoberta real sobre diretório temporário e saída sintética do `msb list`.

**Parecer: GO condicionado** a duas coisas:
1. **Decisão do Tech Lead sobre o ajuste da P-D3:** a reserva vence também `COCKPIT_ALLOWED_PROJECTS` (ADR-0004 §7).
2. **Conferência do `cockpit.env` do Arch antes do restart** (§3). Pela P-D4, um projeto em uso que divide o nome com uma VM reservada ficará bloqueado.

