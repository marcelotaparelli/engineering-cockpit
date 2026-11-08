# Evidência — aceite F1 automatizado (2026-11-08)

**Executado automaticamente nesta VM de desenvolvimento** (Debian, Bun 1.4.4, Chromium, modo mock), commit `4717946`, árvore limpa. **Nada foi executado no Arch** e nada aqui é atestado do operador.

| Pasta/arquivo | O que é |
| --- | --- |
| `hermetic/report.md`, `report.json` | resultado de `./scripts/cockpit f1-accept hermetic`: PASS; 363 testes, drill E4, 3 checagens Chromium existentes, 52 checagens novas, manifesto |
| `hermetic/*.log` | saída bruta de cada passo |
| `hermetic/f1-browser-acceptance/` | `results.json` (52 checagens, cada uma com o id da matriz) e capturas |
| `hermetic/{visual-check,brand-visual-check,f1-visual-check}/results.json` | resultados das checagens Chromium já existentes (capturas não repetidas: ver `docs/evidence/ui-*`) |
| `new-tests.txt` | os 3 arquivos de teste novos (18 testes) |
| `real-readonly-debian-vm/` | `real-readonly` nesta VM, **sem systemd de usuário**: `NOT_VERIFIED`, exit 2. Mostra o comportamento honesto; não é evidência sobre o serviço do Arch |

Matriz, limites e parecer: [../../f1-aceite-automatizado.md](../../f1-aceite-automatizado.md).
