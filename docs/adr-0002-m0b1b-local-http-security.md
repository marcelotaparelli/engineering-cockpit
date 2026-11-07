# ADR-0002 — segurança HTTP local M0b.1b

**Decisão:** aceita para infraestrutura somente leitura; ainda não libera prompts, approvals ou interrupt. **Data:** 2026-10-27. **Threat model:** [m0b1b-threat-model.md](m0b1b-threat-model.md).

## Opções e challenge

1. Manter apenas loopback/Host/Origin: simples, mas qualquer processo local acessa inventário; rejeitada.
2. Um operador local com credencial explícita fora do HTTP, grants de projeto, sessão opaca volátil, CSRF e lookup server-side: escolhida. Usa crypto nativo e nenhum pacote novo. Restart revoga sessões, sem alterar os runs duráveis.
3. RBAC/IdP/proxy: separação multiusuário maior, mas traz rede, dependências e operação incompatíveis com este marco local.

O Challenger exigiu bootstrap fora do HTTP, grants explícitos, 404 uniforme para IDOR e cuidado para não confundir sessão HTTP com sessão provider. A implementação exige `COCKPIT_LOCAL_TOKEN` (64 hex) e `COCKPIT_ALLOWED_PROJECTS` (CSV), autentica uma identidade local, filtra o inventário, valida VM ativa para leitura específica e resolve run → sessão → target persistido → projeto antes da resposta. `RuntimeStore.replay()` global não está exposto. Run histórico é legível sob o grant do projeto mesmo depois de VM parar/remover: ajuda a diagnosticar `unknown`; nenhuma operação privilegiada futura pode usar essa regra sem revalidação da VM e identidade da instância. O cookie de `127.0.0.1` cruza portas; por isso toda rota protegida também exige prova de sessão enviada em header, mantida em `sessionStorage` da origem com porta.

## Contrato e limites

- `GET /api/health` e assets são públicos; nenhum contém inventário. Login exige `POST` JSON, Origin exata e credencial válida. Cookie host-only `HttpOnly; SameSite=Strict; Path=/` mais `X-Session-Proof`, expira em 30 min, sem persistência server-side de sessão. A prova fica em `sessionStorage` da aba; logout exige sessão, prova, CSRF e nonce único. Login válido substitui a sessão mais antiga quando o limite de 32 é atingido.
- `GET /api/projects`, `/api/vms`, `/:id` e `/api/runs/:id` exigem sessão. Grants são nomes de projeto configurados no servidor; dados negados e ausentes retornam `resource_not_found` sem expor alvo. Logs não incluem IDs de recurso, token, cookie ou corpo.
- CSRF e nonce são consumidos antes de mutação. Retries futuros de runs precisam de nonce novo e da idempotência durável já implementada; estado `unknown` não é reenviado. Os únicos POST aceitos são login/logout.
- `RuntimeStore` é conectado ao startup para leitura de run e mantém SQLite separado privado. Reinício preserva sua recuperação `unknown`; não inicia transportes/VMs.

**Gatilhos de revisão:** múltiplos operadores, exposição por rede/proxy, grants por VM distintos dos projetos, revogação sem restart, endpoint mutável, identidade imutável de VM ou mudança na semântica de runs históricos. Antes de qualquer envio de prompt, exigir nova revisão de dispatch/idempotência, revalidação de VM e testes de approval/SSE.
