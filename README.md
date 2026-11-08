# Engineering Cockpit — central local de agentes de engenharia

Painel local (127.0.0.1) para operar agentes Codex e Claude Code em micro-VMs Microsandbox: selecionar VM, abrir ou retomar sessão, enviar prompt, acompanhar em streaming, interromper, decidir aprovações e ver numa única tela o que está trabalhando, o que terminou e o que depende de você. Bun 1.4.4, TypeScript strict, SQLite. O padrão é **mock**, com agente simulado e identificado como "SIMULAÇÃO".

**Planejamento:** a fonte única é o [master plan v2](docs/master-plan.md), com a V1 = operação diária e as fases F0–F6. O [kickoff M0](engineering-cockpit-M0-kickoff.md) fica preservado como registro. Para operar e recuperar, veja o [runbook](docs/runbook.md).

**Estado (2026-11-08, F0 concluída; F1 implementada na branch `feat/f1-daily-ops`; smoke real do systemd no Arch atestado com `orphan_ledger` NOT_VERIFIED e aceito excepcionalmente para integração; dia de uso real e recuperação de órfãos reais, F1-P1, pendentes):** o `develop` integra o E4 e a identidade visual v1.1. A F1 acrescenta serviço systemd de usuário, sessão deslizante, nova aba sem novo login, stream sem perda ao recarregar o histórico e VMs reservadas por configuração ([docs/f1-operacao-diaria.md](docs/f1-operacao-diaria.md)). A classificação dos aceites no Arch segue a regra do master plan: **H** = executado no Arch, **A** = atestado pelo operador, **T** = só testes ou simulação.

| Marco | Situação | Classificação | Registro |
| --- | --- | --- | --- |
| E0 (Codex real, recuperação sem reenvio) | homologado | H | [docs/e0-homologacao.md](docs/e0-homologacao.md) |
| E1 (agentes bloqueados) | implementado | T: `request.unsupported` real nunca observado | [docs/e1-blocked-agents.md](docs/e1-blocked-agents.md) |
| E2 (spike Claude Code) | parcial | H parcial: 2 itens INCONCLUSIVE antes da correção | [evidência](docs/evidence/e2-claude-spike-arch.json) |
| E3 (Claude Code pelo navegador) | aceito | A | [docs/evidence/e3-browser-arch.md](docs/evidence/e3-browser-arch.md) |
| E3.1 (histórico após reinício) | aceito | A. Parcial após queda abrupta com o Claude real: não homologada | [docs/evidence/e31-historico-arch.md](docs/evidence/e31-historico-arch.md) |
| E4 (confiabilidade, 278 testes + drill 11/11) | aceito | H para o Cockpit: drill executado pelo operador no Arch, resultado atestado. T para os providers: queda com providers reais pendente (F2) | [docs/evidence/e4-arch.md](docs/evidence/e4-arch.md) |
| Identidade visual v1.1 | aprovada e integrada | aprovação visual do operador | [docs/design-system.md](docs/design-system.md) |

Garantias de execução: [docs/m0b-fatia3.md](docs/m0b-fatia3.md) e [docs/e4-confiabilidade.md](docs/e4-confiabilidade.md).

## Experimentar em modo mock

```sh
export COCKPIT_LOCAL_TOKEN=$(openssl rand -hex 32); echo "$COCKPIT_LOCAL_TOKEN"
COCKPIT_ALLOWED_PROJECTS=demo,lab PORT=8787 ./scripts/cockpit start
```

Abra `http://127.0.0.1:8787` e digite a credencial. Palavras no prompt controlam a simulação: "aprovação" pede aprovação, "lento" deixa o stream lento (bom para testar a interrupção), "falha" encerra com erro.

## Operar como serviço (F1)

```sh
COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" COCKPIT_ALLOWED_PROJECTS=<projetos> \
  ./scripts/cockpit service install        # gera credencial 0600, configuração 0600 e a unit; não inicia nada
./scripts/cockpit service doctor && ./scripts/cockpit service start
```

Comandos, regras de preservação do `data/` e recuperação: [docs/runbook.md](docs/runbook.md) §"Serviço systemd de usuário". Decisões: [ADR-0003](docs/adr-0003-f1-sessao-deslizante-e-servico.md).

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
- **Identidade visual v1.1**: design system sobre a interface existente, com imagens da marca servidas de uma allowlist fixa (CSP `img-src 'self'`).
- **F0** (master plan v2): integração E4 + UI no `develop`, registro dos aceites E3 e E4 e runbook.

## Homologação E4 (comando único, seguro; aceito no Arch em 2026-11-08)

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

Para iniciar a interface, forneça uma credencial local aleatória de 32 bytes codificada em 64 caracteres hexadecimais via `COCKPIT_LOCAL_TOKEN` **ou** em um arquivo privado via `COCKPIT_LOCAL_TOKEN_FILE` (0600, dono = usuário, sem link simbólico; as duas juntas são recusadas), e a lista explícita de projetos via `COCKPIT_ALLOWED_PROJECTS` (nomes separados por vírgula), e execute `./scripts/cockpit start`. Sem configurações válidas, o servidor falha antes de escutar, com status de saída 78. A credencial é digitada na página de login, não salva pelo Cockpit; a aba guarda somente uma prova de sessão em `sessionStorage`, enviada junto com o cookie nas rotas protegidas. A sessão termina após 30 min sem uso da página ou 12 h após o login; uma nova aba da mesma porta reaproveita a sessão de uma aba aberta. Proteja o ambiente do processo. `COCKPIT_RESERVED_VMS` (CSV de nomes de VM) acrescenta VMs que o Cockpit nunca opera; `claude-engineering-cockpit` fica sempre reservada. `.bun-version`, `packageManager`, `engines` e `@types/bun` registram o pin 1.4.4.

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
- [Master plan v2](docs/master-plan.md), [runbook](docs/runbook.md) e [design system v1.1](docs/design-system.md).
- Aceites no Arch: [E3](docs/evidence/e3-browser-arch.md), [E3.1](docs/evidence/e31-historico-arch.md) e [E4](docs/evidence/e4-arch.md).

API: GET `/api/health` e os arquivos estáticos fixos (página, script, estilo e as imagens da marca em `/brand/*.png`, de uma allowlist) são públicos; todo o resto exige login local. Mutações: login/logout, sessões, runs (com `Idempotency-Key`), interrupt, reconcile e decisão de aprovação, todas com CSRF, nonce e `Origin` exato. Não existe rota de comando arbitrário. Codex: o histórico vem do provider e nada da conversa é gravado. Claude Code: o canal não lê transcripts, então o Cockpit grava o que observou (prompt, resposta, comando, caminhos, perguntas e respostas) com limites de tamanho e redação de melhor esforço, no SQLite 0600 (decisão D6 do master plan; veja [docs/e31-historico.md](docs/e31-historico.md)). Saída de ferramentas, stderr e credenciais nunca são gravados. Veja [docs/m0b-fatia3.md](docs/m0b-fatia3.md), o [threat model M0b.1b](docs/m0b1b-threat-model.md) e o [ADR-0002](docs/adr-0002-m0b1b-local-http-security.md).

Conta/diretórios locais devem ser confiáveis; não exponha por proxy/túnel. A autenticação HTTP local não isola outro processo malicioso do mesmo UID. Exporter e alertas contínuos não estão configurados. Nenhuma alteração de VM, push ou deploy faz parte deste marco.
