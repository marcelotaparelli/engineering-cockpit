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

**Condições para GO:** (1) smoke em modo host sob a unit real (fecha F1-D); (2) corrigir ou aceitar F1-A; (3) corrigir ou documentar F1-B. F1-C, F1-E e F1-F são opcionais.
