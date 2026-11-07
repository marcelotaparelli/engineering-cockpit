import { runM0b1aSmoke } from "../src/m0b1a-smoke.ts";

const report = await runM0b1aSmoke();
console.log(JSON.stringify(report));
process.exit(report.overall === "PASS" ? 0 : report.overall === "FAIL" ? 1 : 2);
