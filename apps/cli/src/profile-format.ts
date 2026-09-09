import { z } from "zod";
import { CLIENT_CAPABILITIES, CLIENT_CONTRACT_VERSION } from "@statecase/protocol";
import type { LocalConfig } from "./config.js";

// Deliberately not JSON: historical readers ignored JSON version fields. Keep
// one atomic document at the established path, not two competing config files.
export const PROFILE_MAGIC = "STATECASE-PROFILE/2\n";
export const MAX_PROFILE_BYTES = 16 * 1024 * 1024;
export class ProfileFormatError extends Error {
  constructor(readonly code: "PROFILE_INVALID" | "PROFILE_UPGRADE_REQUIRED" | "PROFILE_UNSUPPORTED" | "PROFILE_WRITE_FAILED" | "PROFILE_RECOVERY_REQUIRED" = "PROFILE_INVALID") {
    super(code === "PROFILE_UPGRADE_REQUIRED" ? "local profile requires explicit migration; stop Statecase processes and run statecase profile upgrade --dry-run"
      : code === "PROFILE_UNSUPPORTED" ? "local profile requires a compatible Statecase release; do not downgrade or rewrite it"
      : code === "PROFILE_WRITE_FAILED" ? "local profile update could not be confirmed; inspect profile status before retrying"
      : code === "PROFILE_RECOVERY_REQUIRED" ? "local materialization recovery is required; existing state was preserved; inspect with statecase profile recover --dry-run"
      : "local profile is invalid or cannot be observed safely; existing state was preserved");
    this.name = "ProfileFormatError";
  }
}
const text = z.string().min(1), mode = z.enum(["two-way", "publish", "consume", "append"]);
const identity = { kind: z.enum(["claude-project", "codex-global"]), harnessNamespace: text, workspaceId: text.optional() };
const schema = z.object({
  version: z.literal(1), apiUrl: text, deviceId: text.optional(), deviceName: z.string().optional(), selectedVaultId: text.optional(),
  mappings: z.array(z.object({ id: text, kind: z.enum(["drop", "codex", "claude"]), mode, name: z.string(), namespace: text, path: text }).passthrough()),
  memories: z.array(z.object({ ...identity, id: text, name: z.string().optional(), path: text, mode }).passthrough()).optional(),
  workspaces: z.array(z.object({ id: text, path: text, name: z.string().optional(), sync: z.enum(["git", "identity-only"]).optional(), gitFetch: z.enum(["ask", "auto", "never"]).optional() }).passthrough()).optional(),
  applied: z.record(z.string(), z.object({ revisionId: text, digests: z.record(z.string(), z.string()), keyEpoch: z.number().int().positive().optional() }).passthrough()),
  sessionBindings: z.record(z.string(), z.string()).optional(),
  runtime: z.object({ shimDir: text.optional(), harnesses: z.object({
    codex: z.object({ realExecutable: text, shimPath: text.optional() }).passthrough().optional(),
    claude: z.object({ realExecutable: text, shimPath: text.optional() }).passthrough().optional(),
  }).passthrough() }).passthrough().optional(),
}).passthrough();
const envelopeSchema = z.object({ version: z.literal(2), minimumClientContract: z.number().int().positive(),
  requiredCapabilities: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)).max(32), config: z.unknown() });

export function validateProfileConfig(value: unknown): LocalConfig {
  if (!schema.safeParse(value).success) throw new ProfileFormatError();
  // Validate without projecting: preserve unknown optional payload fields at
  // every depth, including historic fields this binary does not otherwise use.
  const config = value as LocalConfig;
  return { ...config, workspaces: config.workspaces ?? [] };
}
export function decodeProfile(text: string): { format: 1 | 2; config: LocalConfig } {
  try {
    if (Buffer.byteLength(text) > MAX_PROFILE_BYTES) throw new ProfileFormatError();
    if (!text.startsWith(PROFILE_MAGIC)) {
      if (text.startsWith("STATECASE-PROFILE/")) throw new ProfileFormatError("PROFILE_UNSUPPORTED");
      return { format: 1, config: validateProfileConfig(JSON.parse(text)) };
    }
    const parsed = envelopeSchema.safeParse(JSON.parse(text.slice(PROFILE_MAGIC.length)));
    if (!parsed.success) throw new ProfileFormatError();
    const value = parsed.data;
    if (value.minimumClientContract > CLIENT_CONTRACT_VERSION || new Set(value.requiredCapabilities).size !== value.requiredCapabilities.length ||
      value.requiredCapabilities.some((capability) => !CLIENT_CAPABILITIES.includes(capability))) throw new ProfileFormatError("PROFILE_UNSUPPORTED");
    return { format: 2, config: validateProfileConfig(value.config) };
  } catch (error) { if (error instanceof ProfileFormatError) throw error; throw new ProfileFormatError(); }
}
export function encodeProfile(config: LocalConfig): string {
  try {
    validateProfileConfig(config);
    const text = PROFILE_MAGIC + JSON.stringify({ version: 2, minimumClientContract: CLIENT_CONTRACT_VERSION,
      requiredCapabilities: CLIENT_CAPABILITIES, config }, null, 2) + "\n";
    if (Buffer.byteLength(text) > MAX_PROFILE_BYTES) throw new ProfileFormatError();
    return text;
  } catch (error) { if (error instanceof ProfileFormatError) throw error; throw new ProfileFormatError(); }
}
