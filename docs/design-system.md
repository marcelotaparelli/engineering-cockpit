# Engineering Cockpit — Design system v1.0

**Fonte da verdade:** `assets/reference/ENGINEERING_COCKPIT_BRAND_BOARD_APPROVED.png`, a prancha aprovada extraída do brand book (proveniência em `assets/reference/README.md`).

**Implementação:** `public/style.css`, com os tokens na seção 1. O espelho legível por máquina está em `assets/brand/tokens.json`, e um teste mantém os dois iguais.

**Direção:** dark-only, aço polido, liga forjada e brilho azul controlado. Mesma família do Forge, com leitura aeronáutica de cockpit. Diante de conflito, a ordem de prioridade é: **clareza operacional**, depois consistência de marca, depois legibilidade, depois densidade organizada.

## Marca
- **O logo nunca é redesenhado.** Os arquivos em `public/brand/` são recortes sem perda da prancha: o acabamento metálico, o brilho e a textura são os pixels aprovados. Não use SVG chapado, ícone genérico nem desenho CSS no lugar deles.
- **Variações** (as mesmas da prancha):

  | Variação | Arquivo | Onde | Largura |
  | --- | --- | --- | --- |
  | Lockup horizontal | `lockup.png` | topbar, desktop | 168 px |
  | Mark only | `mark.png` | topbar mobile (64 px) e estado vazio (240 px) | — |
  | Emblema + wordmark | `emblem.png` + `wordmark.png` | login | — |
  | App icon / favicon | `app-icon*.png`, `favicon.png` | ícones | — |

- **Fundo:** os recortes saem do fundo da prancha (`--ec-abyss`, `#010b14`). Coloque-os sobre esse fundo e esfume as bordas com `mask-image` (já aplicado), nunca com moldura nem caixa.
- **Entrega:** o servidor serve só essa lista fixa (`/brand/<nome>.png`, sem parâmetro de caminho). O CSP ganhou `img-src 'self'`, e nada mais mudou.

## Tokens
| Grupo | Tokens |
| --- | --- |
| Paleta da prancha | `--ec-steel` #D9DEE6 · `--ec-deep-navy` #0A1A2E · `--ec-charcoal` #11161F · `--ec-forge-blue` #1F76FF |
| Derivados | `--ec-abyss`, `--ec-steel-2..4`, `--ec-blue-hi`, `--ec-blue-lo` |
| Superfícies | `--surface-0` (página) → `--surface-3` (elevado); `--surface-console` (logs) |
| Bordas metálicas | `--line`, `--line-2`, `--edge-hi` (realce do topo de uma borda forjada), `--edge-sheen` |
| Brilho | `--glow-focus` (foco), `--glow-soft` (hover primário), `--divider-glow` (linha azul da topbar, como o divisor da prancha) |
| Geometria | raios `--r-sm` 3 · `--r-md` 6 · `--r-lg` 10; espaços `--s-1..5` (4 a 24) |

**Tipografia:**
- **Marca e títulos:** `--font-display`, que segue Eurostile Extended → Microgramma → Michroma, sempre em caixa alta com tracking de 0,16 em.
- **Interface:** `--font-ui`, que segue Inter → Manrope → Source Sans 3 → system-ui.
- **Código e logs:** `--mono`.
- **Nenhuma fonte é empacotada.** Isso exigiria `font-src` no CSP, e a Eurostile é licenciada. Sem as fontes instaladas, a interface cai em fontes do sistema, e a tipografia de marca fica preservada no wordmark em imagem.

## Linguagem de estados
Cada estado tem uma cor, e ela é a mesma em todo lugar: ponto, chip e borda.

| Estado | Token | Estados do Cockpit |
| --- | --- | --- |
| active / running | `--ec-running` (azul) | trabalhando, executando, enviando |
| queued | `--ec-queued` (aço) | preparando |
| warning | `--ec-warning` (âmbar) | aguardando aprovação/você |
| success | `--ec-success` (verde) | concluído |
| error | `--ec-error` (vermelho) | falhou, travado; **não confirmado** usa o mesmo vermelho com contorno tracejado (incerteza ≠ falha) |
| paused | `--ec-paused` (aço escuro) | interrompido, ocioso, offline |

**Contraste (WCAG):**
- texto principal 16:1; texto secundário 9:1; rótulos discretos 5,3:1;
- cores de estado entre 5,4:1 e 8,5:1;
- texto branco do botão primário ≥ 5,5:1.

O foco aparece sempre como anel azul (`:focus-visible`). Com `prefers-reduced-motion`, pulsos e transições são desligados.

## Componentes
- **Botões:**

  | Tipo | Visual | Uso |
  | --- | --- | --- |
  | primário | Forge Blue, aresta iluminada | a ação principal da área |
  | secundário | liga escovada | ações comuns |
  | ghost | transparente | ações discretas |
  | danger | vermelho forjado | interromper, rejeitar |

- **Inputs e selects:** fundo de console com sombra interna e foco azul.
- **Painéis e cards:** gradiente navy, borda de aço com realce no topo e sombra profunda. Na inbox, a faixa lateral indica o estado (âmbar = decidir; vermelho = problema).
- **Rótulo de seção:** `/` azul + caixa alta estendida, como os títulos da prancha ("/ CORE SYMBOL").
- **Run bar:** faixa de instrumentos com chip de estado, detalhe e controles da execução.
- **Console** (`.msg.action`): ferramentas, comandos e aprovações no histórico, em mono sobre fundo de console, com borda lateral na cor do estado.
- **Topbar:** lockup metálico, badges (`SIMULAÇÃO` em âmbar, conexão com LED) e linha de brilho azul na base.

## Refinamento v1.1
- **AskUserQuestion sem duplicação:** quando a sessão selecionada já mostra a pergunta, a inbox "Precisa de você" mostra só um cartão-ponteiro ("Ir para a pergunta", que troca para a sessão e foca o formulário). A contagem global não muda, e perguntas de **outras** sessões continuam com o formulário completo. Aprovações de comando/ferramenta não mudaram. Só front-end: mesma decisão, mesmos endpoints.
- **Mobile 390 px:** cabeçalho em duas linhas (marca + Sair; depois simulação + conexão), sem truncar os badges. Textos secundários maiores (0,85 rem) e botões de ação com altura mínima de 36 px.
- **Acabamento:** superfícies separadas por painel (gradientes navy/charcoal), realce metálico de 1 px no topo das bordas, foco azul apenas no controle focado. Sem blur, sem animação nova.
- **Estados sem depender só da cor:**

  | Estado | Cor | Forma / texto |
  | --- | --- | --- |
  | servidor conectado | verde | LED cheio + "AO VIVO" (conectando: anel; offline: quadrado) |
  | executando | azul | ▶ + "EXECUTANDO" |
  | simulação | âmbar | contorno **tracejado** + ◇ + "SIMULAÇÃO" |
  | aguardando intervenção | âmbar | ◇ losango + "AGUARDANDO …" |
  | não confirmado | vermelho | anel **tracejado** + borda tracejada + "NÃO CONFIRMADO" |
  | falhou / travado | vermelho | ■ quadrado |

## O que não foi feito (de propósito)
O prompt da marca pede uma demo "Mission Control" com:
- pipelines, builds e integrations;
- consumo de recursos;
- gauges, barras de progresso e tabelas densas.

O Cockpit **não tem esses dados** hoje. Desenhar essas telas exigiria inventar métricas e funcionalidades, o que é proibido nesta tarefa. Por isso o design system foi aplicado à interface existente, e esses componentes ficam para quando houver dados reais. Por exemplo, os contadores `reliability` do E4 já existem na API e podem virar *metric tiles* numa próxima etapa.

## Validação visual
- `CHROMIUM=$(command -v chromium) bun scripts/visual-check.ts <dir>`: fluxo Codex, já existente.
- `CHROMIUM=$(command -v chromium) bun scripts/brand-visual-check.ts <dir>`: fluxo de marca e Claude.

Os dois rodam em modo mock (sem VM, sem `msb`). Capturas: v1.0 em `docs/evidence/ui-brand-2026-11-08/`; v1.1 (390, 768, 1024, 1440) e comparativos antes/depois em `docs/evidence/ui-brand-v1.1-2026-11-08/`.
