# F1 — Revisão independente de segurança (executada por Claude)

**Data:** 2026-11-08 · **Commit revisado:** f9d18ca · **Revisor:** subagente Claude com contexto novo, somente leitura, sem receber as conclusões da revisão anterior. Leu o diff e o código-fonte; rodou 1 PoC. Não rodou a suíte do repositório.

**Exigência do Codex: PENDENTE.** O master plan §7 pede revisão por Codex. O Codex CLI 0.166.0 existe no ambiente, mas está sem login (`codex login status`: "Not logged in"), e nada foi autenticado. Esta revisão por Claude **não substitui** a exigência: ela precisa de aprovação como exceção pelo Tech Lead, ou de uma execução futura com Codex autenticado.

**Veredito: CONDITIONAL GO.** Sem achado crítico ou alto. Sem regressão E4 (o diff não toca `runtime-store`, ledger de órfãos nem `reconcile`).

| ID | Sev. | Achado | Correção mínima |
| --- | --- | --- | --- |
| F1-A | baixa | 4096 nonces por sessão sem decaimento; no limite, até o `interrupt` devolve 429 até novo login (PoC verificado) | reservar margem ou isentar `interrupt`/`reject` do limite |
| F1-B | baixa | `rotate-token` grava sempre no caminho padrão; se o `cockpit.env` aponta outro `COCKPIT_LOCAL_TOKEN_FILE`, a rotação não tem efeito e diz que teve. A credencial antiga vale até o restart | ler o caminho do env file (ou recusar se diferir) e avisar da validade até o restart |
| F1-C | baixa | scripts de homologação definem `COCKPIT_LOCAL_TOKEN`; com `COCKPIT_LOCAL_TOKEN_FILE` no shell, falham por ambiguidade (falha segura) | remover `COCKPIT_LOCAL_TOKEN_FILE` do ambiente dos filhos |
| F1-D | baixa, suspeito | `NoNewPrivileges=yes` pode impedir helper setuid do `msb` sob o systemd; não verificável sem o host | smoke em modo host sob a unit real |
| F1-E | info | cookie sem isolamento por porta e agora com 12 h; a prova em cabeçalho continua exigida; DoS por cookie duplicado já existia | aceitar |
| F1-F | info | `renderUnit` faz dois `replaceAll` em sequência; não explorável (raiz validada) | substituição em passo único |

**Condições para GO (na data da 1ª revisão):** (1) smoke em modo host sob a unit real (fecha F1-D); (2) corrigir ou aceitar F1-A; (3) corrigir ou documentar F1-B. F1-C, F1-E e F1-F são opcionais.

---

## Correções e 2ª revisão (2026-11-08, mesma data)

**Exceção aceita pelo Tech Lead:** a revisão por Claude foi aceita excepcionalmente no lugar da revisão por Codex, com o registro de que **não** foi feita pelo Codex (brief "F1: Corrigir bloqueadores da revisão independente").

| Bloqueador | Correção | Commit |
| --- | --- | --- |
| F1-A nonces | **Épocas de CSRF.** Nonces guardados por época; com 1024, a época fecha e a sessão recebe token CSRF novo e conjunto vazio. Toda requisição de época fechada é recusada (`csrf_denied`); dentro da época, nonce de uso único. Memória limitada a um conjunto por sessão. Nenhuma mutação recusada por capacidade (`nonce_capacity_reached` deixou de existir). `csrf()` recusa sessão revogada ou expirada. A página relê o token uma vez em `csrf_denied` (CSRF é verificado antes de qualquer efeito, então nada foi executado) e reenvia com nonce novo; segunda recusa é mostrada, nunca repetida | `3a3bb03` |
| F1-B rotação | `rotate-token` e `token-path` usam o arquivo configurado em `cockpit.env` (`COCKPIT_LOCAL_TOKEN_FILE`), que precisa estar privado e válido. Gravação atômica + leitura de verificação; em falha, a credencial anterior é restaurada e a rotação relatada como falha. Mensagem diz quando a nova vale (restart com serviço ativo; próximo start se parado; "desconhecido" se o systemd não respondeu) | `8d78954`, `8fb8ce5` |
| F1-D smoke | `./scripts/cockpit f1-systemd-smoke`: unit de runtime isolada a partir do template real (`NoNewPrivileges=yes` mantido), porta/dados/credencial próprios, `msb list` + `msb exec` só leitura, SIGKILL → reinício → ledger de órfãos, stop ordenado, início recusado (78) sem reinício, journal sem credencial, limpeza total | `b2e9167`, `8fb8ce5` |



**2ª revisão independente** (Claude, contexto novo, só leitura do delta `4c7ff36..b2e9167`, 74 testes rodados, 1 PoC):
- **A: RESOLVIDO.** Verificado: `csrf()` corre antes de qualquer efeito, logo o reenvio do cliente não repete mutação; replay de época fechada recusado; nonce duplicado recusado; logout → `authentication_required`; memória ≤ 1024 × 32 sessões; sem corrida na fronteira (servidor single-thread, verificação síncrona).
- **B: RESOLVIDO**, com um aviso (B1) e duas notas (B2, B3).
- **D: PARCIAL** → corrigido em seguida (abaixo).

| ID | Sev. | Achado | Tratamento |
| --- | --- | --- | --- |
| D1 | média | Ctrl+C ou terminal fechado matava o smoke sem limpar: unit ativa, `msb exec` vivo na VM, token em `.cache/`; execuções seguintes recusadas | **corrigido**: SIGINT/SIGTERM/SIGHUP executam a mesma limpeza idempotente; um remanescente que o systemd carrega exatamente do caminho de runtime é parado, seu cgroup encerrado e removido antes da nova execução (qualquer outra unit com o nome é recusada, intocada). Teste |
| D2 | baixa | Limpeza relatava PASS sem verificar; só PIDs lembrados eram sinalizados | **corrigido**: `systemctl kill --kill-whom=all` na própria unit (o systemd endereça o cgroup, não um PID); PASS só com unit `inactive/failed` e cgroup vazio. Teste |
| D3 | baixa | `orphan_ledger` dava PASS sem sobreviventes (nada exercitado) | **corrigido**: NOT_VERIFIED nesse caso; o resultado geral não vira PASS |
| D4 | info | Porta e início não são atômicos; um ouvinte estranho receberia o token descartável e causaria FAIL, não PASS falso | aceito |
| D5 | info | `SyslogIdentifier` igual ao do serviço; o smoke abre um segundo app-server na VM escolhida | aceito; documentado ("sem turno em andamento", VM de teste) |
| B1 | baixa | Com o systemd sem responder, o CLI dizia "serviço não está em execução" | **corrigido**: "estado desconhecido" e instrução de reiniciar. Teste |
| B2 | baixa | Falha antes do rename disparava rollback desnecessário e podia virar `rollback_failed` falso | **corrigido**: rollback só se o arquivo mudou. Teste (inode e mtime inalterados) |
| B3 | info | Falha entre `open` e `rename` pode deixar `token.tmp-*` (0600) no diretório privado; sem fsync do diretório | aceito (diretório 0700 do próprio usuário) |

**Veredito atualizado: CONDITIONAL GO**, com **uma única condição restante, fora do código**: executar `./scripts/cockpit f1-systemd-smoke` no Arch (F1-D) com PASS, ou com FAIL analisado e justificado antes de qualquer afrouxamento da unit. Suíte: 338/338.

## Condição F1-D: cumprida com ressalva (2026-11-08)

O smoke foi executado no Arch (commit `842cecf`, VM `codex-cockpit-e0-test`; atestado do operador, JSON não consta neste workspace). **`msb list` e `msb exec` reais passaram sob o systemd com `NoNewPrivileges=yes`**, antes e depois de um reinício por SIGKILL: a suspeita F1-D (helper setuid do `msb` bloqueado) está **refutada** para este host, e `NoNewPrivileges=yes` **permanece**. Os demais itens passaram (unit, credencial, parada ordenada, 78 sem reinício, journal, limpeza). `orphan_ledger` ficou **NOT_VERIFIED** (nenhum filho `msb` sobreviveu), o resultado geral foi `NOT_VERIFIED` (exit 2) e o smoke **não foi alterado** para fabricar PASS.

O Tech Lead aceitou o resultado excepcionalmente para **integrar** a F1 ao `develop`. Isso **não comprova** a recuperação de órfãos reais; o risco é rastreado como **F1-P1** (aberto). Detalhes, termos e critério de aceite da pendência: [f1-systemd-smoke-arch.md](f1-systemd-smoke-arch.md).

**Veredito para o merge: GO**, com o risco residual F1-P1 aceito e aberto, e o dia de uso real ainda por fazer.
