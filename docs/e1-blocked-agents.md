# E1 — agentes bloqueados na inbox de atenção

**Estado:** E1 passou em testes simulados (fake Codex: 163 pass / 0 fail), mas **ainda NÃO foi homologado com um `request.unsupported` real no Arch**; nenhum prompt real, VM ou processo do Arch foi tocado.

## Comportamento
- **`blocked` é derivado, não persistido.** Um run `running` cujo Codex enviou um *server request* que o Cockpit não sabe responder (`request.unsupported`: user input, permissões, tool calls…) é exibido como `blocked`. Não há novo status de run, coluna ou migração; o estado vive em memória (`ExecutionService.blockedRequests`) e some quando o run termina, o transporte cai ou o Cockpit reinicia (nesse caso o run já vai a `unknown`, regra existente).
- **Sem falso "trabalhando":** `agentState` devolve `blocked` em vez de `working`; contadores (`counts.blocked`), lista de agentes e chip do run mostram "Travado — precisa de você".
- **Inbox ("Precisa de você"):** um cartão por (run, método) com o método pedido, nº de ocorrências, motivo e ação ("abra a sessão, interrompa e reformule o prompt"); botão "Abrir e interromper".
- **Sem duplicação:** pedidos equivalentes (mesmo run + mesmo método) viram uma entrada com contador; journal e notificação ao vivo só na primeira ocorrência (eventId determinístico).
- **Sem autoaprovação:** o Cockpit continua não respondendo ao pedido; a única saída é a ação humana (interrupt).
- **Discovery:** `Discovery.cached(3s)` serve apenas leituras de exibição (`/api/dashboard`); erros não são cacheados. `refresh()` sempre observa o MSB e é o que `ExecutionService.revalidate` usa antes de **todo** envio/histórico/reconcile — a revalidação da VM não é enfraquecida pelo cache.

## Testes
`tests/e2e-execution.test.ts` (blocked → attention única com 2 ocorrências → interrupt → limpa), `tests/discovery.test.ts` (cache vs refresh, erro não cacheado), `tests/frontend.test.ts` (lista, inbox, chip, abrir sessão).

## Falta validar no Arch
Um Codex 0.166.0 real que emita um server request não suportado (ex.: prompt que force `item/tool/requestUserInput`) — só a forma sintética foi testada. Streaming incremental (pendência herdada do E0) pode ser observado na mesma sessão.
