# E4 — Aceite no Arch (confiabilidade e recuperação)

**Fonte:** atestado do operador em 2026-11-08 13:58 UTC, no brief da integração E4 + identidade visual. O resultado foi repetido no brief da revisão do master plan v2 (14:04 UTC). O JSON do comando não foi trazido para este workspace. Por isso o resultado no Arch é **atestado manual do operador**. O formato segue `docs/evidence/e31-historico-arch.md`.

Comando do roteiro (`docs/e4-confiabilidade.md`, §9): `./scripts/cockpit e4-homologation`. Ele roda typecheck, a suíte completa e o drill de recuperação com **processos reais do Cockpit em modo simulado**, sem `msb`, sem VM, sem prompt real e sem quota.

## Resultado atestado

| Item | Atestado do operador | Classificação |
| --- | --- | --- |
| Suíte determinística | "278 testes aprovados" | **PASS (atestado)**. 278 é a contagem da suíte em `009a949`/`ca24bdf`, o `develop` do E4 |
| Drill de homologação | "11 verificações de homologação aprovadas" | **PASS (atestado)**. O drill tem exatamente 11 verificações, então o atestado cobre todas |
| Temas citados pelo operador | reinicialização, persistência parcial, instância exclusiva, ausência de reenvio, reconciliação conservadora e detecção de órfãos | correspondem às verificações `crash_restart`, `stream_partial`/`partial_preserved`, `second_instance_refused`, `no_resend`, `reconcile_conservative` e `orphan_ledger` |

As 11 verificações do drill são `runtime`, `start`, `stream_partial`, `second_instance_refused`, `crash_restart`, `partial_preserved`, `no_resend`, `reconcile_conservative`, `attention_visible`, `orderly_shutdown` e `orphan_ledger` (`src/e4-homologation.ts`). O operador não informou a evidência (contagens) de cada uma. Este registro não as reproduz como se fossem do Arch.

**Commit sob teste:** não informado. O comando existe desde `009a949`. A contagem atestada (278) é a da suíte antes da integração da UI v1.1, que passou para 283.

## Reexecução automatizada (Debian, sessão F0, 2026-11-08)

Esta reexecução é **prova automatizada nesta VM**, não no Arch. Ela confirma que a integração com a UI v1.1 não regrediu o E4.

| Verificação | Commit | Resultado |
| --- | --- | --- |
| `./scripts/cockpit e4-homologation` (Bun 1.4.4) | `a11a1d9` (`integration/e4-ui-v1.1`) | typecheck limpo; **283 pass / 0 fail**; drill **PASS 11/11**, overall `PASS` |
| `./scripts/cockpit artifact --check` | `a11a1d9` | **PASS** |
| `scripts/visual-check.ts` (fluxo Codex, Chromium headless, mock) | `a11a1d9` | **23/23 PASS** |
| `scripts/brand-visual-check.ts` (fluxo Claude, marca, 390/768/1024/1440, mock) | `a11a1d9` | **23/23 PASS**. A 1ª tentativa abortou antes de qualquer verificação: o script avaliou a página antes de ela carregar. A 2ª passou sem alteração |

## O que o aceite do E4 **não** comprova
- **Queda com providers reais.** O drill usa agentes simulados por exigência do E4 (sem prompts reais e sem tocar nas VMs). A queda abrupta com o Claude real e com o Codex real fica para a F2 do master plan.
- **O que acontece na VM ao matar o `msb exec`.** Também não foi medido o tempo de vida real de um órfão no Arch.
- **Run Codex reconciliado como `running` preso a um app-server órfão** (lacuna L4 do master plan). Esse comportamento foi mantido e documentado em `docs/e4-confiabilidade.md` §10, e a decisão ficou para a F2.
- **Órfãos de instâncias anteriores ao E4.** Eles não estão no registro e não podem ser detectados.
