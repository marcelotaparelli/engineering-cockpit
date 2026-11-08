/**
 * F1 — `./scripts/cockpit service <command>`: the Cockpit as a systemd USER service. Fixed argv, no shell, no secret printed.
 *   install [--force] [--import-env-token]   write token (if absent), settings (if absent / --force) and unit; daemon-reload
 *   start | stop | restart | status | doctor | logs [-f] | enable | disable | token-path | rotate-token | uninstall
 * `install` never enables or starts anything. `start`/`restart` refuse while a blocking check fails (another Cockpit owns
 * the database or the port, bad permissions, invalid settings), so systemd is never asked to start into a conflict.
 */
import { BLOCKING_CHECKS, configuredTokenFile, defaultRunner, doctor, install, rotateToken, SERVICE_UNIT, serviceState, uninstall, type Check } from "../src/service.ts";
import { safeCode } from "../src/model.ts";

const run = defaultRunner();
const [command, ...args] = process.argv.slice(2);
const env = process.env as Record<string, string | undefined>;
const out = (line = "") => console.log(line);
const print = (checks: Check[]) => { for (const check of checks) out(`${check.status.padEnd(4)} ${check.id.padEnd(17)} ${check.detail}`); };
async function systemctl(...argv: string[]): Promise<number> {
  const child = Bun.spawn(["systemctl", "--user", ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return child.exited;
}
async function health(port: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return true; } catch { /* not yet */ }
    await Bun.sleep(300);
  }
  return false;
}
async function preflight(): Promise<number | null> {
  const report = await doctor({ env, run });
  const blocking = report.checks.filter(check => check.status === "FAIL" && BLOCKING_CHECKS.has(check.id));
  if (blocking.length) { print(blocking); out("\nNada foi iniciado. Corrija o item acima (diagnóstico completo: ./scripts/cockpit service doctor)."); process.exitCode = 1; return null; }
  return report.port;
}
async function showStatus(): Promise<void> {
  const state = await serviceState(run);
  const report = await doctor({ env, run });
  out(`${SERVICE_UNIT}: ${state.active}/${state.sub}${state.mainPid ? ` (pid ${state.mainPid})` : ""}; habilitado: ${state.enabled}; reinícios: ${state.restarts ?? "?"}`);
  if (report.port !== null && state.active === "active") out(`URL: http://127.0.0.1:${report.port}/  ${await health(report.port, 1500) ? "(respondendo)" : "(sem resposta em /api/health)"}`);
  if (state.exitStatus === 78) out("Último início foi RECUSADO (status 78): configuração, credencial, porta ou banco em uso por outra instância. Veja: ./scripts/cockpit service logs");
}

try {
  switch (command) {
    case "install": {
      const unknown = args.filter(arg => arg !== "--force" && arg !== "--import-env-token");
      if (unknown.length) { out("uso: ./scripts/cockpit service install [--force] [--import-env-token]"); process.exitCode = 2; break; }
      const result = await install({ env, run, force: args.includes("--force"), importEnvToken: args.includes("--import-env-token") });
      out(`credencial: ${result.tokenImported ? "importada de COCKPIT_LOCAL_TOKEN (substitui a anterior)" : result.tokenCreated ? "nova, gerada" : "mantida"} em ${result.paths.tokenFile} (0600; conteúdo não exibido)`);
      out(`configuração: ${result.envWritten ? "escrita" : "mantida (use --force para regravar a partir deste shell)"} em ${result.paths.envFile} (0600)`);
      out(`unit: ${result.unitWritten ? "escrita" : "sem mudança"} em ${result.paths.unitFile}; systemctl --user daemon-reload feito`);
      out("Nada foi habilitado nem iniciado. Próximo passo: ./scripts/cockpit service doctor && ./scripts/cockpit service start");
      break;
    }
    case "start": case "restart": {
      const port = await preflight();
      if (port === null) break;
      const code = await systemctl(command, SERVICE_UNIT);
      if (code !== 0) { process.exitCode = code; break; }
      out(await health(port, 15_000) ? `Cockpit no ar: http://127.0.0.1:${port}/ (credencial: arquivo em ./scripts/cockpit service token-path)` : "O serviço não respondeu em 15 s. Veja: ./scripts/cockpit service status e ./scripts/cockpit service logs");
      if (command === "restart") out("Reinício: sessões do navegador revogadas (entre de novo); execuções em andamento ficam \"não confirmadas\"; nada é reenviado.");
      break;
    }
    case "stop": process.exitCode = await systemctl("stop", SERVICE_UNIT); break;
    case "enable": case "disable": process.exitCode = await systemctl(command, SERVICE_UNIT); break;
    case "status": await showStatus(); break;
    case "doctor": {
      const report = await doctor({ env, run });
      print(report.checks);
      if (report.checks.some(check => check.status === "FAIL")) process.exitCode = 1;
      break;
    }
    case "logs": {
      const follow = args.includes("-f");
      const child = Bun.spawn(["journalctl", "--user", "-u", SERVICE_UNIT, "--no-pager", ...(follow ? ["-f", "-n", "50"] : ["-n", "200"])], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exitCode = await child.exited;
      break;
    }
    case "token-path": out(configuredTokenFile(env)); break; // the file named in cockpit.env, never a guess
    case "rotate-token": {
      const { tokenFile } = await rotateToken(env);
      const state = await serviceState(run);
      const running = state.active === "active" || state.active === "activating" || state.active === "reloading";
      out(`Nova credencial gravada e verificada em ${tokenFile} (0600; conteúdo não exibido).`);
      out(running
        ? "O serviço em execução ainda aceita a credencial ANTERIOR. A nova passa a valer em: ./scripts/cockpit service restart (revoga todas as sessões do navegador)."
        : "O serviço não está em execução: a nova credencial vale a partir do próximo ./scripts/cockpit service start.");
      out("Um Cockpit iniciado no terminal com este mesmo arquivo também só muda de credencial ao reiniciar.");
      break;
    }
    case "uninstall": {
      const paths = await uninstall({ env, run });
      out(`unit removida (${paths.unitFile}). Mantidos: ${paths.envFile}, ${paths.tokenFile} e o diretório de dados.`);
      break;
    }
    default:
      out("uso: ./scripts/cockpit service [install|start|stop|restart|status|doctor|logs [-f]|enable|disable|token-path|rotate-token|uninstall]");
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`service ${command ?? ""}: ${safeCode(error)}`);
  process.exitCode = 1;
}
