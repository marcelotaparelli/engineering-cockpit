# M0b.1a — fundação de runtime concluída

**Estado:** `COMPLETED` em 2026-10-25 para a fundação interna, sem endpoints HTTP mutáveis.  
**Base conhecida:** `d13e76eb469824b6d0505f88c1118b794cd33243`; working tree final não commitada porque o executável `git` não está disponível.  
**Runtime:** Bun 1.4.4 + TypeScript strict.

## Entrega

- contrato `ProviderAdapter` normalizado e adapter Codex App Server com suporte explicitamente pinado a 0.163.0 e 0.164.0, capabilities, eventos fechados e validação de target;
- `MsbStdioTransport` isolado, argv sem shell/TTY/porta, ambiente allowlistado, JSONL incremental, deadlines, correlação por geração, fila limitada e cleanup bounded;
- `RuntimeStore` SQLite separado do `SnapshotStore`, com `application_id`/schema próprios, diretório privado, idempotência escopada, CAS, journal canônico e recovery `unknown`;
- `RunCoordinator` com fronteira durável `prepared → dispatching → running|unknown`;
- fixtures/testes para sucesso, JSONL inválido/oversized, UTF-8, timeout, resposta tardia, EOF, stderr canário, flood, cleanup travado, idempotência, restart e rollout vazio;
- binding in-memory de approval ao request/session/run, com mismatch e replay negados.
- smoke CLI read-only para o Arch, com consentimento específico, preflight de alvo já `Running` e fluxo real restrito a `initialize → thread/list(limit=1) → close`.

O `src/server.ts` não foi alterado: a API continua GET-only e recusa POST/PUT/PATCH/DELETE. Autenticação, CSRF e autorização são pré-requisitos explícitos da futura fatia que expuser controle real.

## Evidência executada

- Bun 1.4.4 foi obtido temporariamente em `/tmp` apenas para a verificação; lock e dependências do projeto não foram alterados.
- TypeScript strict: `bun --no-env-file ./node_modules/typescript/bin/tsc --noEmit` → exit `0`.
- Testes dirigidos M0b: `bun --no-env-file test tests/m0b-provider.test.ts tests/m0b-transport.test.ts tests/m0b-runtime.test.ts` → **22 pass, 0 fail, 98 assertions**.
- Testes dirigidos do smoke: `bun --no-env-file test tests/m0b1a-smoke.test.ts tests/m0b-provider.test.ts` → **11 pass, 0 fail, 71 assertions**.
- Suíte integral final: `bun --no-env-file test` → **121 pass, 0 fail, 525 assertions**. O gate precisou de permissão para listeners efêmeros em `127.0.0.1` usados pelos testes legados; não acessou MSB real.
- Revisão independente encontrou fila ilimitada, binding insuficiente de approval, permissão de diretório e fixture oversized não consumida. Os quatro findings foram corrigidos e revalidados como `RESOLVED`.

## Correção do handshake real 0.163.0 — 2026-10-26

O smoke autorizado no Arch observou `runtime`, consentimento e alvo como PASS, mas `initialize` falhou com `rpc_protocol_error` em 532 ms; `thread/list` não foi verificado e o cleanup passou. A causa foi uma divergência dupla de contrato: o transporte enviava/exigia `jsonrpc: "2.0"`, embora o App Server 0.163.0 use envelopes JSONL tagless, e o adapter esperava `serverInfo/protocolVersion` onde a resposta real contém `userAgent`, `codexHome`, `platformFamily` e `platformOs`.

O transporte e o adapter agora seguem o perfil pinado: envelopes sem `jsonrpc`, `initialized` sem params, notificações assíncronas com `emittedAtMs` validado, quatro campos reais de initialize, plataforma `unix/linux` e token delimitado `engineering-cockpit/0.163.0`. A projeção de `thread/list` foi alinhada ao status estruturado e ao timestamp Unix. A validação continua fail-closed para drift, ambiguidade, IDs desconhecidos/duplicados e dados malformados; os diagnósticos continuam limitados a códigos seguros.

Gates após a correção: TypeScript strict exit `0`; testes focados `26/26` com `184` assertions; suíte integral `126/126` com `605` assertions. Revisões independentes de teste e segurança deram PASS local sem finding bloqueante. O smoke real não foi reexecutado neste workspace, portanto a correção ainda requer confirmação no Arch e não é declarada PASS de host.

## Gate de versão 0.164.0 — 2026-10-26

Nova evidência real reportou Codex CLI/App Server 0.164.0, initialize com os mesmos quatro campos e `provider_version_unsupported` no smoke. O gate agora aceita somente as versões explicitamente conhecidas `0.163.0` e `0.164.0`, extraídas como token completo delimitado por início/fim ou whitespace no `userAgent`; a identidade reporta a versão efetivamente observada. Versões desconhecidas, produto diferente, tokens ausentes/duplicados e valores colados a pontuação ou caracteres Unicode continuam fail-closed.

Fixtures separadas 0.164.0 cobrem o envelope initialize e thread/list. O schema gerado pelo Codex CLI 0.164.0 confirma os quatro campos de initialize e a forma de thread/list já validada: `status` discriminado como objeto, `updatedAt` em segundos Unix. TypeScript strict passou; testes relevantes passaram com **29/29** e **226 assertions**, incluindo adapter, transporte real sobre child simulado, smoke read-only com cada versão e rejeição de limites malformados do User-Agent. O smoke ao vivo após a correção não foi executado; não se declara PASS real no Arch.

## Fixtures e proveniência

`fixtures/m0b/crash-empty-rollout.json` reproduz a falha real relatada no spike: desconexão com rollout vazio resulta em `unknown`. As demais fixtures são reproduções sintéticas determinísticas de classes de falha do protocolo; não são apresentadas como captura bruta do Arch. A evidência manual do spike está separada em [m0b0-spike.md](m0b0-spike.md).

## Limites e riscos residuais

- nenhum `msb exec`, App Server ou VM real foi iniciado neste workspace; o rerun da correção no Arch e a ausência de processo remoto órfão continuam `not_verified`; veja [m0b1a-arch-smoke.md](m0b1a-arch-smoke.md);
- existe uma janela TOCTOU entre o preflight `msb list` e `msb exec`; sem primitiva atômica/no-autostart do MSB, uma mudança concorrente de estado pode invalidar a observação;
- o RuntimeStore e o adapter ainda não estão wired ao servidor/API; a ordem `markDispatching → write` é contrato do futuro orquestrador e tem teste de persistência, não teste end-to-end real;
- approval pendente não sobrevive a restart nesta fatia; perda de transporte invalida o handle e não há replay;
- `idempotency_key_hash` usa SHA-256 e pressupõe chave aleatória de alta entropia; não deve receber segredo humano reutilizável;
- métricas/exporter, traces, alertas e SLO numérico não foram configurados; journal e códigos sanitizados são evidência local, não observabilidade de produção;
- não houve push, deploy, alteração de VM, launcher, mount ou credencial.

Veja [m0b1a-verification.json](m0b1a-verification.json), [m0b1a-design-challenge.md](m0b1a-design-challenge.md) e [m0b1a-ownership-card.md](m0b1a-ownership-card.md).
