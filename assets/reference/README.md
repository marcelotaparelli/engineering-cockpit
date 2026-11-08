# Referências de marca — Engineering Cockpit v1.0

Originais entregues pelo operador na raiz do projeto em 2026-11-08, copiados sem alteração. Os arquivos da raiz não foram movidos nem editados.

| Arquivo | Origem | SHA-256 |
| --- | --- | --- |
| `ENGINEERING_COCKPIT_BRAND_BOOK_v1.0.pdf` | raiz do projeto (original) | `5081111dc2bd92023e86ff259e89f71977b22c61c19dcb60c7edd8389a7c9522` |
| `ENGINEERING_COCKPIT_PROMPT_AGENTE_v1.0.md` | raiz do projeto (original) | `85c3288e2b57b32e4fe6c64761a73ca96390d9c2b9f22bb8e5cd2cb0c8752377` |
| `ENGINEERING_COCKPIT_BRAND_BOARD_APPROVED.png` | **extraída sem perda** da página 1 do brand book (a única imagem embutida, 1491×1055 RGB, `pdfimages -png`) | `4101106c0b5012e07b7b9dfce88f16d9fa7526a912b570faec972c537bf7b444` |

**ZIP:** nenhum ZIP foi encontrado na raiz nem em outro lugar do workspace. A prancha aprovada, que o prompt espera neste caminho, veio do brand book, onde é a mesma imagem do "Approved visual system". Se o ZIP trazia masters em alta resolução (PNG/SVG do logo, app icon), eles devem substituir os recortes de `public/brand/`.

## Assets derivados (`public/brand/`)
Todos são **recortes sem perda** da prancha aprovada. O acabamento metálico, o brilho azul e a textura são os pixels originais: nada foi redesenhado, vetorizado ou simplificado.

| Asset | Recorte (x0,y0,x1,y1 na prancha) | Uso |
| --- | --- | --- |
| `emblem.png` | 40,52,682,522 | emblema principal (login) |
| `wordmark.png` | 60,522,660,712 | wordmark, divisor e tagline (login) |
| `lockup.png` | 38,822,428,952 | lockup horizontal (topbar, desktop) |
| `mark.png` | 716,74,1114,346 | símbolo central (topbar mobile, estado vazio) |
| `app-icon.png` | 1182,91,1436,345 | app icon 254×254 |
| `app-icon-180.png`, `favicon.png` | redução Lanczos do app icon (180 e 64 px) | apple-touch-icon e favicon |

**Limite:** a resolução é a da prancha. O lockup tem 390×130 e é exibido a 168 px de largura, o que é nítido em telas 1× e 2×. O emblema tem 642×470 e é exibido a 300 px. Masters maiores melhorariam telas 3× e usos grandes.
