import { createHash } from "node:crypto";

export const PRODUCT_ID = "statecase" as const;
export const PROTOCOL_MAJOR = 1 as const;

export function normalizeGitRemote(remote: string): string {
  const trimmed = remote.trim();
  if (trimmed.length === 0) invalidRemote();

  const scp = /^(?:[^@/:]+@)?(\[[^\]]+\]|[^:/\s]+):(.+)$/u.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return canonicalRemote(scp[1], "", scp[2]);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    invalidRemote();
  }
  if (!new Set(["https:", "http:", "ssh:", "git:"]).has(url.protocol)) invalidRemote();
  const port = isDefaultPort(url.protocol, url.port) ? "" : url.port;
  return canonicalRemote(url.hostname, port, url.pathname);
}

export function workspaceIdForRemote(remote: string): string {
  const canonical = normalizeGitRemote(remote);
  const digest = createHash("sha256").update(`statecase:workspace:v1\0${canonical}`).digest("base64url");
  return `ws_${digest}`;
}

function canonicalRemote(hostname: string, port: string, rawPath: string): string {
  const host = hostname.toLowerCase();
  const withoutSlashes = rawPath.replace(/^\/+|\/+$/gu, "");
  const withoutGit = withoutSlashes.replace(/\.git$/u, "");
  const segments = withoutGit.split("/").filter(Boolean);
  if (host.length === 0 || segments.length < 2) invalidRemote();
  let path: string;
  try {
    path = segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/");
  } catch {
    invalidRemote();
  }
  return `${host}${port.length > 0 ? `:${port}` : ""}/${path}`;
}

function isDefaultPort(protocol: string, port: string): boolean {
  return port.length === 0 || (protocol === "ssh:" && port === "22") || (protocol === "http:" && port === "80") ||
    (protocol === "https:" && port === "443") || (protocol === "git:" && port === "9418");
}

function invalidRemote(): never {
  throw new TypeError("unsupported or incomplete Git remote");
}
