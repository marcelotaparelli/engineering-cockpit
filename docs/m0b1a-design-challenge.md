# M0b.1a — design challenge e decisão do Tech Lead

**Veredito inicial independente:** `REVISE`, confiança alta.  
**Decisão final do Tech Lead:** `ACCEPT` para a fundação interna M0b.1a, após revisões e regressões locais. Não autoriza controle HTTP real.

## Objeções e resposta

1. **A fronteira SQLite → processo podia alegar exactly-once sem prova.** O RuntimeStore agora grava `prepared`, e o coordenador exige a transição CAS para `dispatching` antes de qualquer write. Reinício converte `dispatching`, `running` e `awaiting_approval` em `unknown`; retry da mesma chave retorna o mesmo run com `executionCount=1`. A integração futura deve manter a ordem `markDispatching → startRun`; ela ainda não está wired a HTTP.
2. **Timeout, resposta tardia e teardown podiam cruzar requests ou deixar recursos sem limite.** IDs incluem uma geração UUID da conexão, o deadline remove a pendência antes de rejeitar, resposta desconhecida/tardia falha fechada, stderr e fila de eventos são limitados e o cleanup é idempotente, com grace, `SIGKILL` somente do filho possuído e tentativa bounded de reap. Ausência de processo remoto órfão permanece `not_verified` até smoke real no Arch.
3. **O adapter podia fingir capabilities ou vazar semântica Codex.** Eventos são uma union fechada; métodos não suportados retornam `provider_capability_unsupported`; status terminal ausente/desconhecido vira `unknown`; nomes `thread/*` e `turn/*` ficam no adapter Codex. Approval é vinculada em memória ao trio request/session/run, retirada antes do write e recusa mismatch/replay. Persistência/CAS de approval fica para a fatia autenticada, antes de qualquer endpoint mutável.

## Alternativas

- Adapter Codex específico sem contrato comum: menor abstração, mas não atende ao requisito de `ProviderAdapter` e posterga o teste com fake não-Codex.
- Contrato comum sem marker de dispatch: menos código, mas mantém ambiguidade perigosa após crash.
- Bridge/porta na VM: rejeitado nesta fatia; acrescentaria autenticação, daemon e superfície de rede sem necessidade após o spike full-duplex.

## Gatilhos de reavaliação

- mudança de versão/schema do Codex App Server ou sintaxe/comportamento do MSB;
- smoke real encontra processo órfão, framing contaminado ou cleanup inconclusivo;
- futuro orquestrador chama provider antes de persistir `dispatching`;
- approval precisa sobreviver a restart ou ganhar alcance HTTP;
- outro provider não cabe no contrato sem campos wire abertos.

Tokens, custo e latência por agente não foram medidos.
