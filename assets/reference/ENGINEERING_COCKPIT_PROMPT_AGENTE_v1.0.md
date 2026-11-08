# Prompt para o agente — Engineering Cockpit v1.0

Você vai implementar a identidade visual do **Engineering Cockpit** no produto, usando como referência principal a prancha aprovada em:
`assets/reference/ENGINEERING_COCKPIT_BRAND_BOARD_APPROVED.png`

## Objetivo
Criar / aplicar um design system e uma linguagem de interface para o Engineering Cockpit mantendo coerência direta com o Forge, porém com personalidade própria baseada em **aviação, comando e cockpit de engenharia**.

## Regras fundamentais
1. **Não descaracterize a marca aprovada.**
2. O símbolo central é uma **espada longa vertical estilo Excalibur** integrada a um **emblema aeronáutico com asas metálicas**.
3. O visual precisa permanecer **dark-only**.
4. A identidade precisa preservar:
   - aço polido
   - liga forjada
   - brilho azul frio controlado
   - profundidade e realismo sóbrio
   - sensação premium, séria e operacional
5. O resultado deve ser da mesma família visual do Forge.

## O que implementar
### 1) Brand system
- definir tokens de cor
- definir tipografia de marca e UI
- definir ícone principal e variações de lockup
- definir favicon / app icon
- documentar espaçamentos, raios, strokes, sombras e highlights

### 2) UI system
Criar componentes coerentes com a marca:
- sidebar
- topbar
- cards / panels
- metric tiles
- status chips
- botões primário / secundário / ghost / danger
- inputs e selects
- tabelas densas
- logs / consoles
- barras de progresso
- gauges / indicadores de saúde
- estados: active, running, queued, success, warning, error, paused

### 3) Mission Control / Cockpit layout
Criar um dashboard principal com linguagem de “cockpit”:
- visão geral operacional
- pipelines / builds / integrations
- status dos agentes ou módulos
- queue / execution view
- logs ao vivo
- saúde do sistema
- consumo de recursos
- alertas e risco

## Direção visual obrigatória
- painéis escuros com relevo sutil
- bordas discretas com leitura metálica
- azul brilhante controlado em foco, seleção, progresso e status operacional
- uso criterioso de reflexos / highlights metálicos
- sem neon excessivo
- sem aparência de videogame
- sem cartoon
- sem visual flat opaco

## Entregáveis esperados
1. tokens (css/json/ts)
2. componentes base
3. página demo “Mission Control”
4. documentação curta de uso
5. capturas para validação visual

## Critérios de aceite
- precisa parecer irmão do Forge
- precisa parecer mais aeronáutico / cockpit
- precisa manter a espada como assinatura da família
- precisa transmitir seriedade, confiança, força, agilidade e comando
- precisa preservar o brilho metálico e o realismo controlado vistos na prancha aprovada
- não pode ficar fosco, genérico ou simplificado demais

## Observação importante
Se alguma parte da UI conflitar com a leitura visual, priorize:
1. clareza operacional
2. consistência com a marca
3. legibilidade
4. densidade organizada

Ao final, entregue:
- resumo do que foi implementado
- arquivos alterados
- rationale visual curto
- screenshots de desktop
- próximos refinamentos recomendados
