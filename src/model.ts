export type Provider = "codex" | "claude" | "opencode";
export type VmState = "running" | "stopped" | "unknown";
export interface Vm { vm_name: string; provider: Provider; project: string; state: VmState; orphaned: boolean }
export interface Snapshot {
  source: "mock" | "host";
  observed_at: string;
  host_verification: "not_verified";
  projects: string[];
  vms: Vm[];
}
export class SafeError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function safeCode(error: unknown): string {
  return error instanceof SafeError ? error.code : "internal_error";
}
export function validProject(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value);
}
export function vmIdentity(value: string): Omit<Vm, "state" | "orphaned"> {
  const match = /^(codex|claude|opencode)-(.+)$/.exec(value);
  if (!match || !match[1] || !match[2] || !validProject(match[2])) throw new SafeError("invalid_vm_name");
  return { vm_name: value, provider: match[1] as Provider, project: match[2] };
}
