# E3.1 — Histórico persistente de conversas

**Estado (2026-11-08):** implementado e testado em ambiente simulado. **O aceite depende da homologação no Arch** (roteiro no fim).

## Problema e causa
Na homologação do E3, depois de reiniciar o Cockpit a sessão reaparecia (ela está no SQLite), mas a conversa mostrava "Sessão sem mensagens ainda".

O histórico do Claude Code existia **só na memória** da conexão do adapter (`ClaudeConnection.#transcripts`, capability `history:"session_memory"`). O canal stream-json não lista nem lê transcripts, então um processo novo do Cockpit não tinha de onde tirar a conversa. O Claude manteve o contexto porque o `--resume` usa o transcript que fica na VM, mas o Cockpit não lê esse transcript.

## Solução (mesma infraestrutura)
- **RuntimeStore schema v4**: a tabela `transcript_items` fica no mesmo SQLite.
  - Chave: `(session_id, item_id)`. Ordem: `seq`.
  - Chaves estrangeiras para `sessions`, `runs` e `approvals`.
  - Tamanho do corpo limitado por `CHECK`.
  - Migração **v3 → v4 aditiva**: só cria a tabela e o índice, numa transação, e só a partir do schema v3 exato. A cadeia v1 → v2 → v3 → v4 roda numa única abertura. Sessões, runs, journal, aprovações e métricas ficam intactos.
- **ExecutionService** grava o que observa dos providers com `history:"cockpit"` (hoje, o Claude Code):
  - **prompt do operador**: assim que o run existe (`<runId>:prompt`);
  - **resposta do agente**:
    - o primeiro trecho do streaming é gravado na hora, para fixar a posição na conversa;
    - depois, no máximo 1 vez por segundo;
    - a forma final substitui a parcial;
    - quando o run termina de qualquer jeito (concluído, interrompido, falha, sessão perdida, desligamento ordenado), o que foi transmitido é gravado;
  - **ferramentas**: ferramenta, comando, arquivos, status, exit code e aviso de permissão;
  - **aprovações e perguntas**: o que foi pedido e as respostas dadas. O **status** vem da tabela `approvals` na leitura, então expirações (incluindo `process_restarted`) aparecem corretamente.
- **Leitura**: `GET /api/sessions/:id/history[?before=<cursor>&limit=1..500]` vem **só do SQLite**. Não chama o Claude, não precisa da VM ligada e não depende do processo anterior. As páginas vêm da mais recente para a mais antiga, com cursor opaco, e a UI mostra "Carregar mensagens anteriores". Outras rotas continuam recusando query string.
- **Item incompleto**: uma resposta parcial, ou uma ferramenta `in_progress`, cujo run não está mais ativo aparece como **"Resposta incompleta"**. Enquanto o run está ativo, aparece apenas como em andamento.
- **Sem duplicação**:
  - o mesmo evento, ou um evento atrasado, atualiza a mesma linha e mantém a posição;
  - um item concluído nunca volta a parcial;
  - a UI indexa os itens do histórico por id, então um evento ao vivo do mesmo item (reconexão SSE, refresh) substitui o item em vez de duplicar;
  - o retry com a mesma idempotency key não cria run nem mensagem nova.
- **Semântica intacta**: gravar o histórico **nunca** altera run, aprovação, idempotência ou `unknown`. Uma falha de escrita só gera o log `transcript.write_failed`.
- **Codex**: sem mudança. Continua com `history:"paged"`, lido do provider, e nada dele é gravado.

## O que é gravado e o que não é (`src/transcript.ts`)
| Gravado (limitado, com redação) | Nunca gravado |
| --- | --- |
| Prompt (64 KiB), resposta (64 KiB), raciocínio (8 KiB) | **Saída de ferramentas** (conteúdo de arquivo, saída de comando, páginas): só o indicador "saída não armazenada" |
| Linha de comando (4 KiB), caminhos de arquivo (50 × 512) | Entrada de ferramentas além do comando e dos caminhos |
| Perguntas (4 × 512) e respostas (2000) | stderr, tokens do Cockpit, credenciais da VM |

A redação de segredos é **de melhor esforço** e roda em toda string gravada: `sk-ant-…`, `ghp_…`, `AKIA…`, JWT, `Bearer …`, `usuario:senha@` em URL, chaves privadas e atribuições como `api_key=…`, `password: …` ou `"token": "…"`. A tela ao vivo não passa pela redação; só o que vai para o disco. O SQLite mantém `secure_delete=ON` e o arquivo continua com modo 0600 num diretório 0700.

## Limites e retenção
| Limite | Padrão |
| --- | --- |
| Itens por sessão | 2000 (os mais antigos saem) |
| Itens no total | 50 000 (no startup e a cada 100 escritas) |
| Idade | 180 dias sem atualização (no startup) |
| Página | 200 itens (máx. 500) |
| Parciais por run | 64; regravação a cada ≥ 1 s |

## Limitações
- Conversas de **antes do E3.1** nunca foram gravadas, porque ficavam só na memória, e **não podem ser recuperadas** sem ler o transcript do Claude na VM, o que fica fora do escopo por desenho. Sessões antigas mostram só os turnos novos.
- Num `kill -9` do Cockpit, a resposta parcial perde no máximo cerca de 1 s de texto. No desligamento ordenado (Ctrl+C/SIGTERM), nada se perde.
- A redação de segredos não reconhece todos os formatos de segredo; por isso a saída de ferramentas nunca é gravada.

## Testes
Ao todo, 250/250 em ambiente simulado, com typecheck limpo. Dos 14 testes novos:
- **`tests/e31-history-restart.test.ts`** (HTTP real, dois processos do Cockpit sobre o mesmo SQLite):
  - conversa de vários turnos com aprovação, AskUserQuestion respondida e interrupção no meio de uma resposta;
  - desligamento completo com um turno em andamento;
  - reinício com o mesmo SQLite: a sessão e o histórico reaparecem idênticos, a parcial marcada como incompleta e o run `unknown`;
  - retomada com contexto (`--resume`) e novo turno acrescentado uma vez;
  - paginação sem lacunas nem repetição;
  - histórico com a VM parada;
  - segredo digitado no prompt ausente da API e do arquivo SQLite.
- **`tests/e31-transcript.test.ts`**: redação, o que não é gravado, migração v3 → v4 com dados preservados e schema adulterado recusado, deduplicação, item concluído não rebaixado, incompleto depois do reinício, status da aprovação, paginação, retenção, corpo corrompido.
- **`tests/frontend.test.ts`**: histórico depois do reinício com pergunta respondida, aprovação expirada, resposta incompleta, "carregar anteriores", evento ao vivo sem duplicar e reload sem duplicar.

## Homologação no Arch (operador)
Só a instância isolada do E3 é reiniciada; o Cockpit E0 (8787) não é tocado. Esse reinício **faz parte do teste**.

1. No terminal da instância E3 (porta 8788), aperte **Ctrl+C**. Com o checkout do Arch neste commit, rode o mesmo comando de preparação. Ele reaproveita `data/e3-homologation/` e migra o banco v3 → v4 sem perder sessões:
   ```sh
   COCKPIT_MODE=host COCKPIT_HOST_CONFIRMED=yes COCKPIT_E3_CONFIRMED=yes COCKPIT_E3_VM=claude-cockpit-e2-test COCKPIT_ALLOWED_PROJECTS=cockpit-e2-test COCKPIT_PROJECTS_BASE="$HOME/sandboxes/agent/projects" ./scripts/cockpit e3-homologation
   ```
2. No navegador (`http://127.0.0.1:8788`, com o token novo), abra a sessão anterior. Esperado: a sessão aparece; os turnos de **antes** do E3.1 não aparecem (nunca foram gravados).
3. Na mesma sessão:
   - (a) envie um prompt curto;
   - (b) peça uma `AskUserQuestion` e responda;
   - (c) peça um `Bash` e **rejeite**;
   - (d) peça um texto longo e **interrompa** no meio.
4. **Ctrl+C** na instância e rode o mesmo comando do passo 1. Faça login e abra a sessão. Esperado:
   - os turnos a–d na ordem, com a pergunta e a resposta, a aprovação "rejeitada" e a resposta de (d) marcada "Resposta incompleta";
   - nenhuma mensagem duplicada;
   - F5 mostra o mesmo.
5. Envie "Qual foi a minha resposta à pergunta?". Esperado: o Claude responde com o contexto, e o novo turno aparece **uma vez** no fim.
6. Registre em `docs/evidence/e31-historico-arch.md` só PASS/FAIL por passo, sem conteúdo de prompt ou resposta.
