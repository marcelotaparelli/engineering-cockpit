/**
 * F1-D: real systemd smoke on the ARCH HOST (see src/f1-systemd-smoke.ts for what it proves and why it is isolated).
 *   COCKPIT_F1_SMOKE_CONFIRMED=yes COCKPIT_SMOKE_VM=<codex|claude>-<project> COCKPIT_PROJECTS_BASE=/abs/projects ./scripts/cockpit f1-systemd-smoke
 * Proof mode (F1-P1 for Codex, F2 for Claude and Codex; spends ONE real prompt on the smoke VM): add
 *   COCKPIT_SMOKE_ORPHAN_PROOF=yes COCKPIT_SMOKE_QUOTA_CONFIRMED=yes
 * The VM must be a test VM nobody is using; the development VM and `COCKPIT_RESERVED_VMS` are refused before anything is created.
 * The VM is also refused when it is listed in the installed service's `COCKPIT_RESERVED_VMS` (`~/.config/engineering-cockpit/cockpit.env`, read only).
 * Output: the JSON report, printed ONCE (also after Ctrl+C, which stops the run, cleans up and reports `interrupted`).
 * Exit 0 = PASS, 1 = FAIL (also an interrupted run), 2 = NOT_VERIFIED: a precondition was missing (nothing was created) OR some check could
 * not be exercised (e.g. no `msb exec` child survived the kill). After a proof run, exit 2 does NOT mean that no quota was spent.
 */
import { runSystemdSmoke } from "../src/f1-systemd-smoke.ts";
const report = await runSystemdSmoke();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.overall === "PASS" ? 0 : report.overall === "FAIL" ? 1 : 2;
