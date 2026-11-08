import { prepareE3Homologation } from "../src/e3-homologation.ts";

/**
 * Preflight (read-only, no prompt) and, only if ready, an ISOLATED Cockpit for the E3 browser homologation.
 * stdout: the sanitized JSON report (safe to paste). The local token goes to the terminal (stderr) once, never into the report.
 * Ctrl+C stops only this instance; the running Cockpit is never touched.
 */
const { report, launch } = await prepareE3Homologation();
console.log(JSON.stringify(report));
if (!launch) process.exit(report.checks.some(check => check.status === "FAIL") ? 1 : 2);

console.error([
  "",
  `E3: Cockpit isolado em ${launch.url} (ACL: ${report.project}; dados: ${report.data_dir}). O Cockpit em execução não foi alterado.`,
  launch.tokenGenerated ? `Token de login desta instância (só aparece aqui; não copie para logs): ${launch.token}` : "Token de login: o COCKPIT_E3_LOCAL_TOKEN que você forneceu.",
  "Ctrl+C encerra apenas esta instância. Para o passo (e), rode o mesmo comando de novo (novo token; mesmos dados).",
  "",
].join("\n"));
const child = Bun.spawn([process.execPath, "--no-env-file", "src/index.ts"], { cwd: new URL("..", import.meta.url).pathname, env: launch.env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
