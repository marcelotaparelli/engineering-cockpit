import { runProtocolDiagnosis } from "../src/protocol-diagnose.ts";

const report = await runProtocolDiagnosis();
console.log(JSON.stringify(report));
process.exit(report.overall === "PASS" ? 0 : report.overall === "FAIL" ? 1 : 2);
