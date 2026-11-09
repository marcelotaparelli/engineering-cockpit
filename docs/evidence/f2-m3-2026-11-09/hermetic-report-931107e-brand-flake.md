# F1 acceptance — hermetic

- commit: `931107e`
- at: 2026-11-09T07:38:31.707Z
- overall: **FAIL**

| step | what | result | time | detail |
| --- | --- | --- | --- | --- |
| typecheck | tsc --noEmit (strict) | PASS | 0.5 s | clean |
| suite | full deterministic suite (bun test) | PASS | 140.3 s | 455 pass / 0 fail |
| e4-drill | E4 recovery drill (real Cockpit processes, kill -9, orphans) | PASS | 2.9 s | overall PASS |
| visual-check | Chromium: Codex flow (login, stream, approval, interrupt, layouts) | PASS | 5.4 s | 23/23 checks |
| brand-visual-check | Chromium: brand and responsive layouts | FAIL | 0.3 s | 0/0 checks |
| f1-visual-check | Chromium: two tabs share the session, logout, L5 stream, L6 unsupported | PASS | 3 s | 12/12 checks |
| f1-browser-acceptance | Chromium: Claude AskUserQuestion/approval, kill -9 restarts, session timers | PASS | 61.2 s | 52/52 checks |
| artifact | artifact manifest matches the tree | PASS | 0 s | PASS artifact manifest |
