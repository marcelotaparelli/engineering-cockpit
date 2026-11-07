import { runClaudeSpike } from "../src/e2-claude-spike.ts";

const report = await runClaudeSpike();
console.log(JSON.stringify(report));
process.exit(report.overall === "PASS" ? 0 : report.overall === "FAIL" ? 1 : 2);
