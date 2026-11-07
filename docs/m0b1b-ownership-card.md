# Ownership Card — M0b.1b

**Versão:** working tree de 2026-10-27; base Git registrada anteriormente `d13e76eb469824b6d0505f88c1118b794cd33243`, sem novo commit. Artefato final identificado por `docs/artifact.sha256`. **Estado humano:** exercício `unreviewed`; explicação não demonstra domínio.

## Fluxo que o owner precisa conseguir traçar

1. `src/config.ts:11` recebe credencial e grants explícitos. `src/index.ts:19` valida ambos antes de abrir o servidor e `src/index.ts:23` conecta o RuntimeStore privado de leitura.
2. `src/server.ts:95` rejeita Host/Origin/Fetch Metadata, query e método; login lê JSON limitado, `src/local-security.ts:43` compara a credencial e cria cookie, prova e CSRF aleatórios. `src/server.ts:110` entrega cookie HttpOnly/SameSite e prova separada. A UI mantém a prova em `sessionStorage` da origem com porta, porque cookies loopback cruzam portas.
3. `src/server.ts:123` autentica cookie **e** `X-Session-Proof` nas APIs; logout exige CSRF e nonce em `src/local-security.ts:76` antes de revogar. Inventário é filtrado por grants; VM específica exige snapshot atual, running e não órfã em `src/local-security.ts:94`.
4. `src/server.ts:132` resolve run por ID; `src/local-security.ts:101` obtém a sessão persistida e verifica grant do projeto. `src/runtime-store.ts:189` valida o vínculo target–VM–projeto. Run histórico `unknown` é legível, mas nenhum POST de prompt/approval/interrupt existe.

## Invariantes e diagnóstico

- `401` para sessão ausente/expirada, `403` para origem/CSRF/replay, `404/resource_not_found` igual para recurso ausente e fora do grant, `429` para limites e `503` para discovery indisponível.
- `src/runtime-store.ts:207` mantém idempotência por chave/digest em transação; `src/runtime-store.ts:305` mantém recuperação conservadora em `unknown`. A API não invoca `beginRun` nem provider.
- Investigue por `request_id`/`trace_id`, rota fixa, evento e `error_code` em `src/server.ts:162`. Não copie cookie, credencial, prova ou ID de run para logs. Testes relevantes: `tests/server.test.ts:45` e `tests/local-security.test.ts:6`.
- Se a UI indicar falha de logout, confirme a resposta HTTP; ela não deve afirmar revogação depois de `401`, `403` ou erro de rede. `public/app.js:63` limpa inventário e mostra login com aviso de saída não confirmada no `401`; no `403` mantém o estado e exibe falha. Com múltiplas abas, a última pode trocar o cookie compartilhado e invalidar a prova da anterior.

**Exercício curto (`unreviewed`):** execute `bun --no-env-file test tests/server.test.ts tests/local-security.test.ts` e explique por que um run `unknown` autorizado retorna 200, um run fora do grant e um ausente retornam o mesmo 404, e por que dois pedidos com o mesmo nonce não executam duas mutações. Antes de habilitar prompts, revise o ponto de revalidação da identidade da VM no dispatch.
