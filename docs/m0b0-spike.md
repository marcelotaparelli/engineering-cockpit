# M0b.0 — evidências do spike no Arch

**Estado:** `VALIDATED_WITH_LIMITATION` em 2026-10-25.  
**Fonte:** atestado manual do operador no host Arch autorizado.  
**Escopo:** transporte MSB ↔ Codex App Server e operações de thread/turn; nenhuma VM, credencial, launcher ou mount foi alterado por esta entrega.

## Resultado observado

| Verificação | Resultado | Consequência para M0b.1a |
| --- | --- | --- |
| MSB em modo `--stream`, full-duplex | `PASS` | autoriza implementar transporte stdio persistente, sem shell/TTY/porta |
| Codex App Server `0.163.0` | `PASS` | fixa a versão observada pelo spike para fixtures e contrato do adapter |
| threads, turns, resume e histórico | `PASS` | autoriza o adapter tipado para sessões/runs/histórico |
| interrupção e negação de aprovação | `PASS` | autoriza modelar ambos como operações explícitas, nunca como comandos genéricos |
| desconexão | rollout vazio; estado inconclusivo | exige `unknown`; proíbe reenviar prompt, approval ou declarar conclusão |

O resultado de desconexão não é tratado como falha vazia nem como sucesso. Um rollout vazio não prova o estado terminal do turn. A regra conservadora de M0b.1a é persistir a incerteza como `unknown`, registrar o motivo sanitizado no journal e aguardar reconciliação explícita futura.

## Proveniência e limites

- O operador informou os resultados acima nesta tarefa; a saída bruta ou sanitizada dos comandos não foi anexada ao workspace.
- A versão exata do MSB, argv completo, timestamps, fingerprint do schema gerado, IDs de thread/turn e contagens de processos não foram fornecidos. Permanecem `not_recorded`, não são inferidos do planejamento anterior.
- Esta evidência não é CI autenticado e não está vinculada a um commit: `git` não está disponível neste workspace.
- A validação não autoriza endpoints HTTP mutáveis. Autenticação, CSRF e autorização continuam gates obrigatórios antes de qualquer controle real pelo navegador.
- M0b.1a implementa somente domínio, persistência, transporte/parser e testes locais com MSB simulado. Não executa `msb`, não controla VMs reais e não faz push ou deploy.

O registro estruturado correspondente está em [m0b0-spike-verification.json](m0b0-spike-verification.json).
