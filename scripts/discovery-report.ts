import { readHostVmList } from "../src/adapter.ts";
import { config } from "../src/config.ts";
import { assertArchHost } from "../src/host.ts";
import { listProjects } from "../src/projects.ts";
import { discoveryReport } from "../src/discovery-report.ts";
import { safeCode } from "../src/model.ts";

// Read-only: runs `msb list --format json` once and lists the project directories. Output stays in this terminal.
try {
  assertArchHost();
  const settings = config();
  const report = discoveryReport(await readHostVmList(), await listProjects(settings.projectsBase), settings.allowedProjects);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: safeCode(error) }));
  process.exitCode = 1;
}
