import { SafeError, vmIdentity, type Vm, type VmState } from "./model.ts";

function state(value: string, format: "msb-json" | "legacy-table"): VmState {
  if (value === "Running" || (format === "legacy-table" && value === "running")) return "running";
  if (value === "Stopped" || (format === "legacy-table" && value === "stopped")) return "stopped";
  throw new SafeError("unsupported_vm_state");
}
export function parseVmList(output: string): Vm[] {
  const input = output.trim();
  if (!input) throw new SafeError("empty_vm_output");
  let rows: { name: string; status: string }[];
  let format: "msb-json" | "legacy-table";
  if (input.startsWith("[") || input.startsWith("{")) {
    let json: unknown;
    try { json = JSON.parse(input); } catch { throw new SafeError("invalid_vm_json"); }
    if (!Array.isArray(json)) throw new SafeError("unsupported_vm_format");
    format = "msb-json";
    rows = json.map((row: unknown) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new SafeError("invalid_vm_row");
      const keys = Object.keys(row);
      const allowed = new Set(["created_at", "image", "name", "status"]);
      if (keys.length !== allowed.size || keys.some(key => !allowed.has(key))) throw new SafeError("invalid_vm_row");
      if (!("name" in row) || !("status" in row) || !("image" in row) || !("created_at" in row)
        || typeof row.name !== "string" || typeof row.status !== "string"
        || typeof row.image !== "string" || !row.image.trim()
        || typeof row.created_at !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.created_at)
        || !Number.isFinite(Date.parse(row.created_at))) throw new SafeError("invalid_vm_row");
      return { name: row.name, status: row.status };
    });
  } else {
    format = "legacy-table";
    const lines = input.split(/\r?\n/);
    const headers = lines.shift()!.trim().split(/\s+/);
    if (headers[0] !== "NAME" || (headers[1] !== "STATUS" && headers[1] !== "STATE") || headers.some(h => !/^[A-Z][A-Z0-9_]*$/.test(h)) || new Set(headers).size !== headers.length) throw new SafeError("unsupported_vm_format");
    rows = lines.map(line => {
      const cells = line.trim().split(/\s+/);
      if (cells.length !== headers.length || !cells[0] || !cells[1]) throw new SafeError("invalid_vm_row");
      return { name: cells[0], status: cells[1] };
    });
  }
  const seen = new Set<string>();
  return rows.map(row => {
    const identity = vmIdentity(row.name);
    if (seen.has(row.name)) throw new SafeError("duplicate_vm_name");
    seen.add(row.name);
    return { ...identity, state: state(row.status, format), orphaned: false };
  });
}
