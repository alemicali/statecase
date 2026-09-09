import { build } from "esbuild";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Shared only by UAT drivers; fixture providers never enter the CLI package.
export async function buildNativeScenario(entryPoint, outfile) {
  // The scenario executes from an unrelated temporary directory. A bare
  // external import cannot resolve this repository's native dependency there.
  const sqlite = pathToFileURL(createRequire(import.meta.url).resolve("better-sqlite3")).href;
  await build({
    entryPoints: [entryPoint], outfile, bundle: true, platform: "node", format: "esm",
    plugins: [{ name: "native-sqlite", setup(builder) {
      builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: sqlite, external: true }));
    } }],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
}
