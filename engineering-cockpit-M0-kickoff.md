# Engineering Cockpit — M0 (kickoff de implementação)

**Data:** 2026-10-25  
**Objetivo do M0:** do navegador, descobrir micro-VMs existentes, selecionar uma VM Codex autorizada, enviar um prompt de teste, acompanhar eventos reais e interromper a execução sem comprometer sessões, projetos ou credenciais. **Não** implementar a equipe de 12 agentes ou o dashboard completo neste marco.

## Contexto real do host

O operador usa Arch Linux e Microsandbox (`msb`), com três launchers Bash `codex-sandbox.sh`, `claude-sandbox.sh` e `opencode-sandbox.sh` (usar as versões *sem autodeploy*). Os launchers fornecem `status`, `stop`, `recreate`, `purge`, `doctor`, `cleanup`, e abrem uma shell interativa com `msb exec` quando a VM já existe. Não os substituir.

Estrutura do host, obtida dos scripts:

```text
~/sandboxes/agent/
  projects/<project>/         # código compartilhado pelos provedores do mesmo projeto
  state/codex/<project>/      # sessões Codex isoladas por projeto
  state/claude/<project>/     # sessões Claude isoladas por projeto
  state/opencode/<project>/   # sessões OpenCode isoladas por projeto
  shared/codex-auth/         # credenciais compartilhadas de Codex
  shared/claude-auth/        # credenciais compartilhadas de Claude
  .npm-global/               # CLIs Codex/Claude
  .bun/                      # runtime/OpenCode compartilhado
```

VMs nomeadas `codex-<project>`, `claude-<project>`, `opencode-<project>`. Seus diretórios `/workspace` montam o mesmo código de projeto. Existem portas padrão coincidentes entre launchers; o Cockpit **não** deve assumir que 3000/8000/8080 estão livres. Scripts podem usar `msb run -p ...` para mapear portas, mas o MVP deve preferir comunicação por stdio com `msb exec` e não abrir portas de controle nas VMs.

## Arquitetura M0

```text
Browser localhost
  |  HTTP + SSE (sem tokens de provedor no navegador)
Backend Bun/TS strict no host Arch
  |  allowlist + validação + auditoria
  |  subprocesso msb exec <vm> -- <comando permitido>
Microsandbox existente /workspace
  |  Codex App Server via stdio (inicialmente)
  |  estado existente e credenciais permanecem na VM
SQLite no host: projects, vm_registry, sessions, runs, normalized_events
```

**Segurança:** somente acesso local no MVP, bind `127.0.0.1`, sem endpoints acessíveis na LAN, sem expor portas/API do app-server; não montar `msb` nem o host inteiro em uma VM. Executar `msb` no backend host, com argumento em array (sem `bash -c` com strings fornecidas pelo usuário). Allowlist estrita de nome de VM, projeto, subcomando e diretórios. Não aceitar caminho ou comando arbitrário na API. Não fazer `purge`, `recreate`, `stop`, `push`, `merge` ou `deploy` por padrão. Não registrar prompts, transcrições ou credenciais em logs por padrão. Tratar mensagens e diffs como dados potencialmente confidenciais; aplicar retenção e redaction.

**Concorrência:** 1 escritor por projeto/árvore de trabalho; agentes distintos compartilham `projects/<project>`. No M0 bloquear escritas paralelas e deixar claro quando um terminal externo é um escritor fora do controle do Cockpit. Worktrees poderão ser introduzidas posteriormente. Evitar bloqueio falso de atividades somente leitura.

**Uso/custo:** armazenar tokens apenas quando observados em eventos de fornecedor; valores ausentes = `null`/`not_measured`. Preço estimado não significa custo faturado (assinatura vs API). Nenhuma etapa pode preencher dados de demonstração como reais.

## Fases curtas de construção

### M0a — Discovery read-only (primeiro commit)
- Backend Bun TS strict com `GET /api/health` e `GET /api/vms`.
- Lê a saída de `msb list` via processo filho, normaliza `vm_name`, `provider`, `project`, `state`; faz erros de parse explícitos e sem inventar VMs.
- Lista projetos existentes com allowlist no diretório base; não ler arquivos secretos nem fornecer filesystem browser irrestrito.
- Frontend mínimo: lista de projetos, VMs, status e seleção.
- Testes unitários para `msb list` (fixtures), validação de nomes e ausência de shells arbitrários.

### M0b — Codex real (segundo marco)
- Validar na máquina do operador o comando `msb exec <vm> -- codex app-server` com stdin/stdout em streaming; executar apenas numa VM Codex criada/selecionada explicitamente. **Se `msb exec` não suportar transporte bidirecional persistente**, registrar evidência e implementar um bridge mínimo seguro; não expor serviços não autenticados nem contornar sandbox.
- Implementar handshake `initialize`/`initialized`, `thread/start` ou `thread/resume`, `turn/start` e notificações, `turn/interrupt`, conforme schema instalado do Codex. Gerar schemas com `codex app-server generate-ts` quando possível e validar versão.
- SSE do backend para o navegador: eventos normalizados com ID, timestamp, provider, project, vm, session/run IDs, status e payload redigido. Suportar atualização de página e histórico persistido.
- Editor: selecionar VM Codex, escrever prompt, iniciar execução, visualizar progresso/erros/aprovações e solicitar interrupção. Política de aprovações: ações sensíveis param e requerem consentimento explícito; não usar modo de aprovação irrestrita.
- Exibir apenas tokens de uso real quando a versão/integração emitir informações confiáveis.

### M0c — Qualidade da operação
- Testes de integração com servidor falso local (sem API paga); CI de typecheck, tests e build.
- Fluxos de falha: VM parou, credencial ausente, subprocesso encerrou, reconexão SSE, solicitação de aprovação não resolvida, cancelamento e reinício do backend.
- Instrumentação mínima do próprio Cockpit: logs JSON redigidos com `run_id`, durações, erros, health/ready e relatório básico de eventos. Não adicionar Grafana só para o M0.
- Ownership Card curto para a primeira mudança, vinculado a commit/diff e teste real: 'o que foi alterado / por quê / como verificar / como depurar'.

## Critérios de aceite do M0

1. Num host com `msb` acessível, Cockpit lista uma VM Codex existente e mostra seu status real.
2. A partir do navegador, uma solicitação explícita cria/retoma uma sessão Codex dentro dessa VM, sem expor credenciais ao navegador.
3. Progressos e conclusão (ou interrupção) chegam ao navegador com eventos reais e persistem no histórico local.
4. A mesma tarefa não executa duas vezes após refresh; IDs e reconciliação distinguem `running`, `interrupted`, `failed`, `unknown` e `completed`.
5. Token/custo indisponível = 'não medido' (não zero nem valores fictícios).
6. Rejeita VM inexistente, path traversal, comando arbitrário e requests sem autorização; nenhuma ação destrutiva disponível no M0.
7. Testes rodam sem VMs reais por fixtures e são acompanhados por smoke test manual num host autorizado.
8. A execução real no Arch/Linux ainda exige validação no ambiente do operador; não declarar integração concluída somente com mocks.

## Interfaces/entidades mínimas

```ts
type Provider = 'codex' | 'claude' | 'opencode';
type VmStatus = 'running' | 'stopped' | 'unknown';
type RunStatus = 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'interrupted' | 'unknown';
interface AgentRun {
  id: string;
  projectId: string;
  provider: Provider;
  vmName: string;
  providerSessionId: string | null;
  status: RunStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string;
  endedAt: string | null;
}
```

## Não fazer no M0

- LangGraph, orquestração multiagente, 12 especialistas, review gate complexo, suporte simultâneo a três backends, deploy, integrações GitLab, telemetria runtime de aplicativos terceiros ou dashboard financeiro completo.
- Não reescrever nem remover os launchers originais, suas credenciais, estados ou projetos.
- Não instalar bibliotecas/frameworks extensos para substituir processos filho, JSONL, SQLite e SSE.

## Caminho depois do M0

**M1:** adaptadores Claude (`claude -p`/Agent SDK conforme autenticação permitida) e OpenCode (`run --format json`/server), sessão/handoff entre provedores.  
**M2:** seleção de perfil `Direct | Engineering`, workflows com nossa skill v1.5, Challenger e Red Team com sandbox e escopo.  
**M3:** painel de CI, segurança, tokens/custos e observabilidade de aplicações (OTel), mais Technical Ownership Ledger.

## Prompt para colar no Codex para começar

> Atue como Tech Lead e use a skill `$agentic-engineering-team` se disponível, mas **não acione a equipe completa** neste trabalho de integração de infraestrutura. Leia `engineering-cockpit-M0-kickoff.md`. Comece por M0a, com implementação incremental em Bun + TypeScript strict, UI simples, SQLite e testes. Antes de executar integração com `msb` host, confirme que está rodando no Arch host ou disponha um mock: **não** tente controlar as demais VMs de dentro da VM Codex. Verifique os scripts de VM fornecidos; preserve projetos, state e credenciais; não altere scripts nem faça push/deploy sem autorização. Entregue o primeiro marco com demonstração local, testes efetivamente executados, riscos, consumo real se disponível e um Ownership Card explicando o fluxo. Para M0b, primeiro faça um spike que comprove o transporte bidirecional `msb exec` ↔ `codex app-server` antes de codificar a integração completa. Quando não puder verificar algo no host real, marque como `not_verified`.

## Fontes técnicas consultadas

- Codex App Server (JSONL stdio, thread/turn, notificações): https://learn.chatgpt.com/docs/app-server
- OpenCode CLI (run --format json): https://docs.opencode.ai/docs/cli/
- OpenCode server (/event SSE): https://docs.opencode.ai/docs/server/
- Claude Agent SDK com assinaturas: https://support.claude.com/pt/articles/15036540-use-o-claude-agent-sdk-com-seu-plano-claude
