# ADR-0004 — Descoberta automática de projetos, autorização pela interface e projetos reservados

**Data:** 2026-11-09 · **Branch:** `feat/project-discovery` (a partir de `develop` `1ea3806`) · **Complementa:** [ADR-0002](adr-0002-m0b1b-local-http-security.md). Responde a dois gatilhos de revisão listados lá: "endpoint mutável" e "revogação sem restart". Ajusta uma regra de [ADR-0003](adr-0003-f1-sessao-deslizante-e-servico.md) (grants obrigatórios na partida) e a D8 do master plan (reserva por VM passa a reservar o projeto).
**Estado:** implementado na branch, **não integrado**.
- Decisões do Tech Lead: P-D1, P-D2 e P-D3 aprovadas; P-D4 decidida (§7).
- Duas revisões de segurança independentes: [projetos-descoberta.md](projetos-descoberta.md) §6.

**Fora de escopo:** F3, criar ou ligar VMs, orquestração. Nenhuma linha de `msb run|start|stop|create` foi adicionada.

## 1. Auditoria do estado anterior (`1ea3806`)

**Descoberta de projetos** (`src/projects.ts`):
- lista as entradas de `COCKPIT_PROJECTS_BASE`;
- aceita só nomes `^[a-z0-9][a-z0-9_-]{0,62}$`;
- aceita só diretórios reais: `lstat`, sem symlink na entrada nem em nenhum componente do caminho base.

**Descoberta de VMs** (`src/adapter.ts`, `src/parser.ts`):
- fonte: `msb list --format json` (somente leitura, timeout 3 s, limite de 256 KiB);
- só nomes `<provider>-<projeto>` com provider `codex|claude|opencode` são VMs de agente. As demais sandboxes são contadas e ignoradas.

**Associação projeto↔VM:** só pela convenção de nome, validada por `vmIdentity`. `codex-foo-bar` pertence a `foo-bar`. Uma VM sem diretório do projeto é órfã e nunca executável.

**Autorização (o atrito):**
- vinha só de `COCKPIT_ALLOWED_PROJECTS`, fixo e obrigatório na partida;
- incluir um projeto exigia editar `cockpit.env` e reiniciar, o que derruba as sessões HTTP;
- o painel mostrava só **contagens** fora dos grants.

**Reservas:** só por VM. `claude-engineering-cockpit` sempre (D8) mais `COCKPIT_RESERVED_VMS`, recusadas na execução. Não havia projeto reservado. Reservar `codex-x` ainda deixava `claude-x` operável.

## 2. Decisão

**Descobrir ≠ autorizar.** Todo projeto descoberto é listado, mas só um projeto autorizado e não reservado abre sessão, mostra histórico ou executa.

```
reservados       = {engineering-cockpit} ∪ COCKPIT_RESERVED_PROJECTS ∪ {projeto(v) | v ∈ VMs reservadas}
VMs reservadas   = {claude-engineering-cockpit} ∪ COCKPIT_RESERVED_VMS ∪ {p-x | x ∈ reservados, p ∈ codex,claude,opencode}
grants efetivos  = (COCKPIT_ALLOWED_PROJECTS ∪ concessões da interface) \ reservados
```

`projeto(v)` vem da associação validada `<provider>-<projeto>` (`vmIdentity`), nunca de dado do cliente. Todas as fontes de reserva só **acrescentam**: um valor vazio ou malformado não libera `engineering-cockpit` (malformado recusa a partida).

| Regra | Onde |
|---|---|
| A UI só autoriza um projeto **descoberto agora**: `discovery.refresh()` autoritativo, nunca o cache de exibição. Falha da descoberta não concede nada (503) | `src/server.ts` |
| **Reserva vence qualquer concessão**, inclusive `COCKPIT_ALLOWED_PROJECTS` (requisito 2 do fechamento; ver §7, P-D3). A entrada da configuração é ignorada e registrada na partida (`project_grant_ignored`). A UI recusa com 403 `project_reserved` | `src/project-grants.ts`, `src/index.ts` |
| Concessão da UI gravada para um projeto que passou a ser reservado (ou a estar na configuração) é **removida na partida**, com linha `revoke` na auditoria (ator `system:0000000000000000`, `request_id` `startup-reconcile`) e no log. Nunca volta sozinha quando a reserva é retirada | `ProjectGrants`, `GrantStore.dropShadowed` |
| A UI não revoga concessões da configuração (409 `grant_from_config`) | `ProjectGrants.revoke` |
| Revogação recusada (409 `project_busy`) com run ativo, com turno de provider ainda acompanhado por este processo ou com aprovação ainda aberta, **mesmo que o run conste como `unknown`** (`ExecutionService.projectBusy`). Também recusada com processo órfão do projeto (409 `orphan_process_alive`). O Cockpit nunca encerra processos sozinho | `src/server.ts`, `src/execution.ts` |
| Revogar não apaga nada: sessões, runs e histórico voltam ao autorizar de novo | `RuntimeStore` inalterado |
| A autorização é relida de forma síncrona antes de criar um run (depois da revalidação da VM) ou uma sessão (antes e depois do provider) | `src/execution.ts`, `src/server.ts` |
| Processo órfão de projeto **reservado** continua visível em "Precisa de você" (PID, VM, `reserved: true`), sem sessão nem histórico | `src/dashboard.ts` |
| VMs são reutilizadas como estão. Parada → "ligue pelo launcher"; ausente → "crie pelo launcher" | `src/catalog.ts`, `public/app.js` |
| `COCKPIT_UI_GRANTS=off` volta ao comportamento anterior de concessão (só configuração, não vazia). As reservas valem em qualquer modo | `src/config.ts`, `src/index.ts` |

### 2.1 Bloqueio de projeto reservado: camadas independentes

Cada camada abaixo basta sozinha para fechar todas as rotas que estão acima dela. Os testes de mutação removem uma camada por vez e a suíte continua passando; removendo as duas primeiras juntas, ela falha (projetos-descoberta.md §5).

| Camada | O que fecha |
|---|---|
| 1. Grants efetivos (`ProjectGrants.view` exclui reservados) | toda verificação de grant |
| 2. `LocalSecurity.allows` (grant **e** não reservado) | `/api/vms`, `/api/vms/:id`, `/api/vms/:id/threads`, `/api/projects/:id`, `POST /api/sessions`, `/api/sessions/:id`, `/history`, `/runs`, `/api/runs/:id`, `/interrupt`, `/reconcile`, `/api/approvals`, `/api/approvals/:id/decision`, painel (sessões, aprovações), replay e eventos ao vivo do SSE, re-checagem de `startRun`/`openSession` |
| 3. `ExecutionService.supports` (deriva o projeto das VMs reservadas por conta própria) | `revalidate` → `target_unavailable` antes de qualquer spawn, qualquer provider |
| 4. `assertClaudeTarget` (deriva o projeto) | argv do `msb exec` do Claude: `claude-x` recusado se `codex-x` está reservado |
| 5. Catálogo e UI | projeto reservado sem "Autorizar", agentes `reserved` |
| 6. `f1-systemd-smoke` | recusa VM de teste cujo projeto está reservado (shell ou `cockpit.env` instalado) |

**Mutação protegida** (`POST /api/projects/:id/grant` e `/revoke`):
- os mesmos controles de todo POST: Host/Origin/Sec-Fetch-Site, cookie + prova em cabeçalho, CSRF da época, nonce de uso único, JSON, corpo ≤ 4 KiB;
- corpo **exato** `{"confirm":"<projeto>"}`, igual ao nome da rota;
- o nome da rota segue a gramática da descoberta. Fora dela não há rota (405);
- a página pede confirmação explícita antes de enviar.

**Persistência** (`src/grant-store.ts`, `<data>/runtime-<modo>/grants.sqlite`):
- arquivo próprio no diretório `runtime-<modo>/`, que precisa ser nosso e 0700 (o mesmo exigido pelo banco de runtime). Criado `O_EXCL` com 0600, nunca através de link;
- `-wal`, `-shm` e `-journal` precisam estar ausentes, ou ser arquivos regulares nossos, sem bits de grupo/outros e com um único link. São verificados **antes** de abrir, porque o SQLite reaplica um journal "quente" ao abrir;
- um hard link, dono = UID do processo, sem bits de grupo/outros;
- `application_id` próprio e schema exato, incluindo os triggers de auditoria; toda linha validada na abertura. Divergência recusa a partida (`grant_store_denied`, 78);
- aberto só depois do lock do banco de runtime;
- limite de 256 concessões;
- arquivo vazio e privado (primeira partida interrompida) é inicializado.

**Auditoria:**
- `grant_audit` append-only (triggers recusam `UPDATE`/`DELETE`);
- registra `at`, `action`, `project`, `actor` (`local_operator:` + 16 hex de `sha256` do id da sessão, ou `system:…` na reconciliação da partida) e `request_id`;
- concessão e auditoria na mesma transação; memória só muda depois da escrita durável;
- linha `project_grant` no journal para cada mudança efetiva.

## 3. Mudança de exposição (P-D1, aprovada)

`GET /api/catalog` mostra ao operador autenticado:
- os nomes dos diretórios da pasta de projetos;
- o estado das VMs `claude-<p>`/`codex-<p>` e de outras VMs do mesmo projeto.

Projetos reservados aparecem marcados "Reservado" (se o diretório existe), sem nada operável.

**Continua fechado por grant e reserva:** sessões, runs, histórico, aprovações, eventos SSE, `/api/vms*`, `/api/projects/:id`.

## 4. Configuração

| Variável | Antes | Agora |
|---|---|---|
| `COCKPIT_ALLOWED_PROJECTS` | obrigatória, não vazia | opcional (P-D2). Entradas reservadas são ignoradas e registradas |
| `COCKPIT_RESERVED_VMS` | reserva só a VM | reserva a VM **e o projeto dela, para todos os providers** (P-D4) |
| `COCKPIT_RESERVED_PROJECTS` | — | CSV opcional; só acrescenta a `engineering-cockpit` |
| `COCKPIT_UI_GRANTS` | — | `on` (padrão) ou `off` |

As novas chaves entram em `SERVICE_ENV_KEYS` e só são gravadas por `service install` se definidas no shell. `e3-homologation` roda com `COCKPIT_UI_GRANTS=off` (reaproveita o diretório de dados e promete ACL exata).

## 5. Migração, compatibilidade e rollback

**Migração (nenhuma ação obrigatória do operador).**
1. Depois do merge, `./scripts/cockpit service restart` (o operador decide quando; derruba as sessões HTTP como sempre).
2. Na primeira partida é criado `<data>/runtime-host/grants.sqlite` (0600). Nenhum banco existente muda: `runtime.sqlite` e `cockpit-host.sqlite` têm o mesmo schema de antes.
3. Conferir no journal: `./scripts/cockpit service logs | grep -E 'project_grant(_ignored)?'`.

**Compatibilidade com `COCKPIT_ALLOWED_PROJECTS`.**
- Um `cockpit.env` existente continua válido sem alteração. Seus projetos aparecem como "Autorizado · configuração" e não podem ser revogados pela página.
- **Única mudança de efeito:** um projeto listado ali que esteja reservado deixa de ser acessível. Isso vale para `engineering-cockpit`, para `COCKPIT_RESERVED_PROJECTS` e, pela P-D4, para o projeto de qualquer VM de `COCKPIT_RESERVED_VMS`. A partida registra `{"event":"project_grant_ignored",…}` para cada um. Antes do restart, compare as duas listas do `cockpit.env`: se um projeto em uso diário divide o nome com uma VM reservada, ele ficará bloqueado.
- `COCKPIT_UI_GRANTS=off` + `COCKPIT_ALLOWED_PROJECTS` não vazio reproduz o modelo de concessão anterior. As reservas continuam valendo.

**Rollback.**
1. `git checkout <commit anterior>` no checkout instalado e `./scripts/cockpit service restart`.
2. A versão anterior não lê `runtime-<modo>/grants.sqlite`: valem só os projetos de `COCKPIT_ALLOWED_PROJECTS`, que precisa voltar a ser **não vazio** (senão a partida é recusada com 78).
3. A versão anterior volta a reservar só VMs (sem P-D4). Um projeto reservado por derivação volta a ser operável pelas outras VMs se estiver em `COCKPIT_ALLOWED_PROJECTS`.
4. O arquivo `runtime-<modo>/grants.sqlite` pode ficar: é ignorado. Ao reintegrar, as concessões gravadas voltam a valer, exceto as de projetos reservados, removidas na partida com auditoria.
5. Sessões, runs e histórico não são alterados por esta mudança em nenhum sentido.

## 6. Riscos residuais

1. **Requisição em voo.** Criar run e criar sessão releem a autorização antes do efeito. Ações que só reduzem risco (interromper, reconciliar, decidir) já iniciadas podem terminar. A revogação não é um "kill switch" de processos despachados.
2. **Mesmo UID.** Pode editar o SQLite de forma consistente, como já pode ler a credencial. Fora do modelo de ameaça (ADR-0002).
3. **Identidade é o nome.** Um diretório removido e recriado com o mesmo nome continua autorizado. Um diretório renomeado **não** leva a autorização junto.
4. **Auditoria sem tela.** Só SQLite e journal.
5. **Isolamento do `e0-recovery`.** A verificação lê só o ambiente do Cockpit alvo. A verificação pela API (`other_vms_runnable`) continua detectando VMs executáveis extras.
6. **Um operador.** Múltiplos operadores continuam fora de escopo.
7. **Run `unknown` não bloqueia a revogação.** A reconciliação fica inacessível até autorizar de novo (nada é apagado). Bloquear impediria revogar para sempre quando o provider não confirma.
8. **Processos depois da revogação.** Um app-server do Codex ou um processo ocioso do Claude de um projeto revogado continua vivo até o tempo ocioso do adapter, sem ser listado. Nada é enviado a ele, porque toda rota está fechada.
9. **`COCKPIT_UI_GRANTS` off → on.** Com `off` o store não é aberto. Ao voltar para `on`, as concessões gravadas antes voltam a valer, exceto as de projetos reservados, removidas na partida com auditoria.
10. **Reserva observável.** Conceder um reservado responde 403 `project_reserved`; um nome desconhecido, 404. O catálogo lista projetos reservados descobertos com o estado das VMs. Aceito para um operador único (P-D1).
11. **Cache de exibição.** O catálogo pode mostrar por até 3 s a última observação boa depois de uma mudança no disco ou de falha da descoberta. Toda rota que autoriza ou executa observa de novo e falha fechada.

## 7. Decisões do Tech Lead (2026-11-09)

- **P-D1 — aprovada.** Nomes de diretórios visíveis ao operador autenticado.
- **P-D2 — aprovada.** `COCKPIT_ALLOWED_PROJECTS` vazio é válido com `COCKPIT_UI_GRANTS=on`.
- **P-D3 — aprovada, com ajuste.** `engineering-cockpit` é sempre reservado. A proposta original dizia "continua autorizável pela configuração". O brief de fechamento (requisito 2: "bloqueie autorização, execução e acesso ao histórico de projetos reservados, em todas as rotas") exige o contrário. Foi seguida a regra mais restritiva: **a reserva vence também a configuração**. Se o Tech Lead quiser manter o acesso por configuração a algum projeto reservado, isso precisa de nova decisão. Hoje não há como, nem por configuração.
- **P-D4 — decidida.** Reservar uma VM reserva o projeto dela, para todos os providers.
