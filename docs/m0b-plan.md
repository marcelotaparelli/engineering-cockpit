# M0b — controle de uma sessão Codex real na micro-VM

**Estado:** M0b.1a e M0b.1b concluídos; Fatia 3 (API/SSE/UI de execução) implementada e verificada localmente em 2026-11-07, ver [m0b-fatia3.md](m0b-fatia3.md); Fatia 4 (discovery no Arch + UX de 3 áreas) em [m0b-fatia4-ux.md](m0b-fatia4-ux.md); aceite no Arch pendente.  
**Decisão:** [ADR-0001](adr-0001-m0b-codex-app-server.md).  
**Stack:** Bun 1.4.4, TypeScript strict, SQLite nativo, HTTP + SSE local.

## Resultado esperado

No navegador local, o operador seleciona uma VM Codex existente e não órfã, cria ou retoma uma thread já pertencente a esse target, envia um prompt uma única vez, acompanha eventos reais, decide approvals e interrompe o turn. Histórico, estado operacional e métricas continuam coerentes após refresh ou restart do Cockpit, sem expor credenciais nem alterar o lifecycle da VM.

## Escopo e não objetivos

Incluído:

- uma conexão App Server por VM Codex ativa, inicialmente uma execução mutável por projeto;
- threads/sessões novas e existentes, turns, eventos, approvals e interrupt;
- histórico recuperado do Codex e journal operacional redigido no host;
- SSE com replay dos eventos duráveis;
- métricas de execução, duração e tokens observados;
- contrato de adapter capaz de receber Claude/OpenCode depois.

Fora de escopo:

- criar, iniciar, parar, recriar, remover ou reconfigurar VMs;
- alterar launchers, mounts, state ou credenciais existentes;
- expor App Server por TCP/WebSocket, LAN, proxy ou túnel;
- multiagente, deploy, push/merge, GitLab, Grafana ou custo monetário;
- suporte funcional a Claude/OpenCode neste marco;
- prometer isolamento contra outro processo malicioso sob o mesmo UID do Cockpit.

## Arquitetura de componentes

| Componente | Responsabilidade | Não pode fazer |
| --- | --- | --- |
| `ApiServer` | sessão local, CSRF, validação, HTTP/SSE, authz por projeto/run | construir argv, ler auth, decidir estado por input do browser |
| `RunCoordinator` | idempotência, state machine, lock por projeto, approvals e recovery | chamar detalhes `thread/*` diretamente |
| `SessionManager` | possuir uma conexão por VM, handshake e lifecycle | parar a VM ou assumir exclusividade externa |
| `MsbStdioTransport` | spawn argv fixo, JSONL full-duplex, limites/backpressure, shutdown do filho | shell, TTY, caminho/comando vindo da API |
| `CodexAppServerAdapter` | mapear initialize/thread/turn/events/approvals/usage | vazar tipos Codex ao domínio |
| `RuntimeStore` | targets, sessões, runs, approvals, journal e medições | persistir credenciais ou frames brutos |
| `HistoryService` | paginar histórico Codex e normalizar para UI | duplicar transcript completo no SQLite por padrão |
| `EventHub` | fan-out SSE, heartbeat, cursor e cliente lento | transformar ausência de evento em sucesso |

O banco M0a.2 continua exclusivo de discovery. O novo RuntimeStore tem `application_id` e schema version próprios, diretório privado `0700`, arquivo/WAL/SHM `0600`, recusa links/hardlinks e aplica retenção explícita.

## Contratos de domínio

```ts
type Provider = "codex" | "claude" | "opencode";
type RunStatus =
  | "queued" | "running" | "awaiting_approval"
  | "completed" | "failed" | "interrupted" | "unknown";

interface ExecutionTarget {
  provider: "codex";
  projectId: string;
  vmName: string;
  vmInstanceId: string | null; // null significa identidade estável não comprovada
  discoveryVersion: string;
}

interface ProviderCapabilities {
  resume: boolean;
  interrupt: boolean;
  approvals: boolean;
  history: "none" | "paged";
  usage: "none" | "thread_cumulative" | "run";
}

interface ProviderAdapter {
  readonly provider: Provider;
  probe(): Promise<ProviderCapabilities>;
  connect(target: ExecutionTarget): Promise<ProviderConnection>;
}

interface ProviderConnection {
  initialize(): Promise<ProtocolIdentity>;
  listSessions(): Promise<ProviderSessionSummary[]>;
  startSession(input: StartSessionInput): Promise<ProviderSessionRef>;
  resumeSession(ref: ProviderSessionRef): Promise<ProviderSessionRef>;
  startRun(input: StartRunInput): Promise<ProviderRunRef>;
  interrupt(ref: ProviderRunRef): Promise<void>;
  decideApproval(ref: ProviderApprovalRef, decision: "approve" | "reject"): Promise<void>;
  history(ref: ProviderSessionRef, cursor?: string): Promise<HistoryPage>;
  reconcile(ref: ProviderRunRef): Promise<ReconciliationResult>;
  events(): AsyncIterable<ProviderEvent>;
  close(): Promise<void>;
}
```

Adapter não significa “comando arbitrário”. Cada implementação possui spawn/configuração fixa e declara capabilities reais. Um adapter fake alternativo deverá passar testes de contrato para provar que API e coordinator não conhecem semântica Codex.

### Sessão e run

```ts
interface SessionRecord {
  sessionId: string;                 // Cockpit
  target: ExecutionTarget;
  providerSessionId: string;         // Codex thread id
  createdAt: string;
  lastObservedAt: string;
}

interface RunRecord {
  runId: string;
  sessionId: string;
  providerRunId: string | null;      // Codex turn id
  idempotencyKeyHash: string;
  requestDigest: string;
  status: RunStatus;
  lifecycleVersion: number;
  startedAt: string | null;
  endedAt: string | null;
}
```

- `providerSessionId` pertence a exatamente um `{provider, projectId, vmName}`.
- IDs enviados pelo browser nunca autorizam resume sozinhos; precisam existir no vínculo server-side.
- `POST /runs` exige `Idempotency-Key`. Mesma chave + mesmo digest retorna o mesmo run; digest diferente retorna `409`.
- Refresh consulta o run existente e abre SSE; nunca chama `startRun`.

### Approval

```ts
interface ApprovalRecord {
  approvalId: string;
  runId: string;
  providerRequestId: string;
  providerTurnId: string;
  actionType: "command" | "file_change" | "permission";
  actionDigest: string;
  policyVersion: string;
  status: "pending" | "approved" | "denied" | "expired";
  version: number;
  expiresAt: string;
}
```

- A UI recebe somente resumo allowlistado; o digest é calculado pelo backend sobre o pedido exato.
- A decisão exige sessão autenticada, CSRF, `expectedVersion` e vínculo ao run/projeto.
- A transição é atômica `pending → approved|denied|expired`; replay idêntico é no-op, conflito retorna `409`.
- Disconnect/restart expira o handle pendente. Nenhuma approval é recriada, generalizada ou autoaprovada.
- O M0b só oferece `approve` e `reject`; não expõe `acceptForSession`.

### Evento normalizado

```ts
interface NormalizedEvent {
  eventId: string;
  sequence: number;
  schemaVersion: 1;
  type:
    | "session.connected" | "session.resumed"
    | "run.started" | "run.status_changed"
    | "approval.requested" | "approval.resolved"
    | "usage.updated" | "run.error";
  occurredAt: string;
  observedAt: string;
  provider: Provider;
  projectId: string;
  vmName: string;
  sessionId: string;
  runId: string | null;
  verificationState: "observed" | "reconciled";
  publicPayload: Record<string, unknown>;
}
```

Somente tipos e campos allowlistados entram no journal. Frames desconhecidos são descartados e contabilizados como `provider_event_unmapped`. Deltas de mensagem/diff/output podem trafegar ao vivo com limites, mas são transitórios; após refresh, a UI reconstrói a conversa pela API paginada de histórico do Codex. Não se persiste prompt, transcript, diff ou stdout/stderr bruto no RuntimeStore por padrão.

## API HTTP/SSE proposta

| Método e rota | Efeito / contrato |
| --- | --- |
| `GET /api/vms/:vm/sessions` | lista threads observadas somente no target revalidado |
| `POST /api/sessions` | cria ou retoma; corpo tipado, sessão local + CSRF |
| `GET /api/sessions/:id/history` | histórico paginado normalizado, `no-store` |
| `POST /api/sessions/:id/runs` | inicia uma vez; exige `Idempotency-Key` |
| `GET /api/runs/:id` | estado autoritativo do RuntimeStore |
| `GET /api/runs/:id/events` | SSE autenticado, heartbeat e `Last-Event-ID` |
| `POST /api/runs/:id/interrupt` | pedido idempotente para o turn exato |
| `POST /api/approvals/:id/decision` | CAS por `expectedVersion`, `approve|reject` |
| `GET /api/runs/:id/metrics` | medidas e respectivas fontes |

Mutações aceitam somente `application/json`, limite pequeno de body, schema exato e nenhuma query livre. A sessão do operador usa segredo aleatório por inicialização, cookie `HttpOnly; SameSite=Strict` e token CSRF; Host/Origin/Fetch Metadata atuais permanecem defesa adicional. O segredo nunca entra em URL, SQLite ou logs. Processos sob o mesmo UID continuam fora do isolamento forte; multiusuário futuro requer conta OS/proxy autenticado separado.

## Lifecycle, concorrência e recovery

```text
queued → running ↔ awaiting_approval → completed
            │              │          ↘ failed
            │              └──────────→ unknown
            └─────────────────────────→ interrupted
```

- `interrupted` somente após confirmação do provider; timeout ou perda de conexão vira `unknown`.
- Um lock cooperativo por projeto impede dois writers do Cockpit. Atividade externa permanece não observada e deve aparecer na UI como risco, não como “livre”.
- Antes de conectar: refresh server-side e recusa de VM ausente, parada, órfã, não Codex ou divergente do snapshot selecionado.
- Se MSB não expuser ID imutável da instância, troca de VM pelo mesmo nome permanece risco residual documentado.
- Após restart: novo handshake, `thread/resume`, paginação de histórico e reconcile. Sem prova conclusiva, manter `unknown`; nunca reenviar prompt ou approval.
- Shutdown encerra somente o `msb exec` criado pelo Cockpit e seus pipes. Nunca chama lifecycle da VM.

## Isolamento e credenciais

- O backend não lê, copia, monta, serializa nem encaminha os arquivos de auth existentes.
- O subprocesso recebe ambiente mínimo allowlistado; não herda `*_KEY`, `*_TOKEN`, `*_SECRET`, `SSH_AUTH_SOCK` ou `.env` do host.
- Prompt existe apenas no body autenticado em memória e no frame JSONL; nunca em argv, path, label, log ou métrica.
- Parser JSONL incremental: limite por frame e buffer, profundidade/tipos validados, deadline de handshake e fila com backpressure.
- stderr é separado e convertido apenas em códigos/contadores sanitizados.
- A topologia atual usa `shared/codex-auth`; portanto o M0b pode afirmar “a credencial não sai da VM”, mas não “credencial isolada por projeto”. Isolamento por projeto exigiria mudança futura dos mounts e aprovação separada.

## Métricas e sinais

### Medição por run

```ts
interface RunMeasurement {
  runId: string;
  executionCount: 1;
  durationMs: number | null;
  durationSource: "provider" | "host_monotonic" | "not_measured";
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  tokenSource: "provider_event" | "provider_delta" | "not_measured";
}
```

`thread/tokenUsage/updated` pode ser cumulativo. O adapter só calcula delta por run se baseline/final e monotonicidade forem comprovados; caso contrário expõe o valor no escopo real ou `null`. Custo monetário não é inferido.

Métricas de baixa cardinalidade:

- runs por `provider/outcome`, duração de handshake/turn e transports ativos;
- falhas de protocolo, reconnects, recovery `unknown` e eventos descartados;
- approvals por outcome e replay negado;
- conexões SSE, disconnects por backpressure e lag do journal.

Logs JSON sanitizados usam `request_id`, `trace_id`, `run_id` pseudônimo, evento, outcome, duração e código. Sem prompt, diff, stdout/stderr bruto, cookie, token, path de auth ou IDs em labels métricos. Eventos de segurança incluem `auth.failed`, `csrf.denied`, `authz.denied`, `target.revalidation_denied`, `approval.*`, `approval.replay_denied`, `process.protocol_failed` e `process.recovery_unknown`.

SLI inicial: turns confirmados com estado terminal conhecido / turns aceitos, e latência do handshake/primeiro evento. SLO numérico e alertas ficam `not_configured` até baseline real do Arch; não inventar objetivo.

## Plano de entrega — sem execução nesta fase

### Gate 0 — spike autorizado no Arch

**Resultado:** validado com limitação; veja [m0b0-spike.md](m0b0-spike.md). Full-duplex e operações passaram, enquanto desconexão com rollout vazio exige `unknown`.

1. Registrar versões sanitizadas de `msb` e `codex`; gerar schema TS/JSON e seu hash.
2. Provar `msb exec --no-tty ... codex app-server --listen stdio://` com stdin persistente, stdout JSONL e stderr separado.
3. Exercitar handshake, list/start/resume de thread, histórico, turn inócuo e eventos ao vivo.
4. Gerar e rejeitar uma approval sem efeito; interromper um turn.
5. Derrubar somente o transporte/backend, reconectar e reconciliar sem reenvio.
6. Confirmar EOF, signal/kill do filho, ausência de processo órfão e comportamento de tokens.
7. Inspecionar apenas metadados/permissões dos mounts; nunca ler credenciais.

O spike falha se houver framing contaminado, dependência de TTY, stdin não persistente, processo órfão, duplicação após reconnect, resume inconclusivo ou schema incompatível. Nesse caso, parar e escrever novo ADR para um bridge mínimo autenticado.

### Fatia 1 — domínio e fake protocol

- tipos de domínio, RuntimeStore separado, migrations e state machines;
- adapter e transport interfaces; fake App Server determinístico;
- idempotência, approval CAS, journal/cursor e recovery `unknown`;
- testes sem VM/API paga.

### Fatia 2 — Codex transport/adapter

- código gerado da versão instalada, parser JSONL, supervisor e backpressure;
- handshake, thread/history/turn/approval/interrupt/reconcile;
- testes de conformidade e falhas com fake subprocess.

### Fatia 3 — API, SSE e UI

- sessão local/CSRF/authz, endpoints e limites;
- SSE replay/heartbeat, prompt editor, histórico, approval e interrupt;
- estados de erro/unknown, acessibilidade e proteção contra XSS.

### Fatia 4 — observabilidade e aceite Arch

- métricas/logs/eventos de segurança e retenção;
- suíte integral e security review independente;
- smoke real no Arch, vinculado a versão/schema/artefato;
- Ownership Card antes de considerar o marco completo.

## Riscos prioritários

| Risco | Nível | Tratamento / gate |
| --- | --- | --- |
| processo local controla mutações sem autenticação | HIGH confirmado no baseline | sessão local + CSRF + authz; teste de headers forjados sem credencial |
| confusão VM/projeto/thread ou approval replay | HIGH | target revalidado, vínculo server-side, digest/expiry/CAS, testes cross-project |
| vazamento de credencial/conteúdo em env/event/log/SQLite | HIGH | env e serializer allowlistados, canaries e inspeção de DB/WAL/log |
| duplicação após crash na fronteira DB/processo | HIGH | idempotência, reconcile ou `unknown`, nunca replay automático |
| `msb exec` 0.6.8 não é full-duplex confiável | HIGH desconhecido | Gate 0; falha bloqueia ADR |
| `shared/codex-auth` cruza projetos | HIGH residual da topologia | não ler/copiar; declarar limite; isolamento por projeto fora do M0b |
| cliente SSE lento ou evento excessivo causa memória/DoS | MEDIUM | fila/frames limitados, backpressure, disconnect e contadores |
| schema Codex muda | MEDIUM | geração/fingerprint por versão, capability probe, fail-closed |
| escritor externo altera o mesmo projeto | MEDIUM residual | lock cooperativo + aviso/recusa de takeover; worktree futura |

## Critérios de aceite verificáveis

### Funcional e histórico

- VM Codex existente, running, não órfã e explicitamente selecionada; zero operações de lifecycle.
- Sessão existente é listada e retomada com o mesmo provider thread ID; histórico reaparece após refresh.
- Um prompt produz exatamente um run por chave idempotente; retry/refresh não cria segundo turn.
- Eventos reais chegam ao vivo; eventos duráveis retomam por `Last-Event-ID` sem lacuna silenciosa.
- Interrupção só termina como `interrupted` após confirmação do Codex.

### Aprovações e recuperação

- Ação sensível para em `awaiting_approval`; decisão humana autenticada aprova ou rejeita apenas o request exato.
- Approval repetida, expirada, adulterada, cross-run ou cross-project não chega ao App Server.
- Restart, EOF, VM parada ou timeout não reenvia prompt nem resolve approval; reconcilia ou marca `unknown`.
- Refresh com approval pendente mostra o estado persistido, mas não revive um handle perdido.

### Segurança

- VM inexistente/parada/órfã/não Codex, snapshot stale, path traversal, argv/config arbitrários e body inválido produzem zero spawn.
- POST sem sessão/CSRF, cross-origin, Host divergente ou content-type incorreto é recusado e auditado.
- Browser e backend host nunca recebem token do provedor; ambiente do filho contém somente allowlist.
- Segredo/prompt/diff canário não aparece em logs, métricas, RuntimeStore, WAL/SHM, erros ou journal SSE.
- SSE/history/interrupt/approval de projeto ou run diferente retorna negação sem revelar existência.

### Protocolo, qualidade e adaptabilidade

- Schema gerado está versionado/fingerprinted; frame malformado, oversized, desconhecido ou fora de ordem falha fechado.
- Fake cobre sucesso, falha, approval, interrupt, backpressure, crash, reconnect, idempotência e recovery.
- Um adapter fake não Codex passa o contrato comum; nenhum tipo `thread/turn` aparece fora do módulo Codex.
- `bun run typecheck`, suíte integral e testes independentes passam no artefato final; smoke Arch registra versões e ambiente.

### Métricas e operação

- Cada run exibe contagem de execução, duração e fonte; tokens só aparecem quando observados, senão `null/not_measured`.
- Sucesso, falha e authz negada produzem log/evento correlacionado sem conteúdo sensível.
- Desligar a fonte ou perder o transporte aparece como `not_verified/unknown`, nunca verde ou zero.
- Runbook cobre processo órfão, EOF, protocol error, approval pendente, restart e recuperação sem parar a VM.

## Evidência exigida para fechar M0b

- relatório automatizado com comandos, exit codes e ambiente;
- smoke real sanitizado no Arch, versão do MSB/Codex e fingerprint do schema;
- revisão independente do design/segurança e testes negativos;
- identidade do artefato/commit avaliado;
- métricas/tokens reais ou `not_measured`, sem estimativa;
- confirmação de que nenhuma VM, launcher, mount ou credencial foi alterada.
