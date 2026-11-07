# M0a — decisões e evidências

> Histórico da entrega M0a. As instruções de ferramentas temporárias foram substituídas pelo [M0a.1](m0a1.md) e pelo [README atual](../README.md). `artifact.sha256` identifica a entrega atual, não autentica esta execução histórica.

## Escopo e triagem

Tier `standard`: feature local com contratos, persistência e entrada de subprocesso. Aceite desta fatia: descoberta mock explicitamente rotulada; `GET /api/health`, `GET /api/vms` e lista de projetos; normalização de VM; seleção na UI; persistência SQLite; testes de parse, nomes, isolamento e ausência de shell arbitrário. Integração real no Arch host permanece `not_verified`.

O marco não implementa M0b/M0c: não há execução Codex, sessões, runs, SSE, interrupção, CI ou dashboard. Instrumentação básica apenas sustenta o diagnóstico desta fatia.

## Decisão e challenge

Decisão: Bun nativo, SQLite nativo, frontend sem framework, mock por padrão e adapter host com opt-in explícito. Alternativas: manter somente documentação não entrega descoberta; descoberta automática no host viola o limite do ambiente. Não se introduzem serviços ou dependências de runtime.

Challenger independente recomendou `EXPERIMENT`, confiança média. Respostas do Tech Lead:

1. **Formato real desconhecido:** fixtures sintéticas; rejeitar formato desconhecido e parse parcial em vez de inferir VMs. Reavaliar com amostra real autorizada/versionada do CLI.
2. **Allowlist insuficiente contra symlinks:** aceitar somente nomes conservadores de filhos diretos que sejam diretórios, sem seguir links nem abrir conteúdo. Testar links, arquivos e traversal.
3. **Snapshot antigo disfarçado de atual:** gravar apenas descoberta integral bem-sucedida, em transação. Falha retorna erro explícito; banco anterior não é resposta atual. Origem e timestamp acompanham os dados.

## Segurança e fronteiras

- O navegador não escolhe comandos, paths ou argumentos de subprocesso. O único comando do adapter é `msb list`, em array e sem shell, com tempo e saída limitados.
- API somente GET, recursos estáticos em allowlist, bind loopback e validação de autoridade/origem da requisição. Esse modelo protege o navegador contra origens externas; não autentica processos locais maliciosos. A máquina/conta local é uma fronteira de confiança do M0a.
- Apenas filhos diretos da base de projetos configurada pelo operador. Não há filesystem browser. Nenhuma leitura de `state`, `shared/*-auth`, `.aws`, `.env` ou configurações Codex.
- SQLite próprio do Cockpit, com snapshots limitados aos metadados atuais. Não migrar bancos/sessões de outros aplicativos. Não expor caminhos absolutos, stdout/stderr bruto nem nomes de projetos em logs.
- A seleção não reserva árvore de trabalho e não garante exclusão com escritores externos. O controle de escrita só será relevante quando houver execução, fora desta fatia.

## Operação e observabilidade proporcional

Mock local (default):

```sh
bun run start
```

Configuração futura do adapter, **somente no Arch host autorizado** (não executada nesta entrega):

```sh
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" bun run start
```

`COCKPIT_PROJECTS_BASE` é configuração local do operador; nenhum endpoint aceita alterá-la. Os bancos são `data/cockpit-mock.sqlite` e `data/cockpit-host.sqlite`, relativos ao diretório de execução. Não usar diretório compartilhado com usuários não confiáveis. A confirmação é um opt-in, não prova técnica de que o processo está no host.

Smoke futuro no host: obter amostra sanitizada de `msb list`, registrar versão do CLI, ajustar fixture se necessário e repetir parser/typecheck; iniciar Cockpit explicitamente em modo host; abrir a URL loopback; comparar projetos/VMs/status com a amostra. Selecionar uma VM e confirmar ausência de execução/controle; simular indisponibilidade apenas por adapter de teste, sem parar VMs reais.

Logs JSON de HTTP usam IDs gerados pelo servidor, rota conhecida, resultado e duração; falhas e recusas usam códigos sanitizados. Não registrar payloads, queries, stdout/stderr, prompts ou credenciais. A correlação local serve ao diagnóstico; exportação OTel, spans distribuídos, métricas externas, retenção e alertas contínuos não estão configurados/verificados.

SLI proposto: respostas bem-sucedidas de descoberta / requisições válidas de descoberta, excluindo recusas de política; acompanhar também duração. SLO numérico fica pendente de baseline no host. Alerta operacional manual: erro de descoberta na UI/503 requer inspeção do código sanitizado no log; não reiniciar ou parar VMs como resposta automática.

Runbook: confirmar modo e porta pelo log de inicialização; consultar health; se descoberta falha, verificar base/allowlist e, somente no host autorizado, disponibilidade e formato do CLI. Corrigir configuração/fixture e repetir testes antes de nova tentativa. Se SQLite falhar, preservar o arquivo e diagnosticar permissões/espaço; não apagar banco automaticamente. Para encerrar, parar apenas o processo Bun do Cockpit. Nenhuma VM é parada.

## Agentes e medição

Tech Lead mantém contratos, documentação e validação final. Um executor implementa código/testes; Challenger contesta a decisão; revisão adversarial local e mentor atuam sobre a fatia concluída. Não há implementadores concorrentes nem alterações de código compartilhadas em paralelo. Git não estava instalado no início; não se criam worktrees fictícias.

Tokens/cache/custo real e latência individual dos agentes: **não medidos**. Instalação de ferramentas isolada em `/tmp`, sem mudar configuração de autenticação. Não confundir esses dados ausentes com zero.

## Evidência da versão

Ambiente: workspace local em 2026-10-25, Bun **1.4.4** (`38afee6c8`), TypeScript **7.0.2**. Base Git lida de `.git/refs/heads/main`: `d13e76eb469824b6d0505f88c1118b794cd33243`; mudanças **sem commit**, Git indisponível no PATH. A identidade dos arquivos finais está no [manifesto SHA-256](artifact.sha256), verificável com `sha256sum -c docs/artifact.sha256` a partir da raiz. Não inclui dependências instaladas nem SQLite gerado. Relatório local não equivale a aprovação de CI.

| Verificação / fonte | Resultado observado |
| --- | --- |
| `PATH=/tmp/cockpit-tools/node_modules/.bin:$PATH bun run typecheck` | exit 0, strict aprovado |
| `/tmp/cockpit-tools/node_modules/.bin/bun test` | exit 0, **64 pass, 0 fail, 234 expect**, quatro arquivos, 108 ms nesta execução |
| Revisão independente em `tests/adversarial.test.ts` | 6 testes / 75 assertions aprovados; incluídos nos 64 acima |
| Smoke de `src/index.ts`, API e assets | PASS às `2026-10-25T13:53:04.071Z`, mock, 2 projetos / 3 VMs sintéticos |
| Segurança no smoke | origem externa 403, query arbitrária 400, POST 405; logs JSON correlacionados sem payload |
| Seleção UI | contrato estático e implementação inspecionados; navegador real `not_verified` |
| Microsandbox / Arch host / launchers | `not_verified`, nenhum comando real `msb` executado |
| CI, push, deploy, exportação de telemetria | não configurados / não executados |
| Tokens, custo, cache dos agentes | não medidos |

Para repetir com Bun instalado normalmente: `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run start`. No ambiente desta entrega, Bun foi instalado isoladamente em `/tmp/cockpit-tools`; o diretório deve entrar no PATH para usar os scripts (`export PATH=/tmp/cockpit-tools/node_modules/.bin:$PATH`). A primeira tentativa de `bun run start` com caminho absoluto do Bun falhou porque o subprocesso do script não tinha esse PATH; a execução direta da entrada passou. Não houve alteração de PATH global.

Smoke reproduzível: iniciar em mock, tomar a porta efetiva do log; consultar `/api/health`, `/api/vms`, `/api/projects`, `/`, `/app.js` e `/style.css` e conferir 200, origem `mock` e metadados `not_verified`; pedir `/api/vms` com `Origin: https://invalid.example` e esperar 403; `/api/vms?command=stop` deve dar 400, POST `/api/exec` deve dar 405. Encerrar apenas o processo Cockpit. Nesta execução, o smoke usou Node/fetch externo ao processo Bun e o SQLite próprio do mock; processo encerrado com exit 0. As suítes automatizadas cobrem as mesmas recusas.

As tentativas iniciais HTTP na sandbox falharam com `EPERM` (listen/connect); instalação de dependências teve erro DNS na sandbox. Downloads e testes HTTP foram repetidos com autorização de execução fora da sandbox e passaram. Não houve desvio por outra ferramenta nem acesso ao host Microsandbox.

## Riscos residuais e próximo gatilho

- Fixtures não certificam o formato real de `msb list`; formatos distintos, tabelas decoradas ou inventário com nomes fora do contrato podem interromper a descoberta com erro explícito. Próximo gatilho: amostra sanitizada/versionada no Arch host autorizado.
- Proteção de caminhos usa checks de metadados separados das operações posteriores. Corrida de troca de symlinks por escritor local é **suspeita condicional**, sem exploração demonstrada. Usar conta/diretórios confiáveis; rever o mecanismo antes de aceitar escritores locais adversariais. A revisão detalhada está em [adversarial-review.md](adversarial-review.md).
- Loopback e origem não são autenticação de processos locais. Não expor por proxy/túnel/rede; ampliar acesso exige novo contrato de autenticação, fora do M0a.
- Sem browser real, baseline/SLO acordado, exporter, alertas ou verificação de recuperação SQLite sob crash/journals reais. O health indica vida do servidor, sem atestar readiness de discovery/host.
- Logs de requests são somente saída padrão; retenção é responsabilidade do operador. IDs de trace locais não significam tracing distribuído OTel validado.

O Tech Lead revisou defensivamente os controles e os testes negativos após a implementação. Nenhum bypass foi confirmado nas três hipóteses exercitadas; isso não afirma ausência de vulnerabilidades. Não há finding HIGH/CRITICAL confirmado aberto nesta revisão limitada. O card está `explained`; compreensão humana não foi verificada. M0b depende de decisão posterior e do spike de transporte no host, e não foi iniciado.

Referências de implementação: [SQLite nativo Bun](https://bun.sh/docs/runtime/sqlite), [subprocessos Bun com argv em array](https://bun.sh/docs/api/spawn), [TypeScript em Bun](https://bun.sh/docs/typescript). Esses documentos não comprovam compatibilidade com o Microsandbox do operador.
