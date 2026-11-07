import { runHostCheck } from "../src/host-check.ts";
const report = await runHostCheck();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.overall === "FAIL" ? 1 : report.overall === "NOT_VERIFIED" ? 2 : 0;
