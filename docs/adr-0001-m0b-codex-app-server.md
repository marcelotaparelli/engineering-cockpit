# ADR-0001 — M0b por Codex App Server em stdio

- **Estado:** `ACCEPTED FOR M0b.1a`
- **Data:** 2026-10-25
- **Tier:** `critical`
- **Decisor:** Tech Lead; transporte autorizado pelo atestado manual do spike M0b.0

## Contexto

O M0b deve controlar uma sessão Codex real dentro de uma micro-VM já existente, preservando seus projetos, estado e credenciais. O Cockpit atual é Bun 1.4.4 + TypeScript strict, descobre VMs por `msb list`, persiste apenas o snapshot de discovery e expõe uma API GET local. Não existe ainda transporte persistente, sessão, run, SSE, aprovação ou mutação.

O Codex App Server oferece a superfície apropriada: threads persistentes, turns, eventos em streaming, histórico paginado, interrupção e requests de aprovação. Seu protocolo estável pode usar JSONL por stdio. O transporte WebSocket do App Server está documentado como experimental/não suportado para produção e não será usado no M0b.

## Decisão

Adotar, condicionadamente, um processo Codex App Server por VM Codex ativa, iniciado pelo backend host com argv fixo e sem shell, TTY ou porta:

```text
Browser local
  ├─ HTTP mutável autenticado + CSRF + idempotência
  └─ SSE autenticado + Last-Event-ID
               │
Backend Bun/TypeScript strict no host Arch
  ├─ API e RunCoordinator
  ├─ lock cooperativo de escrita por projeto
  ├─ RuntimeStore SQLite separado
  ├─ ProviderAdapter
  │    └─ CodexAppServerAdapter
  └─ MsbStdioTransport
               │ argv fixo, validado no spike e coberto por fixture local
               ▼
msb exec --no-tty <vm-validada> -- codex app-server --listen stdio://
               │
VM Codex existente
  ├─ /workspace e state existentes
  └─ autenticação Codex permanece dentro da VM
```

O spike manual no Arch autorizou o transporte full-duplex com MSB `--stream` e Codex App Server `0.163.0`, além de threads, turns, resume, histórico, interrupção e negação de aprovação. A desconexão retornou rollout vazio e não permitiu concluir o estado do turn; por isso M0b.1a deve persistir `unknown` e nunca reenviar prompt ou approval. A proveniência e os limites estão em [m0b0-spike.md](m0b0-spike.md).

## Fontes de verdade

- **Codex thread:** conversa, itens e histórico do provedor.
- **Cockpit RuntimeStore:** vínculo target/thread, idempotência, estado de run, decisões de aprovação, cursor do journal e reconciliação.
- **Memória do processo:** frames brutos e deltas ao vivo; não persistidos nem logados.
- **Discovery atual:** inventário observado; o target é revalidado imediatamente antes do spawn.
- **Browser:** cliente não autoritativo; refresh nunca inicia nem repete um turn.

O RuntimeStore será um banco separado, `data/cockpit-runtime.sqlite`, em vez de migrar de imediato o banco rígido de discovery. A separação reduz o acoplamento de schema e permite rollback do M0b sem tocar no snapshot M0a.2. A ausência de FK entre bancos é compensada por revalidação live do target.

## Alternativas consideradas

1. **App Server em stdio via `msb exec` — escolhida sob experimento.** É a única opção que combina sessão longa, histórico, eventos, approvals e interrupt mantendo a credencial na VM. Custos: supervisão de processo, schema drift e recuperação distribuída.
2. **`codex exec` ou SDK para jobs.** Menor superfície para tarefas one-shot, porém não comprova o controle interativo exigido e pode deslocar autenticação/estado para o host.
3. **Bridge ou porta dentro da VM.** Fallback apenas mediante novo ADR. Adiciona daemon, autenticação, TLS/túnel, supervisão, exposição de rede e operação.

## Consequências e restrições

- Tipos `thread/*` e `turn/*` ficam confinados ao adapter Codex; o domínio usa capacidades normalizadas.
- Claude e OpenCode poderão declarar capabilities diferentes sem fingir equivalência funcional.
- Não haverá endpoint genérico de comando, argv, cwd, path, config Codex ou lifecycle da VM.
- O M0b nunca chama `create`, `stop`, `restart`, `recreate`, `purge` ou `rm` de VM.
- A exclusividade é cooperativa entre runs do Cockpit. Escritores externos no mesmo projeto não são detectados de forma confiável e permanecem risco operacional explícito.
- Na fronteira SQLite ↔ subprocesso não há exatamente-uma-vez. Estado incerto vira `unknown`; prompts e approvals nunca são reenviados automaticamente.
- `acceptForSession` e políticas irrestritas ficam fora do M0b.

## Challenge e resposta do Tech Lead

**Veredito independente inicial:** `EXPERIMENT`; após o spike, challenge M0b.1a retornou `REVISE` e foi aceito depois das correções registradas em [m0b1a-design-challenge.md](m0b1a-design-challenge.md).

1. **Objeção:** `msb exec` full-duplex/reconnect é desconhecido. **Resposta:** spike bloqueante e falsificável antes de implementação.
2. **Objeção:** “provider é fonte autoritativa” ocultava idempotência e approvals. **Resposta:** autoridade dividida explicitamente entre thread Codex e RuntimeStore.
3. **Objeção:** redaction heurística não protege eventos/diffs. **Resposta:** serializers por allowlist, payload bruto somente transitório e approvals vinculadas ao pedido exato.

## Gatilhos de reavaliação

- versão ou schema instalado do Codex muda;
- `msb exec` exige TTY, contamina JSONL, perde stdin ou deixa processo órfão;
- reconnect pode duplicar turn ou não permite reconciliar estado;
- approval pendente não pode falhar fechada após disconnect;
- conteúdo confidencial aparece no journal, log ou métrica;
- suporte a Claude/OpenCode exige semântica que o contrato comum não expressa;
- operação precisa de porta/bridge permanente ou múltiplos operadores.

## Referências oficiais

- Codex App Server: <https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server>
- Microsandbox `msb exec` e lifecycle: <https://github.com/superradcompany/microsandbox/blob/main/docs/cli/sandbox-commands.mdx>
