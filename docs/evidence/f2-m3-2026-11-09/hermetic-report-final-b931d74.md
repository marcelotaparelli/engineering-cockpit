# F1 acceptance — hermetic

- commit: `b931d74`
- at: 2026-11-09T08:35:04.442Z
- overall: **PASS**

| step | what | result | time | detail |
| --- | --- | --- | --- | --- |
| typecheck | tsc --noEmit (strict) | PASS | 0.6 s | clean |
| suite | full deterministic suite (bun test) | PASS | 140.4 s | 455 pass / 0 fail |
| e4-drill | E4 recovery drill (real Cockpit processes, kill -9, orphans) | PASS | 2.9 s | overall PASS |
| visual-check | Chromium: Codex flow (login, stream, approval, interrupt, layouts) | PASS | 5.4 s | 23/23 checks |
| brand-visual-check | Chromium: brand and responsive layouts | PASS | 5.2 s | 23/23 checks |
| f1-visual-check | Chromium: two tabs share the session, logout, L5 stream, L6 unsupported | PASS | 3 s | 12/12 checks |
| f1-browser-acceptance | Chromium: Claude AskUserQuestion/approval, kill -9 restarts, session timers | PASS | 61.2 s | 52/52 checks |
| artifact | artifact manifest matches the tree | PASS | 0 s | PASS artifact manifest |
