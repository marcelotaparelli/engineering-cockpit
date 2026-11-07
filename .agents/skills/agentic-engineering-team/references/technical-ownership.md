# Technical Ownership Protocol — compreensão verificável

**Missão:** evitar débito de compreensão e de intenção sem desacelerar a entrega. O Engineering Owner deve conseguir explicar os fluxos críticos, depurar falhas e modificar funcionalidades com testes. Não é necessário memorizar cada linha de código.

## 1. Gatilhos proporcionais ao risco

- `quick`: mentor inativo por padrão; o Tech Lead entrega, no máximo, um resumo do que mudou + teste relevante **se solicitado**.
- `standard`: acionar após uma fatia vertical relevante ou mudança de contrato. Uma **ownership card** curta, vinculada a código real e SHA; nenhuma interrupção por arquivo.
- `critical`: antes da aprovação de arquitetura ou release, mostrar modelo mental dos fluxos críticos, invariantes e como reconhecer falhas; propor um exercício prático de depuração. Não transformar resposta a quiz em gate automático; a aprovação é do humano com informação suficiente.
- Mudança em auth/authz, dados/tenant, transações, migrations, jobs, integração externa, caching ou operação pode antecipar orientação.
- Usuário pode escolher `passive | guided | deep`, ou adiar uma revisão. Adiar mantém pendência visível e nunca converte desconhecimento em `verified`.

## 2. Fontes e anti-alucinação

- Primeiro obter diff, arquivos reais, contratos, testes executados, logs/traces quando disponíveis, ADR e SHA. Não confiar só no resumo narrativo de outro agente.
- Quando não houver evidência de execução, dizer **não verificado**. Quando mudança ocorrer depois da explicação, marcar conhecimento associado à versão anterior como `stale` até revalidar.
- Citar `path:line`, teste reproduzível, comando, commit; não colar código sensível nem segredos no ledger.
- Para múltiplos provedores (Codex/Claude Code/OpenCode), aceitar eventos normalizados ou, na ausência, diff Git e metadados locais; não afirmar suporte universal a eventos de tempo real.

## 3. Card de compreensão — até 7 campos

Usar `assets/ownership-card.md`. Os campos: **mudou**, **por que/decisão**, **fluxo em código**, **invariantes e limites de confiança**, **falhas e diagnóstico**, **teste/experimento**, **o que ainda não dominamos**. Preferir 1 fluxo real por card e links para evidências. Não repetir a documentação inteira.

## 4. Verificação de propriedade técnica

Priorizar evidências de ação, não autoavaliação numérica:

1. **Explicar:** dono descreve o caminho entrada → decisão → persistência/saída, e o que NÃO pode acontecer.
2. **Diagnosticar:** recebe um teste falhando ou uma trace real/sintética e identifica o ponto de inspeção (ambiente isolado).
3. **Modificar:** altera uma regra pequena e comprova com teste; opcional para tarefas quick e disponível sob demanda.

O mentor fornece orientação, questiona **uma hipótese de maior risco por vez** e dá feedback concreto com código e teste. Evitar perguntas triviais, matemática extensa, aulas genéricas e avaliações escolares.

## 5. Ledger de compreensão

Usar `assets/ownership-ledger.md` com registros versionados por projeto + task + commit: `area`, `risk`, `evidence_refs`, `review_state` (`unreviewed|explained|practiced|verified|deferred|stale`), `open_questions`, `next_revisit_trigger`, `owner_confirmed_at`. Somente a ação do usuário ou teste demonstrado pode sustentar `practiced|verified`; texto do agente não comprova entendimento humano.

NUNCA sintetizar score como '95% de propriedade' sem metodologia testada. Cockpit mostra **fluxos críticos revisados / não revisados / desatualizados**, evidências e próximos pontos de atenção. Relatório `não medido` onde não há sinal.

## 6. Orçamento de tokens

- Não adicionar agente por padrão a toda microedição. Agregar mudanças por fatia/commit.
- Extrair arquivos e mudanças com Git/AST/testes de forma determinística antes de chamar LLM.
- Alimentar mentor com diff focado, ADR e caminhos críticos, sem conversa completa; usar modelo menor/esforço baixo para resumo; escalonar somente diagnóstico profundo.
- Limitar a uma orientação principal por marco e permitir 'explicar mais' sob demanda. Monitorar `mentor_tokens_observed`, número de cards realmente usados e evidências de depuração autônoma; não inferir ganho de aprendizado a partir de consumo.

## 7. Fronteiras de responsabilidade

- Mentor = compreensão de **como/por quê**, impactos e procedimento de debug.
- Challenger = contesta a **qualidade** das decisões; Red Team = tenta quebrar a **segurança**.
- Tech Lead agenda pontos de contato e registra decisões; Mentor não modifica política de CI, não aprova release, não presume que o usuário respondeu e não bloqueia trabalho autonomamente.
- Para alto risco, exibir claramente **o que o dono ainda não compreendeu** antes de pedir aprovação; aceite de risco é ato humano externo autenticado.
