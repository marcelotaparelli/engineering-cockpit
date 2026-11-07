# M0b.1b — threat model HTTP local

**Estado:** design anterior à implementação. **Escopo:** servidor HTTP loopback e leitura do inventário/runtime. Não há rota de envio de prompts, approval ou comando à VM neste marco.

## Ativos, atores e fronteiras

- Ativos: nomes e estado de VMs/projetos, vínculo projeto–VM–sessão–run, estado do run (`unknown` inclusive), credencial local, cookies e tokens CSRF. Prompts, provider auth, transcript e mounts permanecem fora da API.
- Principal: um operador local autenticado por `COCKPIT_LOCAL_TOKEN` (64 hex, fornecido ao processo) com grants explícitos em `COCKPIT_ALLOWED_PROJECTS`. Sem ambos, o startup falha fechado. Ser loopback, ter `Host` válido ou ser o mesmo UID não autentica ninguém. O navegador, headers, path, cookie e IDs fornecidos pelo cliente são não confiáveis.
- Fronteira 1: cliente → HTTP loopback. Requer Host/Origin/Fetch Metadata, login explícito, sessão aleatória privada, cookie `HttpOnly; SameSite=Strict` **e prova independente em `X-Session-Proof`**, prazo curto e CSRF nas mutações. A prova fica em `sessionStorage` da origem exata (incluindo porta), enquanto o cookie é host-only e compartilhado entre portas. Cookie sozinho não autoriza leitura. Nenhum CORS.
- Fronteira 2: principal → projetos/VMs. Grants de projetos configurados explicitamente; inventário filtrado; VM precisa pertencer a projeto permitido e vir de descoberta atual. `vm_name` nunca é autorização.
- Fronteira 3: principal → sessão/run persistidos. Resolver o pai no servidor e validar o vínculo persistido VM–projeto–sessão–run antes de devolver run; IDs opacos isolados não conferem acesso. Runs históricos permanecem legíveis sob o grant do projeto mesmo se a VM já estiver parada/removida, inclusive `unknown`, para diagnóstico. Qualquer mutação futura exige revalidação da VM atual e sua identidade. Recurso ausente e recurso negado têm o mesmo status/código público. `RuntimeStore.replay()` global não é fonte direta para HTTP/SSE.
- Fronteira 4: HTTP → provider/VM. Fechada neste marco. A camada HTTP não chama `startRun`, `msb exec`, approval ou interrupção.

`GET /api/health` e assets públicos não incluem inventário. `POST /api/auth/login` recebe somente JSON + Origin exata; `GET /api/auth/session` e logout exigem cookie. Inventário, projeto, VM e run exigem sessão; logout também exige CSRF e nonce único. Não há emissão de sessão em GET anônimo.

## Hipóteses de ataque prioritárias

| Ameaça | Controle verificável |
| --- | --- |
| Página remota ou processo local consulta inventário | Inventário exige sessão; Host/Origin/Fetch Metadata continuam estritos; login exige credencial e JSON; erro não vaza inventário. |
| Cookie ambient é usado para CSRF ou vaza a outro serviço loopback em porta diferente | Toda rota protegida exige cookie + prova de sessão por header; mutações exigem Origin exata, JSON, CSRF por sessão e nonce de uso único; logout revoga sessão. |
| Cookie/nonce antigo ou corrida repete uma ação | Sessão expira e pode ser revogada; nonce é consumido atomicamente antes da ação. Retry legítimo de run futuro usa nonce novo e `Idempotency-Key`/digest existente. |
| IDOR por VM, projeto ou run | Grants server-side, relação VM–projeto e run–sessão–target; negação uniforme, sem lookup baseado apenas no ID. |
| Snapshot stale, VM órfã/parada ou troca concorrente | Toda autorização de VM usa `refresh` atual; execução futura deverá revalidar imediatamente antes do dispatch. Não há dispatch nesta fase. |
| Brute force, cookie fixado, logs sensíveis | Comparação de credencial em tempo constante, limite de tentativas, sessão gerada pelo servidor e rotacionada em login, logs allowlistados sem cookie/token/ID de recurso. |
| Restart em estado incerto ou retry de run | Não alterar schema nem estado do RuntimeStore; `unknown` nunca vira sucesso por leitura HTTP; sem reenvio automático. |

## Limites e risco residual

- Outro processo malicioso no mesmo UID pode ler o ambiente/memória do processo conforme as permissões do sistema; isto não é isolamento de SO.
- HTTPS não é usado em loopback. Proxies, túneis, aliases de Host e acesso LAN permanecem fora de escopo e bloqueados.
- Sessões são voláteis: reinício invalida cookies. Isso não muda runs duráveis nem resolve `unknown`.
- Uma aba nova sem prova em `sessionStorage` exige novo login. Logins válidos mantêm no máximo 32 sessões, substituindo a mais antiga ao atingir o limite. Com várias abas, o cookie compartilhado pode apontar para a sessão de outra aba; uma falha de logout é mostrada como não confirmada, nunca como revogação bem-sucedida.
- Um processo local que assumir a **mesma porta** depois que o Cockpit sair pode servir script na mesma origem e ler `sessionStorage` daquela origem; esta topologia HTTP local não fornece identidade criptográfica do servidor. Feche o navegador e limpe a sessão se a porta for disputada.
- Telemetria local registra código, rota fixa, status, duração e IDs de correlação. Exporter, retenção central, alertas e validação no Arch permanecem não verificados.
