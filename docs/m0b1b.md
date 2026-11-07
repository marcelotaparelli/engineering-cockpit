# M0b.1b — segurança HTTP local

**Estado:** infraestrutura implementada e verificada localmente em 2026-10-27. Sem envio de prompts, approval, interrupt, SSE, VM real, push ou deploy. Base Git lida de `.git/refs/heads/main`: `d13e76eb469824b6d0505f88c1118b794cd33243`; não houve novo commit. SHA-256 do manifesto final `docs/artifact.sha256`: `170d2e09788708139e6f71b6200409f194294f80c40ee18a2f640e565bd51c26`. O manifesto cobre código, testes, fixtures, locks e README; exclui relatórios.

## Contrato entregue

- Credencial local explícita de 64 hex e grants de projeto configurados no processo; startup falha fechado. Sessão aleatória em memória, cookie host-only HttpOnly/SameSite Strict **mais prova em `X-Session-Proof` guardada na origem com porta**, expiração 30 min, rotação e logout. Login JSON limitado, Origin exata, Host/Fetch Metadata, comparação em tempo constante e limite para credenciais inválidas sem bloquear credencial correta. Logins válidos substituem a sessão mais antiga ao limite de 32.
- CSRF ligado à sessão e nonce de uso único no logout. Limites de sessões/nonces. A interface não salva a credencial e não afirma logout se o servidor o rejeitar.
- Inventário filtrado; consulta específica de projeto/VM autorizada; consulta de run resolve vínculo persistido run→sessão→VM/projeto. Negado e ausente usam `404/resource_not_found`. Run histórico `unknown` permanece legível sob grant do projeto, sem replay ou dispatch.
- RuntimeStore privado conectado à API de leitura. `beginRun`, state machine, idempotência e recuperação `unknown` não foram alterados; nenhum handler os usa para iniciar trabalho. Os únicos POST são login/logout.

## Evidência local

| Gate | Comando / resultado |
| --- | --- |
| TypeScript strict | `tools/runtime/node_modules/.bin/bun --no-env-file ./node_modules/typescript/bin/tsc --noEmit` → exit 0 |
| Suíte integral final | `tools/runtime/node_modules/.bin/bun --no-env-file test` → exit 0; 113 pass, 0 fail, 664 assertions, 14 arquivos |
| Manifesto | `tools/runtime/node_modules/.bin/bun --no-env-file scripts/artifact.ts --check` → exit 0, `PASS artifact manifest` |
| Escopo de execução | Bun 1.4.4 em Debian/workspace; testes HTTP usaram listeners efêmeros `127.0.0.1` com fixtures e permissão de sandbox; sem MSB ou VM real |

Testes cobrem login/falha/rotação/expiração, cookie, grants cross-project, IDOR uniforme, CSRF, nonce concorrente, logout concorrente, Host/Origin/Fetch Metadata, body e método negados, falha de discovery, leitura de `unknown`, UI e ausência de endpoints de execução. O teste existente do RuntimeStore cobre idempotência e restart para `unknown`. Um gate legado do host-check passou a fazer uma requisição sintética extra de login; a expectativa foi atualizada de 10 para 11. Não há CI externa autenticada nem smoke Arch deste incremento.

## Revisões e riscos

- **Challenger:** recomendou principal local único + allowlist explícita, recusou loopback como autenticação e pediu 404 uniforme antes de lookup/serialização. Decisão em [ADR-0002](adr-0002-m0b1b-local-http-security.md).
- **Red Team `static-local`:** confirmou bloqueio indevido da credencial correta após cinco falhas e rotação impedida no limite de 32 sessões; ambos corrigidos e cobertos em `tests/local-security.test.ts`. Suspeitou divergência sobre run de VM removida; política de leitura histórica agora explícita no [threat model](m0b1b-threat-model.md). A revalidação estreita da prova de sessão não encontrou bypass; apontou inventário ainda renderizado após logout 401, corrigido, testado e revalidado estaticamente como resolvido. Nenhum teste ofensivo em serviço real/VM.
- **Security Reviewer:** confirmou lacuna inicial de autenticação; apontou auditoria de cookie inválido, falso logout, e efeito de múltiplas abas após adicionar a prova de sessão. Corrigidos e cobertos por testes; revisão estática final sem novo HIGH/MEDIUM. Não encontrou rota HTTP de dispatch. Findings HIGH/CRITICAL confirmados abertos: nenhum nos casos examinados; isso não afirma ausência de vulnerabilidades.
- **Riscos residuais:** processo malicioso sob mesmo UID pode ler ambiente/memória; servidor malicioso que assumir a mesma porta após o Cockpit sair pode servir script na mesma origem e ler a prova em `sessionStorage`; múltiplas abas exigem login próprio e podem invalidar o cookie da outra; o inventário não prova identidade imutável de VM; grants por projeto não isolam credenciais compartilhadas do provider; sessão volátil revoga no restart; a consulta de run histórico não revalida VM atual por decisão. Antes de mutação futura, revalidar identidade/estado da VM junto ao dispatch e revisar CSRF/idempotência/approval/SSE.

## Observabilidade e operação

Logs JSON allowlistados trazem `request_id`, `trace_id`, rota fixa, status, duração, evento (`auth_succeeded`, `auth_failed`, `csrf_denied`, `replay_denied`, `authz_denied`) e código seguro. Testes locais exercitam sucesso, falha, authz negada, correlação e ausência de canários em logs. O `trace_id` é correlação local, não span/exporter OTel. Métricas, ingestão externa, retenção, alertas e SLO numérico: **não configurados/não verificados**. SLI proposta para futura operação: razão de authn negada, authz negada e erro HTTP por rota fixa, com cardinalidade limitada; definir alerta após baseline real e runbook do host. O runbook local é: verificar código/evento/ID de correlação, confirmar grants/estado do runtime sem copiar tokens, e nunca reenviar um run `unknown`.

Agentes usados: Challenger, Security Reviewer, Red Team static-local e Technical Ownership Mentor. Tokens/custo/latência por agente não medidos por fonte confiável. O [Ownership Card](m0b1b-ownership-card.md) está explicado, mas o exercício e a compreensão humana seguem `unreviewed` no [ledger](m0b1b-ownership-ledger.json).
