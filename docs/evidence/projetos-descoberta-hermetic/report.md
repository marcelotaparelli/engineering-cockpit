# F1 acceptance — hermetic

- commit: `4c97b53`
- at: 2026-11-09T10:12:13.704Z
- overall: **PASS**

| step | what | result | time | detail |
| --- | --- | --- | --- | --- |
| typecheck | tsc --noEmit (strict) | PASS | 0.6 s | clean |
| suite | full deterministic suite (bun test) | PASS | 144.8 s | 497 pass / 0 fail |
| e4-drill | E4 recovery drill (real Cockpit processes, kill -9, orphans) | PASS | 3 s | overall PASS |
| visual-check | Chromium: Codex flow (login, stream, approval, interrupt, layouts) | PASS | 5.5 s | 23/23 checks |
| brand-visual-check | Chromium: brand and responsive layouts | PASS | 5.2 s | 23/23 checks |
| f1-visual-check | Chromium: two tabs share the session, logout, L5 stream, L6 unsupported | PASS | 3 s | 12/12 checks |
| f1-browser-acceptance | Chromium: Claude AskUserQuestion/approval, kill -9 restarts, session timers | PASS | 61 s | 52/52 checks |
| artifact | artifact manifest matches the tree | PASS | 0.1 s | PASS artifact manifest |
