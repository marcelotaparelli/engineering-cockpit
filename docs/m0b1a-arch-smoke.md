# M0b.1a — smoke read-only no Arch

**Atualização 2026-11-07:** o operador informou que o rerun pós-correção **passou no Arch em 2026-10-26** com Codex App Server 0.164.0 (`initialize`, `thread/list`, `close` = PASS). Registrado como atestado manual do operador; a saída bruta não foi anexada.

**Estado em 2026-10-26 (histórico):** houve dois FAILs observados no Arch, com correções verificadas localmente; o rerun real permanece `NOT_VERIFIED`. Primeiro, 0.163.0 falhou em `initialize` com `rpc_protocol_error` após 532 ms. Depois, o ambiente real reportou Codex CLI/App Server 0.164.0 com os mesmos quatro campos de initialize e falhou com `provider_version_unsupported`. Nenhuma validação local é apresentada como PASS do host.

## Evidência do FAIL e causa raiz

Checks observados no Arch: `runtime=PASS`, `host_consent=PASS`, `target_running=PASS`, `initialize=FAIL (rpc_protocol_error, 532 ms)`, `thread_list=NOT_VERIFIED`, `close=PASS`.

O Codex App Server 0.163.0 respondeu com um envelope JSONL tagless contendo `id` e `result`; dentro de `result`, os campos reais são `userAgent`, `codexHome`, `platformFamily` e `platformOs`. O transporte exigia `jsonrpc: "2.0"` e rejeitava esse frame antes do adapter. Depois desse ponto, o adapter ainda esperaria os campos inexistentes `serverInfo.version` e `protocolVersion`. O parser JSONL não era a causa.

A correção fixa o perfil 0.163.0 sem `jsonrpc`, mantém correlação estrita, envia `initialized` sem `params`, aceita somente `emittedAtMs` inteiro não negativo em notificações assíncronas e valida os quatro campos reais sem registrá-los. `thread/list` também foi alinhado ao status estruturado e ao `updatedAt` em segundos Unix para não deslocar a falha para o passo seguinte.

O gate de versão agora aceita explicitamente apenas `engineering-cockpit/0.163.0` e `engineering-cockpit/0.164.0`, exatamente uma vez como token delimitado por início/fim ou whitespace no `userAgent`; a versão devolvida na identidade é a observada. Pontuação colada, caracteres Unicode adjacentes, outros produtos, versões fora da allowlist e tokens duplicados continuam rejeitados como `provider_version_unsupported`. O schema gerado pelo Codex CLI 0.164.0 confirma que `initialize` mantém os quatro campos e que `thread/list` mantém `status` estruturado e `updatedAt` inteiro em segundos Unix.

## Comando no host autorizado

O alvo deve ser uma VM Codex **já em estado `Running`**. Da raiz do repositório, com Bun 1.4.4 e `msb` no `PATH`:

```sh
COCKPIT_MODE=host \
COCKPIT_HOST_CONFIRMED=yes \
COCKPIT_M0B1A_SMOKE_CONFIRMED=yes \
COCKPIT_SMOKE_VM=codex-demo \
./scripts/cockpit m0b1a-smoke
```

Substitua `codex-demo` pelo nome exato da VM Codex já em execução.

O consentimento é exato e específico para o smoke. Antes de criar o transporte, o comando confirma Linux/Arch, recusa indicadores conhecidos de guest, executa somente `msb list --format json` e exige que o alvo exato já esteja `Running`. Só então instancia `MsbStdioTransport` e `CodexAppServerAdapter` reais.

Fluxo RPC permitido: `initialize` → notificação `initialized` exigida pelo protocolo → `thread/list` com `{ "limit": 1 }` → `close`. Não há `thread/start`, `thread/resume`, `thread/read`, `turn/*`, prompt, aprovação ou endpoint HTTP.

## Critérios e exit codes

- `PASS` / exit `0`: runtime e host autorizados; alvo exato observado como `Running`; App Server identifica Codex 0.163.0 ou 0.164.0; `initialize` e `thread/list(limit=1)` concluem; no máximo uma thread é retornada; cleanup conclui.
- `FAIL` / exit `1`: runtime incompatível, inventário/protocolo inválido, falha de spawn/transporte/deadline, versão não suportada, retorno acima do limite ou falha no cleanup após a conexão. O relatório contém apenas códigos sanitizados.
- `NOT_VERIFIED` / exit `2`: consentimento ausente, ambiente não Arch/guest, alvo ausente ou alvo não `Running`. Nesses casos não se declara validação; antes da consulta de inventário nenhuma chamada MSB ocorre, e alvo ausente/parado não cria o transporte.

O JSON de saída não contém nome da VM, projeto, IDs de thread, variáveis de ambiente, stdout ou stderr. Registra somente resultado, códigos estáveis, duração, identidade do protocolo e contagem `0|1`.

## Evidência desta sessão

- `bun --no-env-file ./node_modules/typescript/bin/tsc --noEmit` → exit `0`.
- `bun --no-env-file test tests/m0b-provider.test.ts tests/m0b-transport.test.ts tests/m0b1a-smoke.test.ts` → `29 pass`, `0 fail`, `226 expect()`.
- `bun --no-env-file test` → `126 pass`, `0 fail`, `605 expect()`; listeners loopback dos testes foram autorizados, sem MSB real.
- A regressão integrada usa `MsbStdioTransport` e `CodexAppServerAdapter` reais com fixture sanitizada derivada da forma observada, notificação anterior à resposta, `initialized` tagless e `thread/list` real-shaped.
- Codex CLI/App Server 0.164.0: `initialize` real reportado com os mesmos quatro campos; o FAIL de versão foi reproduzido localmente com fixture. O schema 0.164.0 gerado localmente confirma a forma de `initialize` e `thread/list`; o smoke pós-correção segue pendente no Arch.
- Revisões independentes de teste e segurança: `PASS` no escopo local, sem finding bloqueante.
- CLI sem consentimento neste Debian → `NOT_VERIFIED`, `host_confirmation_required`, exit `2`.
- CLI com consentimento e alvo sintético neste Debian → `NOT_VERIFIED`, `arch_host_required`, exit `2`, antes de MSB.

A fixture preserva somente a forma e a gramática necessárias ao contrato; paths, request/thread IDs e demais valores foram substituídos. Ela não é uma captura bruta do host.

## Risco residual

Há uma janela TOCTOU entre o `msb list` read-only e o `msb exec --stream`: se outro ator parar a VM nessa janela e o MSB iniciar automaticamente alvos parados, o preflight não é garantia atômica de ausência de start. O smoke não oferece bypass e documenta esse limite; um PASS no Arch prova o fluxo observado, não elimina essa corrida. Fechar o risco exige suporte atômico/no-autostart no MSB antes de ampliar o uso.

Não houve mudança em VM, push, deploy ou endpoint HTTP. Autenticação, CSRF e autorização continuam pré-requisitos para qualquer controle real via HTTP. Um PASS de M0b.1a exige repetir o comando acima no Arch autorizado.
