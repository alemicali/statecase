import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const source = resolve(scriptDirectory, "../../../skills/statecase");
const destination = resolve(scriptDirectory, "../dist/skills/statecase");

await rm(destination, { recursive: true, force: true });
await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
await cp(source, destination, { recursive: true, force: true });

// Keep upstream notices beside the parsers bundled into the standalone CLI.
const notices = resolve(scriptDirectory, "../dist/third-party");
await mkdir(notices, { recursive: true, mode: 0o755 });
for (const [name, filename] of [["jsonc-parser", "LICENSE.md"], ["toml-eslint-parser", "LICENSE"], ["eslint-visitor-keys", "LICENSE"]]) {
  await cp(resolve(scriptDirectory, "../../../node_modules", name, filename), resolve(notices, `${name}.LICENSE`));
}
