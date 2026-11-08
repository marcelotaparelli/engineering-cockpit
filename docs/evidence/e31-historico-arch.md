# E3.1 — Aceite no Arch (histórico persistente)

**Fonte:** atestado do operador, registrado no kickoff do E4 em 2026-11-08. Não há saída bruta nem capturas neste workspace, e esta sessão (Debian) não reproduziu o teste. Por isso o registro é classificado como **atestado manual do operador**, e não como execução automatizada.

| Item do roteiro E3.1 (`docs/e31-historico.md`) | Resultado atestado |
| --- | --- |
| Histórico visual da sessão preservado após reiniciar a instância isolada do E3 (porta 8788, `data/e3-homologation/`) | **PASS** (comprovado no Arch) |
| Persistência de resposta parcial após **queda abrupta** (`kill -9` durante o streaming) | **NÃO HOMOLOGADO** no Arch |

O operador não informou o resultado separado de cada passo (2 a 5). Este registro não atribui PASS ou FAIL a eles.

## Limitações do aceite
- Conversas de antes do E3.1 não foram gravadas e continuam irrecuperáveis pelo Cockpit, por desenho.
- O roteiro do E3.1 usa reinício **ordenado** (Ctrl+C). A queda abrupta não fez parte do aceite.
- No E4, a persistência de parciais durante pausas no streaming foi corrigida (`docs/e4-confiabilidade.md`, §6). O comportamento após `kill -9` passa a ser coberto pelo drill do E4: processos reais do Cockpit no Arch, com agente simulado (`./scripts/cockpit e4-homologation`, verificações `crash_restart` e `partial_preserved`).
- Mesmo com o drill do E4, a queda abrupta **com o Claude real** continua não homologada. Isso exigiria um prompt real, e o E4 proíbe prompts reais e interferência nas VMs.
