# ADR-0004 — Descoberta automática de projetos e autorização pela interface

**Data:** 2026-11-09 · **Branch:** `feat/project-discovery` (a partir de `develop` `1ea3806`) · **Complementa:** [ADR-0002](adr-0002-m0b1b-local-http-security.md). Este ADR responde a dois gatilhos de revisão listados lá: "endpoint mutável" e "revogação sem restart". Também ajusta uma regra de [ADR-0003](adr-0003-f1-sessao-deslizante-e-servico.md) (§ "grants obrigatórios na partida").
**Estado:** implementado na branch, **não integrado**. Revisão de segurança independente registrada em [projetos-descoberta.md](projetos-descoberta.md) §6. Precisa de decisão do Tech Lead antes do merge (§7).
**Fora de escopo:** F3, criar ou ligar VMs, orquestração. Nenhuma linha de `msb run|start|stop|create` foi adicionada.

## 1. Auditoria do estado anterior (`1ea3806`)

**Descoberta de projetos** (`src/projects.ts`):
- lista as entradas de `COCKPIT_PROJECTS_BASE`;
- aceita só nomes `^[a-z0-9][a-z0-9_-]{0,62}$`;
- aceita só diretórios reais: `lstat`, sem symlink na entrada nem em nenhum componente do caminho base (`assertNoSymlinks`).

**Descoberta de VMs** (`src/adapter.ts` e `src/parser.ts`):
- a fonte é `msb list --format json` (somente leitura, timeout 3 s, limite de 256 KiB);
- só nomes `<provider>-<projeto>` com provider `codex|claude|opencode` viram VMs de agente. As demais sandboxes são contadas e ignoradas.

**Associação projeto↔VM:** só pela convenção de nome. `codex-foo-bar` pertence ao projeto `foo-bar`. Uma VM cujo projeto não tem diretório é marcada órfã e nunca é executável.

**Autorização (o atrito):**
- vinha só de `COCKPIT_ALLOWED_PROJECTS`, fixo na partida. Um valor vazio recusava a partida (`local_grants_required`);
- incluir um projeto exigia editar `~/.config/engineering-cockpit/cockpit.env` e reiniciar o serviço, o que também derruba todas as sessões HTTP;
- o painel mostrava apenas **contagens** de VMs fora dos grants, nunca nomes.

**VMs reservadas:** a VM de desenvolvimento `claude-engineering-cockpit` (sempre, D8) mais `COCKPIT_RESERVED_VMS`, recusadas na camada de execução (`ExecutionService.supports`, `assertClaudeTarget`). Não havia o conceito de **projeto** reservado.

## 2. Decisão

**Descobrir ≠ autorizar.** O Cockpit lista todo projeto descoberto, mas só abre sessões, mostra histórico ou executa em projetos autorizados.

```
grants efetivos = COCKPIT_ALLOWED_PROJECTS (configuração, imutável pela UI)
                ∪ concessões feitas na interface autenticada (persistidas, auditadas)
```

| Regra | Onde |
|---|---|
| A UI só autoriza um projeto **descoberto agora**: `discovery.refresh()` autoritativo, nunca o cache de exibição. A falha da descoberta não concede nada (503) | `src/server.ts` (`/api/projects/:id/grant`) |
| Projetos reservados nunca são autorizáveis pela UI (403 `project_reserved`): `engineering-cockpit` (projeto da VM de desenvolvimento, sempre) mais `COCKPIT_RESERVED_PROJECTS` (só acrescenta) | `src/project-grants.ts` |
| Uma concessão da UI já gravada para um projeto que depois virou reservado (ou passou para a configuração) deixa de valer como concessão da UI | `ProjectGrants` (construtor) |
| A UI não revoga concessões da configuração (409 `grant_from_config`). Elas mudam só em `cockpit.env` | `ProjectGrants.revoke` |
| Revogação recusada com run ativo ou aprovação pendente no projeto (409 `project_busy`) ou com processo órfão de uma VM dele (409 `orphan_process_alive`): não se esconde trabalho em voo | `src/server.ts` |
| Revogar não apaga nada: sessões, runs e histórico voltam ao autorizar de novo | `RuntimeStore` inalterado |
| Um único conjunto vivo de grants para todos os principals. A revogação vale na próxima verificação de **toda** sessão aberta e corta o stream SSE já aberto (replay e eventos ao vivo) | `ProjectGrants.view`, `LocalSecurity.authenticate`, `stream()` |
| VMs são reutilizadas como estão. Parada → "ligue pelo launcher"; ausente → "crie pelo launcher". O Cockpit não cria nem liga VMs | `src/catalog.ts`, `public/app.js` |
| VMs reservadas continuam recusadas na camada de execução, mesmo com o projeto autorizado | inalterado |
| `COCKPIT_UI_GRANTS=off` volta exatamente ao comportamento anterior: só configuração, que precisa ser não vazia | `src/config.ts`, `src/index.ts` |

**Mutação protegida** (`POST /api/projects/:id/grant` e `/revoke`):
- os mesmos controles de todo POST: Host/Origin/Sec-Fetch-Site, cookie + prova em cabeçalho, CSRF da época, nonce de uso único, `Content-Type: application/json`, corpo ≤ 4 KiB;
- corpo **exato** `{"confirm": "<projeto>"}`, igual ao nome da rota. Assim nenhuma requisição cega ou com alvo trocado concede acesso;
- o nome da rota segue a mesma gramática da descoberta (`[a-z0-9][a-z0-9_-]{0,62}`). Fora dela não há rota (405), então `..`, `/` e maiúsculas nunca chegam aos grants;
- a página pede confirmação explícita antes de enviar.

**Persistência** (`src/grant-store.ts`, `<data>/grants-<modo>.sqlite`):
- arquivo próprio, criado `O_EXCL` com 0600, nunca através de link (nem no caminho, nem em `-wal/-shm/-journal`);
- um único hard link, dono = UID do processo, sem bits de grupo/outros;
- `application_id` próprio e schema exato; toda linha é validada na abertura. Qualquer divergência recusa a partida (`grant_store_denied`, saída 78);
- aberto só **depois** do lock do banco de runtime: um Cockpit por diretório de dados;
- limite de 256 concessões pela UI.

**Auditoria:**
- tabela `grant_audit` append-only. Triggers recusam `UPDATE`/`DELETE`, e os triggers fazem parte do schema exigido, então removê-los impede a partida;
- registra `at`, `action`, `project`, `actor` e `request_id`. `actor` = `local_operator:` + 16 hex de `sha256("cockpit-audit:" + id da sessão)`: correlaciona as ações de uma sessão sem nunca gravar cookie, prova ou CSRF;
- cada mudança efetiva também gera uma linha `{"event":"project_grant",…}` no stdout (journald no serviço), com o mesmo `request_id` do cabeçalho `X-Request-Id`;
- concessão e linha de auditoria são gravadas na mesma transação. A memória só muda depois da escrita durável: uma falha (500) não altera nada.

## 3. Mudança de exposição (deliberada)

**Antes:** o operador autenticado via só contagens fora dos grants.

**Agora:** `GET /api/catalog` mostra ao operador autenticado:
- os **nomes dos diretórios** da pasta de projetos;
- para cada um, o estado das VMs `claude-<p>`/`codex-<p>` (e de outras do mesmo projeto, como "sem suporte").

**Continua fechado por grant:** sessões, runs, histórico, aprovações, eventos SSE e as rotas `/api/vms*` e `/api/projects/:id`.

Nomes de VMs sem diretório (órfãs) de projetos não autorizados continuam ocultos.

## 4. Mudanças de configuração

| Variável | Antes | Agora |
|---|---|---|
| `COCKPIT_ALLOWED_PROJECTS` | obrigatória, não vazia | opcional. Vazia ou ausente = nenhuma concessão por configuração. Valor malformado continua recusado |
| `COCKPIT_UI_GRANTS` | — | `on` (padrão) ou `off` |
| `COCKPIT_RESERVED_PROJECTS` | — | CSV opcional. Só acrescenta a `engineering-cockpit` |

As duas novas entram na lista de chaves permitidas de `cockpit.env` (`SERVICE_ENV_KEYS`) e só são gravadas se definidas no shell do `install`. Um `cockpit.env` existente continua válido sem alteração.

`e3-homologation` passa a iniciar seu Cockpit de teste com `COCKPIT_UI_GRANTS=off`, porque reutiliza o diretório de dados entre execuções e promete ACL exatamente igual ao projeto de teste.

## 5. Alternativas descartadas

- **Conceder automaticamente tudo o que for descoberto.** Viola "descobrir ≠ autorizar": qualquer diretório criado na pasta de projetos viraria executável.
- **Gravar em `cockpit.env` a partir da UI.** Mistura configuração do operador com estado de execução, exige reinício e amplia a superfície de escrita do processo HTTP para fora do diretório de dados.
- **Nova tabela no banco de runtime.** Exigiria migração do schema estrito de `runtime.sqlite`. Um arquivo próprio isola o risco e torna o rollback trivial (a versão anterior ignora o arquivo).
- **Reautenticação (credencial de novo) para autorizar.** Mais forte contra um script injetado na página, mas a CSP (`script-src 'self'`), `textContent` e CSRF já cobrem esse vetor, e o custo de uso é alto. Fica como opção se houver múltiplos operadores ou exposição por rede (gatilho já listado no ADR-0002).

## 6. Riscos residuais

1. **Requisição em voo.** Uma requisição autorizada antes de uma revogação concorrente pode concluir o efeito já iniciado (ex.: um `startRun` aguardando a descoberta). A revogação não é um "kill switch": vale a partir da verificação seguinte.
2. **Mesmo UID.** Quem tem o mesmo UID consegue editar o SQLite de forma consistente, como já consegue ler a credencial. Fora do modelo de ameaça (ADR-0002).
3. **Identidade é o nome.** A concessão é por nome, como na configuração. Um diretório removido e recriado com o mesmo nome continua autorizado.
4. **Auditoria sem tela.** A trilha fica no SQLite e no journal. Não há tela de auditoria nesta MVP.
5. **Isolamento do `e0-recovery`.** A verificação lê só o ambiente do Cockpit alvo. Com concessões da UI no diretório de dados desse Cockpit, a ACL pode ser maior que `COCKPIT_ALLOWED_PROJECTS`. A verificação via API (`other_vms_runnable`) continua detectando VMs executáveis extras.
6. **Um operador.** Múltiplos operadores com grants distintos continuam fora de escopo.

## 7. Decisões pedidas ao Tech Lead

- **P-D1.** Aceitar a mudança de exposição do §3 (nomes de diretórios visíveis ao operador autenticado).
- **P-D2.** Aceitar `COCKPIT_ALLOWED_PROJECTS` vazio como configuração válida com `COCKPIT_UI_GRANTS=on` (antes, a partida falhava).
- **P-D3.** Aceitar `engineering-cockpit` como projeto sempre reservado para a UI. Ele continua autorizável pela configuração, como hoje.
