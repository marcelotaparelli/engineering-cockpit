# ADR-0003 — F1: sessão deslizante, nova aba e serviço systemd de usuário

**Data:** 2026-11-08 · **Fase:** F1 do [master plan v2](master-plan.md) (lacunas L2, L3) · **Complementa:** [ADR-0002](adr-0002-m0b1b-local-http-security.md), sem revogar nada dele.
**Estado:** implementada na branch `feat/f1-daily-ops`. A revisão independente da política de sessão (Codex) pedida pelo master plan **continua pendente**. Houve uma revisão independente por outro agente (Claude), registrada em [f1-operacao-diaria.md](f1-operacao-diaria.md) §4.

## 1. Sessão HTTP deslizante (L2)

**Antes:** 30 min absolutos desde o login. Uma nova aba exigia novo login.

**Decisão:**
- A sessão termina após **30 min sem atividade do operador** ou **12 h após o login**, o que vier primeiro (`SESSION_IDLE_MS`, `SESSION_MAX_MS` em `src/local-security.ts`).
- O teto absoluto nunca se move.
- O cookie (`HttpOnly; SameSite=Strict; Path=/`) vive até o teto (`Max-Age=43200`). O prazo de ociosidade é verificado no servidor a cada requisição.

**O que conta como atividade** (é o único caminho de `touch`):
1. Uma mutação que passou no CSRF e no nonce de uso único. Só o script da própria página consegue enviá-la.
2. `GET /api/auth/session` com o cabeçalho `X-Session-Activity: user`. A página só o envia depois de entrada real (teclado, ponteiro, roda, toque), no máximo 1×/min. Qualquer outro valor é ignorado.

**O que não conta:** leituras autenticadas, o polling do painel, o stream SSE e seus heartbeats. Uma aba esquecida aberta expira sozinha em 30 min, e o SSE é encerrado quando o prazo passa.

**Divergência com o master plan (registrada):** o §7 diz "`touch` em cada autenticação". O brief da F1 proíbe "renovar autenticação apenas por polling automático". Isso é incompatível com tocar em toda requisição autenticada, porque o painel faz polling e mantém o SSE. Foi seguida a regra mais restritiva do brief, que preserva o objetivo do plano ("ociosa 30 min, máx. 12 h").

**Preservado sem mudança:**
- credencial fora do HTTP e taxa de falhas de login (5/min);
- prova em cabeçalho além do cookie, contra o cookie de `127.0.0.1` que cruza portas;
- CSRF e nonce de uso único, Origin/Host/Sec-Fetch-Site, 404 uniforme e grants por projeto;
- sessões só em memória: um reinício revoga todas;
- máximo de 32 sessões;
- o login sempre cria um identificador novo, sem fixação. Um cookie que o servidor não emitiu é recusado.

**Ajuste:** a capacidade de nonces por sessão passou de 256 para 4096. Com 12 h, 256 mutações esgotariam a sessão (`nonce_capacity_reached`). A proteção contra replay continua valendo por toda a sessão, sem expiração de nonces.

**Revogação:** logout (imediato, também nas outras abas da mesma sessão), reinício do serviço (todas as sessões), rotação da credencial seguida de reinício.

## 2. Nova aba reaproveita a sessão (critério 4 da V1)

A prova de sessão continua só no `sessionStorage` da aba.

**Fluxo:** uma aba nova sem prova pede, por `BroadcastChannel('cockpit-session')`, a prova de uma aba já autenticada da **mesma origem** (esquema + host + **porta**). Em seguida, ela valida a prova com `GET /api/auth/session`.

**Garantias:**
- A prova nunca vai para URL, cookie ou `localStorage`, nem para outra porta de `127.0.0.1`.
- Sem aba aberta, o login é pedido normalmente.
- Num 401, a aba tenta uma prova **diferente** da que falhou, por exemplo quando outra aba fez login de novo. A mesma prova não é reaproveitada.
- **Risco aceito:** qualquer script na origem do Cockpit pode ler a prova. Isso já era verdade com o `sessionStorage`, e o CSP continua `script-src 'self'`, só com os assets fixos do servidor.

## 3. Serviço systemd de usuário (L3)

`./scripts/cockpit service install` gera:
- `~/.config/engineering-cockpit/token`: credencial, 0600, diretório 0700, gerada se ausente ou importada do ambiente (`--import-env-token`, que substitui a anterior), nunca de argv;
- `~/.config/engineering-cockpit/cockpit.env`: só configurações não secretas, 0600, chaves em allowlist;
- `~/.config/systemd/user/engineering-cockpit.service`, a partir de `tools/systemd/cockpit.service`.

O comando só faz `daemon-reload`: **não habilita nem inicia nada**.

**Credencial:** o Cockpit lê a credencial de `COCKPIT_LOCAL_TOKEN_FILE` (`src/config.ts`) com estas verificações:
- `O_NOFOLLOW`, arquivo regular, dono = usuário, sem bits de grupo/outros;
- diretório do mesmo dono e sem escrita por outros.

O valor nunca entra no ambiente do processo nem no de seus filhos. `COCKPIT_LOCAL_TOKEN` e `COCKPIT_LOCAL_TOKEN_FILE` juntos são recusados (`local_credential_ambiguous`). A unit descarta `COCKPIT_LOCAL_TOKEN` herdado do gerenciador (`UnsetEnvironment=`).

**Política da unit:**

| Diretiva | Por quê |
| --- | --- |
| `Restart=on-failure`, `RestartSec=5`, `StartLimitBurst=3` em 300 s | Reinicia após queda, nunca em laço infinito |
| `RestartPreventExitStatus=78` | Início recusado (configuração, credencial, porta, `runtime_database_in_use`, host) sai com 78 e **não** é reiniciado: reiniciar bateria no mesmo conflito de posse |
| `KillMode=process`, `KillSignal=SIGTERM`, `TimeoutStopSec=30` | No `stop`, só o Cockpit recebe SIGTERM e encerra seus filhos em ordem (`cockpit_shutdown`). Após uma queda, os filhos `msb exec` **não** são mortos pelo systemd: continuam visíveis no registro de órfãos e bloqueiam envios até o operador conferir a VM (runbook E4). Com `control-group`/`mixed`, o systemd mataria um processo que pode ainda estar executando um turno, sem a conferência exigida |
| `NoNewPrivileges=yes`, `UMask=0077`, sem `User=` | Roda como o próprio operador, sem ganhar privilégios |

**Reinício não executa nada sozinho:** runs em andamento viram `unknown` (`process_restarted`), `prepared` vira `failed` (`not_dispatched_before_restart`), e nada é reenviado, como no E4.

**Comandos:** `start` e `restart` rodam antes o `doctor` e recusam iniciar se houver item bloqueante:
- outra instância é dona do banco ou da porta;
- permissões erradas;
- configuração inválida;
- Bun ou msb ausentes.

**Alternativa não adotada: `LoadCredential=`.** O suporte em units de usuário varia com a versão do systemd e não pode ser testado aqui. O arquivo 0600 lido pelo próprio Cockpit funciona igual em terminal e em serviço.

## 4. VMs reservadas (D8) e estado `unsupported` (L6)

- `COCKPIT_RESERVED_VMS` (CSV de nomes de VM de agente) **acrescenta** VMs reservadas. `claude-engineering-cockpit` fica **sempre** reservada: um valor vazio ou digitado errado não a desprotege.
- A reserva vale para qualquer provider (`ExecutionService.supports`) e chega também ao guard de argv do Claude.
- **A decisão D8**, sobre poder operar a VM de desenvolvimento, **continua do Tech Lead**. Exigiria uma mudança de código, não de configuração. Isso endurece a primeira versão desta F1, que aceitava lista vazia, e seguiu a revisão independente.
- Uma VM observada que o Cockpit não opera (provider sem adapter ou reservada) aparece como **"Sem suporte"** com o motivo. Antes ela aparecia como "Offline · VM parada".
