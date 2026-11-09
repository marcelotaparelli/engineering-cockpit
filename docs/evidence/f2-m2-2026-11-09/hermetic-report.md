# F1 acceptance — hermetic

- commit: `6d500f5` (working tree has uncommitted changes)
- at: 2026-11-09T06:33:59.116Z
- overall: **PASS**

| step | what | result | time | detail |
| --- | --- | --- | --- | --- |
| typecheck | tsc --noEmit (strict) | PASS | 0.5 s | clean |
| suite | full deterministic suite (bun test) | PASS | 128 s | 446 pass / 0 fail |
| e4-drill | E4 recovery drill (real Cockpit processes, kill -9, orphans) | PASS | 3.3 s | overall PASS |
| visual-check | Chromium: Codex flow (login, stream, approval, interrupt, layouts) | PASS | 5.4 s | 23/23 checks |
| brand-visual-check | Chromium: brand and responsive layouts | PASS | 5.4 s | 23/23 checks |
| f1-visual-check | Chromium: two tabs share the session, logout, L5 stream, L6 unsupported | PASS | 3 s | 12/12 checks |
| f1-browser-acceptance | Chromium: Claude AskUserQuestion/approval, kill -9 restarts, session timers | PASS | 61 s | 52/52 checks |
| artifact | artifact manifest matches the tree | PASS | 0 s | PASS artifact manifest |
