# Revisão adversarial M0a.1

> Nota de escopo: esta revisão registra o estado antes da correção Bun-only. As observações sobre npm e `tools/runtime` são históricas e foram supersedidas pela correção descrita em [README.md](../README.md), [m0a1-bun-fix-verification.json](m0a1-bun-fix-verification.json) e [Technical Ownership Card](m0a1-ownership-card.md). A suíte foi reexecutada após a correção; a integração Arch/MSB real segue `NOT_VERIFIED`.

Data: 2026-10-25. Escopo: gates de host (`host`, `adapter`, `index`, `config`), host-check e bootstrap/runtime. Modo autorizado: análise estática e testes locais com fakes/fixtures sintéticas, até três hipóteses. Ownership da revisão: somente este relatório e `tests/m0a1-security.test.ts`; produção alterada exclusivamente pelo Tech Lead.

Regras de engajamento: janela desta tarefa; concorrência de testes 1; até 30 casos/requisições por teste; nenhum `msb` real, acesso a VMs, credenciais, rede externa, servidor HTTP ao vivo, instalação ou mutação de dados reais. Monitoramento por asserts e spies; parar em dado real, serviço inesperado ou efeito fora das fixtures. Recuperação: restaurar spies/variáveis e remover fixtures próprias em `finally`. O launcher é executado apenas como cópia numa árvore temporária com runtime shell fake. Nenhuma condição de parada foi acionada.

## Execução

Runtime: Bun 1.4.4 (`38afee6c8`), em `tools/runtime/node_modules/.bin/bun`. Rodada inicial:

```sh
tools/runtime/node_modules/.bin/bun test tests/m0a1-security.test.ts
tools/runtime/node_modules/.bin/bun node_modules/typescript/bin/tsc --noEmit
```

Resultado atual após correções: **5 testes passaram, 0 falhas, 50 assertions; typecheck passou**. Os dois findings iniciais foram corrigidos e revalidados localmente. Detecção de guest continua heurística; o host real permanece não verificado.

Resultado inicial: 3 testes passaram e 2 falharam; typecheck passou. Um replay filtrado do teste do relatório revelou `http_and_security=FAIL/internal_error`; uma PoC mínima de `Response` local confirmou a causa do stream consumido. Não houve HTTP ao vivo.

## H1 — gate nativo e guest denial

Hipótese: modo/consentimento ou identidade de guest permite alcançar a criação nativa do processo fora do Arch host autorizado.

**CONFIRMED F1 — guest Firecracker não reconhecido. Severidade média, confiança alta.** Na versão inicial revisada, `src/host.ts:13` usa `/microsandbox|microvm|qemu|virtualbox|kvm/i` e não reconhece DMI `Firecracker`. Com `ID=arch`, plataforma Linux, ambos os opt-ins explícitos, ausência dos marcadores de container e DMI sintético `Firecracker`, `hostFacts().knownGuest` retorna `false`; `assertArchHost` então aceita esses fatos (`src/host.ts:20`). A regressão `tests/m0a1-security.test.ts:43` falhou na expectativa `knownGuest=true`. A criação de processo permanece interceptada pelo teste; nenhum `msb` foi chamado.

Impacto: gate permite iniciar o adapter num guest Arch reconhecível, contrariando a fronteira de ambiente definida. O comando continua sendo somente `msb list`; não foi demonstrada mutação de VM ou execução arbitrária. Reprodução mínima segura: executar o teste H1 regression com fs e spawn fakes. Correção sugerida: incluir os identificadores guest conhecidos omitidos, verificar sinais adicionais disponíveis e explicar que ausência de marcador não demonstra bare metal; quando houver incerteza relevante, impedir o uso nativo. Regressão: o mesmo teste deve observar `guest_environment_denied` e zero chamadas ao spy de `Bun.spawn`. Sinal observável: `startup_failed/error_code=guest_environment_denied` e `host_preflight=NOT_VERIFIED`; no bypass original esses sinais não ocorrem.

**CONFIRMED — demais barreiras exercitadas.** O teste `tests/m0a1-security.test.ts:33` passou nove casos de modo/consentimento exatos, ID de distro conservador e guest flag. Análise estática: `src/adapter.ts:13` chama o gate imediatamente antes de `Bun.spawn`, e `src/index.ts:16` o chama antes de criar banco/servidor em modo host. `config()` não é o gate de spawn, mas conserva opt-in próprio e paths ancorados à árvore do aplicativo.

**RESIDUAL/NOT_TESTED:** a correção passou a recusar DMI ausente, vazio ou em branco e a reconhecer Firecracker e outros marcadores. Um guest com DMI preenchido sem marcador reconhecido ainda pode ser indistinguível de host físico. Detecção por heurística não fornece prova geral de bare metal; ausência de indicadores nunca é identidade criptográfica. Essa variante residual não foi explorada nesta janela.

## H2 — relatório e preservação de dados

Hipótese: overrides produzem evidência de host falsa, erros viram sucesso/não verificado indevido ou relatório divulga inventário/input bruto.

**CONFIRMED F2 — falso FAIL ao cancelar body consumido. Severidade baixa operacional, confiança alta.** Na versão inicial revisada, `src/host-check.ts:73` chama `response.json()` e depois `src/host-check.ts:75` cancela o mesmo body. Em Response nativa local do Bun 1.4.4 isso lança `TypeError: Invalid state: ReadableStream is locked`. O teste `tests/m0a1-security.test.ts:86`, com servidor/fetch inteiramente fakes e handler real, terminou em `http_and_security=FAIL/internal_error`. PoC mínima segura: criar `new Response(JSON.stringify({ synthetic: true }))`, consumir `json()` e chamar `body.cancel()`. Não envolve rede. Impacto: um relatório local válido pode falhar; isso não fabrica PASS nem comprova o comportamento de um body proveniente de fetch HTTP real. Correção sugerida: cancelar somente bodies ainda não consumidos ou consumir de modo uniforme. Regressão: o teste completo fake deve terminar em PASS mantendo `source=synthetic`, checks manuais NOT_VERIFIED e dez chamadas internas. Sinal: `http_and_security=FAIL/internal_error`; o motivo específico não aparece em razão da sanitização.

**CONFIRMED — classificação e preservação exercitadas.** `tests/m0a1-security.test.ts:63` passou: guest no preflight resulta em NOT_VERIFIED, não chama readOutput nem cria SQLite; formato inválido após preflight resulta em parser FAIL, contagens null, preserva SQLite anterior byte a byte e não divulga canary/caminho no relatório. `src/host-check.ts:33` marca qualquer override como `synthetic` de forma independente dos fatos injetados. O teste de caminho completo permanece bloqueado por F2 na rodada inicial; suas assertions de inventário/contagens/sinais finais ainda não concluíram nessa versão.

## H3 — launcher, CWD e versões

Hipótese: CWD/PATH ou versão desviam bootstrap/start para runtime/arquivos inesperados ou alteram os destinos de persistência.

**CONFIRMED — controles exercitados, sem finding adicional.** `tests/m0a1-security.test.ts:117` executou uma cópia do launcher com runtime fake e ambiente sintético mínimo: CWD externo foi normalizado para a raiz da cópia; chamada de start permaneceu `src/index.ts`; PATH priorizou o binário local; cache permaneceu dentro da cópia; versão divergente foi recusada antes de start. Nenhum script do aplicativo ou instalador real foi executado nesse teste. Evidência estática: `scripts/cockpit:3`, `scripts/cockpit:6`, `scripts/cockpit:21` e `scripts/cockpit:25`; `src/config.ts:14` ancora SQLite à árvore do aplicativo. `tools/runtime/package.json` fixa Bun 1.4.4 e seu lock contém versão/resolved/integrity; o bootstrap usa `npm ci` no pacote dedicado e o install do aplicativo usa frozen lock e ignore-scripts.

Impacto se a hipótese fosse válida: abrir banco fora do diretório esperado ou executar uma ferramenta inesperada. Reprodução mínima/regressão: executar o teste H3. Correção sugerida: preservar precedência explícita e paths ancorados. O PATH herdado para ferramentas como npm/msb continua sendo fronteira do operador; pin de versão não autentica um executável malicioso já colocado na máquina. Sinal: versão incompatível encerra com mensagem de mismatch. Instalação real, downloads e confiabilidade da cadeia de distribuição não foram testados.

## Limites e handoff

**NOT_TESTED:** Arch host real, terminal host, CLI `msb`, VMs, navegador visual, HTTP real, instalação/bootstrap de dependências e integridade do download, permissões do host e todas as variantes de guest. O relatório desta revisão não certifica ausência de vulnerabilidades e não transforma o host em verificado.

F1 e F2 foram enviados cedo ao Tech Lead com evidências. Revalidação somente após correção ou nova evidência; avaliação independente da correção cabe ao security_reviewer. Nenhum push/deploy foi realizado.

## Revalidação

Uma rodada sobre a nova versão do Tech Lead, com os mesmos comandos acima e sem ampliar as três hipóteses: **5 pass, 0 fail, 50 assertions; typecheck aprovado**.

- **F1 corrigido e revalidado:** `src/host.ts:13` recusa DMI desconhecido/vazio e `src/host.ts:14` inclui Firecracker e outros identificadores. `tests/m0a1-security.test.ts:43` passou quatro fixtures: Firecracker, string vazia, whitespace e erro de leitura DMI. Todas observaram `guest_environment_denied` antes do spawn, com **zero chamadas** ao spy de `Bun.spawn`.
- **F2 corrigido e revalidado:** `src/host-check.ts:75` cancela apenas body ainda não consumido. `tests/m0a1-security.test.ts:91` passou o fluxo completo com dez chamadas ao handler interno: relatório `source=synthetic`, overall PASS, contagens sintéticas corretas, checks visuais/versão NOT_VERIFIED, hash presente, sem nomes de VM/caminhos no relatório e servidor fake encerrado.
- `tests/m0a1-security.test.ts:68` reconfirmou classificação de preflight/parse e preservação byte a byte do SQLite anterior. `tests/m0a1-security.test.ts:122` reconfirmou o launcher copiado com runtime fake. Referências nas seções de achados descrevem a versão inicial; estas referências apontam a versão corrigida.

Nenhum finding confirmado permanece aberto nos casos exercitados. Isso não certifica ausência de vulnerabilidades nem verifica o Arch host real. O Tech Lead foi informado da revalidação; revisão independente de correção pelo security_reviewer não é substituída por este reteste.

### Evolução do launcher: desativação de `.env` automático

Após alteração material do Tech Lead para executar Bun com `--no-env-file`, o fake H3 foi atualizado para observar os dois argumentos em ordem: `--no-env-file`, `src/index.ts`. A raiz/CWD, precedência do runtime, cache local e recusa de versão divergente continuam verificados. Escopo desta atualização limitado ao fake/assert de `tests/m0a1-security.test.ts:122` e ao relatório; nenhuma nova hipótese ou mudança de produção pela revisão.

```sh
tools/runtime/node_modules/.bin/bun --no-env-file test tests/m0a1-security.test.ts -t 'M0a.1 H3'
```

Resultado: **1 pass, 0 fail, 4 testes filtrados, 7 assertions**. O teste confirma os argumentos encaminhados pela cópia do launcher; o comportamento real de startup com `.env` e reinício SQLite é validado separadamente pelo Tech Lead em `tests/startup.test.ts` e não foi executado por esta revisão.
