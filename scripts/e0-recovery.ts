import { realRecoveryDeps, runRecoveryTest } from "../src/e0-recovery.ts";

const report = await runRecoveryTest(realRecoveryDeps(new URL("..", import.meta.url).pathname));
console.log(JSON.stringify(report));
process.exit(report.overall === "PASS" ? 0 : 1);
