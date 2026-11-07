# Revisão adversarial M0a

> Relatório histórico M0a. Os caminhos de ferramentas temporárias abaixo descrevem aquela execução. Revisão e runtime atuais: [M0a.1](m0a1-security.md) e [README](../README.md).

Data: 2026-10-25. Modo: `static-local` e testes unitários isolados. Escopo autorizado pelo Tech Lead: três hipóteses em `src/` e `public/`, mocks de subprocesso/servidor e fixtures sintéticas temporárias. Ownership desta revisão: somente este relatório e `tests/adversarial.test.ts`.

Regras de engajamento: janela limitada a esta tarefa; execução sequencial; no máximo 30 casos/requisições por teste; sem rede externa, LAN, host, HTTP ao vivo, CLI `msb` real, credenciais, dados reais ou scan de dependências. Monitoramento por resultados/asserts e inspeção do código. Ponto de parada: efeito inesperado, serviço host ou dados reais. Recuperação: remover somente fixtures criadas pela revisão e restaurar o spy de `Bun.serve`. Nenhum ponto de parada foi acionado.

Resultado observado: **nenhuma vulnerabilidade confirmada nas hipóteses exercitadas**. Isso não certifica ausência de vulnerabilidades. A fronteira de confiança documentada inclui a conta e a máquina locais.

## Evidência executada

Runtime: Bun 1.4.4 (`38afee6c8`). Comandos:

```sh
/tmp/cockpit-tools/node_modules/.bin/bun test tests/adversarial.test.ts
/tmp/cockpit-tools/node_modules/.bin/bun node_modules/typescript/bin/tsc --noEmit
```

Resultado: **6 testes passaram, 0 falhas, 75 assertions**; typecheck passou. Uma rodada, sem reteste sem nova evidência. `Bun.serve` foi interceptado antes de `startServer`; nenhum socket foi criado. Subprocessos são objetos fake; os sinais não alcançam processos reais. Fixtures foram removidas no `finally`.

## H1 — autoridade, origem e caminhos

Hipótese: uma origem externa ou path/query arbitrário consegue alcançar discovery e expor dados. Superfície: validação de requisições e logs HTTP.

**CONFIRMED — barreiras observadas, severidade de finding não aplicável, confiança alta para os casos executados.** `src/server.ts:54` valida autoridade/Host/Origin/Sec-Fetch-Site; `src/server.ts:60` restringe método, query e rota. `tests/adversarial.test.ts:40` exercita 14 recusas e um controle aceito: autoridade host divergente, URL divergente, Origin externo/null/sufixo enganoso, cross-site/same-site, POST, queries, traversal codificado e nomes de propriedades de objetos. Todos os casos de recusa retornaram 403/405/400/404 sem chamar discovery; somente o controle same-origin retornou 200. Sem CORS permissivo; canaries da query/path/origem não apareceram nos logs nem na resposta de erro.

Impacto se a hipótese fosse válida: exposição de nomes e estado das VMs/projetos a uma página externa. Reprodução mínima segura/regressão: executar o teste H1 acima contra o handler fake. Correção sugerida: manter validação antes de discovery e a allowlist de assets, atualmente observadas. Sinal observável: `security_denied`, código sanitizado, status e rota conhecida/`unmatched` (`src/server.ts:81`); alertas contínuos não foram testados.

## H2 — projetos e banco próprio

Hipótese: diretório/symlink ou persistência permite leitura/escrita fora da base e mutação de banco estrangeiro. Superfície: descoberta de diretórios, validação de caminhos e inicialização SQLite.

**CONFIRMED — barreiras observadas, severidade de finding não aplicável, confiança alta para fixtures estáticas.** `src/projects.ts:8` e `src/paths.ts:6` recusam base com symlink e não incluem filho symlink. `src/store.ts:18` recusa symlinks de banco/sidecars e `src/store.ts:23` recusa hardlink principal. `src/store.ts:37` verifica identidade/versão/schema antes de `replace`. Os testes em `tests/adversarial.test.ts:75` e `tests/adversarial.test.ts:100` verificaram essas recusas, schema estrangeiro rejeitado e banco/sentinel preservados byte a byte. O probe de journal hardlink (`tests/adversarial.test.ts:116`) também preservou seu sentinel nesta configuração; não comprova segurança de todos os modos/estados de journal SQLite.

Impacto se a hipótese fosse válida: inclusão de projetos fora da base ou corrupção de dados de outro aplicativo. Reprodução mínima segura/regressão: executar os três testes H2, que criam apenas bancos e arquivos sintéticos. Correção sugerida: preservar as recusas antes de qualquer operação de escrita. Sinal observável: códigos `symlink_path_denied`, `unsafe_database_file`, `foreign_database_denied` no startup e erros sanitizados de discovery; integração de alertas não exercitada.

**SUSPECTED — corrida de pathname, severidade baixa/condicional, confiança média; exploração não demonstrada.** `src/paths.ts:10`, `src/projects.ts:8` e `src/store.ts:18` fazem checks separados de `readdir`/abertura posterior (`src/projects.ts:11`, `src/store.ts:29`). Um escritor local com permissão para substituir componentes durante essas operações poderia trocar um diretório/arquivo após o check. A análise comprova que as operações não são atômicas; não comprova um escape executável. A fronteira atual de conta/máquina confiável reduz a relevância dentro do M0a. Reprodução proposta, **não executada**: fixture local com hook determinístico entre check e abertura, troca por diretório/banco sintético de fora e assert de nenhuma leitura/mutação desse alvo. Se escritores locais adversariais entrarem no escopo, usar diretório privado com ownership/permissões verificadas e mecanismo de abertura que resista à troca de componentes; adicionar essa regressão. Não há sinal/alerta que confirme automaticamente essa corrida hoje; falhas de descoberta sozinhas não a demonstram.

## H3 — subprocesso, parser e divulgação

Hipótese: input malicioso chega a shell ou stdout/stderr bruto aparece em resposta/log. Superfície: adapter, parser, tratamento de erro e apresentação DOM.

**CONFIRMED — barreiras observadas, severidade de finding não aplicável, confiança alta para fakes.** `src/adapter.ts:3` fixa o argv `['msb', 'list']`, sem shell; `src/adapter.ts:44` envia SIGKILL ao filho e cancela leitores na falha. `tests/adversarial.test.ts:132` confirma argv/options e rejeição de cinco nomes de traversal/shell/markup/controle, além de 503 com código `msb_exit_failed` sem o canary de stdout/stderr na resposta/log. `tests/adversarial.test.ts:154` confirma timeout com SIGKILL e cancelamento dos dois streams fake. Inspeção estática: `public/app.js` usa `textContent` para dados e erros, sem sink HTML encontrado na fatia examinada.

Impacto se a hipótese fosse válida: execução local não autorizada, divulgação de stdout/stderr e possível injeção de conteúdo na UI. Reprodução mínima segura/regressão: executar os dois testes H3. Correção sugerida: manter argv fixo, saída limitada e códigos sanitizados; não inserir saída bruta ou projeto no log. Sinal observável: `msb_timeout`, `msb_exit_failed`, `msb_output_limit` e status 503; monitoramento real não foi testado.

## Limites e handoff

**NOT_TESTED:** servidor HTTP real, particularidades de parsing HTTP do runtime, navegador real, formato/versão/instalação/PATH do `msb`, permissões/ACLs/mounts do host, concorrência de escritores externos, recuperação SQLite de journal/WAL real, carga e integrações de monitoramento. Host permanece `not_verified`.

Revalidação de mitigação só deve ocorrer diante de nova versão/evidência e dentro das mesmas regras de engajamento ou de autorização ampliada explícita. Relatório entregue ao Tech Lead; avaliação independente de uma eventual correção cabe ao security_reviewer. Não houve push/deploy.
