import { runE4Homologation } from "../src/e4-homologation.ts";

/**
 * E4 recovery drill (mock agents, isolated Cockpit children, own port/data/token). stdout: the sanitized JSON report.
 * Exit 0 = PASS, 1 = FAIL, 2 = NOT_VERIFIED. Running Cockpits and VMs are never touched.
 */
const report = await runE4Homologation({ keepOnFailure: process.env.COCKPIT_E4_KEEP === "yes" });
console.log(JSON.stringify(report, null, 2));
process.exit(report.overall === "PASS" ? 0 : report.overall === "FAIL" ? 1 : 2);
