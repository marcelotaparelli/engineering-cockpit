# Engineering Cockpit — central local de agentes de engenharia

Painel local (127.0.0.1) para operar agentes Codex em micro-VMs Microsandbox: selecionar VM, abrir ou retomar sessão, enviar prompt, acompanhar em streaming, interromper, decidir aprovações e ver numa única tela o que está trabalhando, o que terminou e o que depende de você. Bun 1.4.4, TypeScript strict, SQLite. O padrão é **mock**, com agente simulado e identificado como "SIMULAÇÃO".

**Estado (2026-11-08):** E0–E3 homologados no Arch, e o E3.1 aceito para o histórico após reinício ([registro](docs/evidence/e31-historico-arch.md)). O **E4 (confiabilidade e recuperação)** está implementado e testado localmente, com **aceite no Arch pendente**: `./scripts/cockpit e4-homologation` (veja [docs/e4-confiabilidade.md](docs/e4-confiabilidade.md)). Garantias de execução em [docs/m0b-fatia3.md](docs/m0b-fatia3.md).

## Experimentar em modo mock

```sh
export COCKPIT_LOCAL_TOKEN=$(openssl rand -hex 32); echo "$COCKPIT_LOCAL_TOKEN"
COCKPIT_ALLOWED_PROJECTS=demo,lab PORT=8787 ./scripts/cockpit start
```

Abra `http://127.0.0.1:8787` e digite a credencial. Palavras no prompt controlam a simulação: "aprovação" pede aprovação, "lento" deixa o stream lento (bom para testar a interrupção), "falha" encerra com erro.

## Histórico de marcos

M0a e M0a.2 trouxeram a descoberta somente leitura. M0b.1a criou a fundação de provider, transporte e runtime; o smoke no Arch passou em 26/10, por atestado do operador. M0b.1b adicionou autenticação local, CSRF e autorização por projeto, VM e run. A Fatia 3 acrescentou sessões, runs idempotentes, SSE, interrupt, aprovações, reconcile e o painel. Os marcos seguintes:
- **E0**: Codex real, com recuperação após queda.
- **E1**: agentes bloqueados.
- **E2/E3**: Claude Code.
- **E3.1**: histórico persistente.
- **E4**: confiabilidade.
  - O banco de runtime passa a ter um único dono.
  - Processos órfãos são detectados e bloqueiam o envio.
  - Parciais são persistidas durante as pausas.
  - Uma VM parada é distinguida de uma queda de conexão ou de processo.
  - A reconciliação ganha resultado explícito.
  - Entram métricas e logs estruturados.

## Homologação E4 (comando único, seguro)

```sh
./scripts/cockpit e4-homologation
```

O comando roda o typecheck, a suíte completa e um drill de recuperação com processos reais do Cockpit em **modo simulado**:
- não usa `msb` nem VM, não envia prompt real e não consome quota;
- usa uma porta, dados e token próprios;
- nunca toca nos Cockpits em execução.

A saída é JSON, com exit `0/1/2` = `PASS/FAIL/NOT_VERIFIED`. Detalhes e limitações estão em [docs/e4-confiabilidade.md](docs/e4-confiabilidade.md).

Um banco migrado para o **schema v5** (E4) não abre com código anterior ao E4. Antes do primeiro start com o E4, guarde uma cópia de `data/` se quiser poder voltar atrás. Uma segunda instância no mesmo diretório de dados é recusada (`runtime_database_in_use`).

## Inicialização reproduzível

O projeto exige Bun **1.4.4**. O host Arch reportou Bun 1.4.2; atualize explicitamente para a versão pinada antes de iniciar. A verificação de versão é exata: outra versão falha antes do bootstrap ou da aplicação. Nenhum comando do Cockpit depende de Node ou npm.

No Arch Linux, instale a versão pinada do Bun pelo instalador oficial (a instalação do runtime é a única etapa fora do próprio Bun):

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Confirme que a saída é `1.4.4`. Da raiz do repositório:

```sh
./scripts/cockpit bootstrap
./scripts/cockpit verify
```

O bootstrap executa `bun install --frozen-lockfile --ignore-scripts`; o lock fixa as dependências e suas integridades. O typecheck chama a entrada JavaScript do compilador via Bun, sem depender de `chmod` no binário `tsc`. `BUN_TMPDIR` e caches ficam em `.cache/` no projeto, sem depender de `/tmp`. Com cache já aquecido, a instalação pode ser repetida offline com `bun install --offline --frozen-lockfile --ignore-scripts`.

Valide integração real, read-only, no próprio host Arch autorizado:

```sh
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes \
COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" \
./scripts/cockpit host-check
```

Para o smoke M0b.1a do App Server, escolha uma VM Codex que já esteja `Running` e dê consentimento específico:

```sh
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes \
COCKPIT_M0B1A_SMOKE_CONFIRMED=yes \
COCKPIT_SMOKE_VM=codex-demo \
./scripts/cockpit m0b1a-smoke
```

O fluxo é somente `initialize → thread/list(limit=1) → close`; o relatório não expõe VM, projeto ou IDs de thread. Exit `0/1/2` significa `PASS/FAIL/NOT_VERIFIED`. Veja os critérios e o risco residual em [docs/m0b1a-arch-smoke.md](docs/m0b1a-arch-smoke.md).

Para iniciar a interface, forneça uma credencial local aleatória de 32 bytes codificada em 64 caracteres hexadecimais via `COCKPIT_LOCAL_TOKEN` e a lista explícita de projetos via `COCKPIT_ALLOWED_PROJECTS` (nomes separados por vírgula), e execute `./scripts/cockpit start`. Sem ambas as configurações válidas, o servidor falha antes de escutar. A credencial é digitada na página de login, não salva pelo Cockpit; a aba guarda somente uma prova de sessão em `sessionStorage`, enviada junto com o cookie nas rotas protegidas. Proteja o ambiente do processo. `.bun-version`, `packageManager`, `engines` e `@types/bun` registram o pin 1.4.4.

Abra **`http://127.0.0.1:<porta>` do log de inicialização**. A porta padrão é escolhida pelo sistema; opcionalmente configure `PORT`. Bind exclusivamente loopback; o guard de Host não aceita o alias `localhost`.

O launcher desativa leitura automática de `.env`. Forneça somente as variáveis documentadas no ambiente do comando. Não copie credenciais, sessões ou launchers. Banco mock: `data/cockpit-mock.sqlite`, ancorado no diretório do projeto.

## Arch host: M0a.2 validado manualmente

O operador informou em 2026-10-25 que o M0a.2 foi concluído e validado no Arch real. A saída bruta/sanitizada do host-check e os passos visuais não estão neste workspace; por isso o registro classifica essa evidência como **atestado manual do operador**, sem apresentá-la como CI ou execução automatizada autenticada. Esta sessão de planejamento continua em Debian, sem transporte remoto ou montagem do `msb` do host.

Para repetir a regressão diretamente no **Arch host autorizado**, após bootstrap e testes:

```sh
COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes \
COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" \
./scripts/cockpit host-check
```

O verificador exige Linux/Arch, confirmação explícita e ausência de indicadores conhecidos de guest; DMI indisponível também é recusado. É uma barreira operacional conservadora, não prova de host físico, e não oferece bypass. `msb` deve estar no PATH local do host.

Ele executa **uma consulta `['msb', 'list', '--format', 'json']`**, sem shell, com timeout de 3 s e limite de 256 KiB por stream; valida parser/projetos, grava/reabre somente `data/cockpit-host.sqlite`, testa HTTP/segurança/assets com o snapshot observado e encerra apenas seu servidor. Não altera VMs. Para MSB 0.6.8, aceita somente o array JSON de objetos `created_at`, `image`, `name`, `status`; `Running` e `Stopped` são normalizados para estados internos. A saída de tabela fica restrita à compatibilidade com fixtures legadas.

O relatório JSON separa `PASS`, `FAIL` e `NOT_VERIFIED` por camada. Não inclui inventário, caminhos ou stdout/stderr brutos; testes com overrides são sempre `source: synthetic`. Exit codes: `0` = verificações automáticas obrigatórias passaram; `1` = falha observada; `2` = verificação obrigatória não concluída. Navegador visual e versão do CLI ficam separados do resultado automático.

O operador informou que MSB 0.6.8 retorna JSON no formato configurado acima; um exemplo fornecido foi incorporado à fixture. O parser exige exatamente os campos `created_at`, `image`, `name`, `status`, nomes e timestamps válidos, status conhecido e nomes sem duplicação. Fixtures e overrides sintéticos continuam não sendo prova do host; a conclusão do M0a.2 depende do atestado manual registrado separadamente. Os launchers não foram fornecidos nem modificados.

VMs válidas retornadas pelo MSB aparecem mesmo quando o diretório derivado do projeto não existe. Nesse caso a API retorna `orphaned: true` e a interface mostra `ÓRFÃ: diretório de projeto ausente`. A lista `projects` continua contendo somente diretórios reais descobertos; o Cockpit não cria diretórios nem projetos fictícios. O `host-check` informa `counts.vms` e `counts.orphaned_vms` sem expor nomes no relatório.

Se o check passar, use as mesmas variáveis e `./scripts/cockpit start` no host. Compare VMs/status com o CLI e teste a seleção no navegador. Seleção existe só na página; não dispara comandos nem reserva exclusividade contra escritores externos.

## Evidências e limites

- [Evidências e riscos M0a.1](docs/m0a1.md).
- [Revisão independente de segurança](docs/m0a1-security.md).
- [Technical Ownership Card](docs/m0a1-ownership-card.md) e [ledger](docs/m0a1-ownership-ledger.json).
- [Technical Ownership Card M0a.2](docs/m0a2-ownership-card.md).
- [Conclusão e evidências M0a.2](docs/m0a2.md) e [registro estruturado](docs/m0a2-verification.json).
- [Plano M0b](docs/m0b-plan.md) e [ADR do transporte Codex](docs/adr-0001-m0b-codex-app-server.md).
- [Spike M0b.0](docs/m0b0-spike.md), [entrega/evidências M0b.1a](docs/m0b1a.md), [smoke Arch](docs/m0b1a-arch-smoke.md) e [Technical Ownership Card](docs/m0b1a-ownership-card.md).
- [Threat model M0b.1b](docs/m0b1b-threat-model.md), [ADR-0002](docs/adr-0002-m0b1b-local-http-security.md) e [Ownership Card](docs/m0b1b-ownership-card.md).
- [Manifesto de código/locks/fixtures](docs/artifact.sha256): `./scripts/cockpit artifact --check`.
- [Entrega histórica M0a](docs/m0a.md).

API: GET `/api/health` é público; todo o resto exige login local. Mutações: login/logout, sessões, runs (com `Idempotency-Key`), interrupt, reconcile e decisão de aprovação, todas com CSRF, nonce e `Origin` exato. Não existe rota de comando arbitrário. O conteúdo de prompts e respostas não é gravado; o histórico vem do Codex. Veja [docs/m0b-fatia3.md](docs/m0b-fatia3.md), o [threat model M0b.1b](docs/m0b1b-threat-model.md) e o [ADR-0002](docs/adr-0002-m0b1b-local-http-security.md).

Conta/diretórios locais devem ser confiáveis; não exponha por proxy/túnel. A autenticação HTTP local não isola outro processo malicioso do mesmo UID. Exporter e alertas contínuos não estão configurados. Nenhuma alteração de VM, push ou deploy faz parte deste marco.
