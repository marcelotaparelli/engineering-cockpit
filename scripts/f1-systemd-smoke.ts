/**
 * F1-D: real systemd smoke on the ARCH HOST (see src/f1-systemd-smoke.ts for what it proves and why it is isolated).
 *   COCKPIT_F1_SMOKE_CONFIRMED=yes COCKPIT_SMOKE_VM=codex-<project> COCKPIT_PROJECTS_BASE=/abs/projects ./scripts/cockpit f1-systemd-smoke
 * Output: JSON report. Exit 0 = PASS, 1 = FAIL, 2 = NOT_VERIFIED (precondition missing; nothing was created).
 */
import { runSystemdSmoke } from "../src/f1-systemd-smoke.ts";
const report = await runSystemdSmoke();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.overall === "PASS" ? 0 : report.overall === "FAIL" ? 1 : 2;
