import { existsSync, readFileSync } from "node:fs";
import { SafeError } from "./model.ts";

export interface HostFacts { platform: string; osRelease: string; knownGuest: boolean }
export function hostFacts(): HostFacts {
  let osRelease = "";
  try { osRelease = readFileSync("/etc/os-release", "utf8"); } catch { /* Fail closed below. */ }
  let dmi = "";
  try { dmi = readFileSync("/sys/class/dmi/id/product_name", "utf8"); } catch { /* Not universally available. */ }
  return {
    platform: process.platform, osRelease,
    // Missing DMI is unknown, not evidence that this is a physical host.
    knownGuest: !dmi.trim() || existsSync("/.dockerenv") || existsSync("/run/.containerenv") || Boolean(process.env.container)
      || /microsandbox|microvm|qemu|virtualbox|kvm|firecracker|vmware|xen|hyper-v|virtual machine|bhyve|bochs|parallels|openstack|amazon ec2|google compute engine/i.test(dmi),
  };
}
export function assertArchHost(
  env: Record<string, string | undefined> = process.env,
  facts: HostFacts = hostFacts(),
): void {
  if (env.COCKPIT_MODE !== "host" || env.COCKPIT_HOST_CONFIRMED !== "yes") throw new SafeError("host_confirmation_required");
  if (facts.platform !== "linux" || !/^ID=(?:arch|"arch"|'arch')\s*$/m.test(facts.osRelease)) throw new SafeError("arch_host_required");
  if (facts.knownGuest) throw new SafeError("guest_environment_denied");
}
