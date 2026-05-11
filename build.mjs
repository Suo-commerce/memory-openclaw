// Generation Timestamp: 2026-04-28T17:45:00Z
// build.mjs — esbuild bundler for @suocommerce/memory-openclaw
//
// Two-step build:
//   1. esbuild bundles everything (including definePluginEntry from openclaw)
//   2. Post-process: replace the inlined definePluginEntry + helper with an
//      external import from OpenClaw's actual plugin-entry chunk
//
// Why: OpenClaw's hook system only dispatches before_prompt_build to hooks
// registered through ITS OWN definePluginEntry instance. An inlined copy
// creates a separate registry and hooks silently never fire.

import { build } from "esbuild";
import { readdirSync, readFileSync, writeFileSync } from "fs";

// ── Step 1: Bundle with esbuild ────────────────────────────────────────────

await build({
  entryPoints: ["index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  sourcemap: false,
  minify: false,

  nodePaths: ["/opt/homebrew/lib/node_modules"],

  external: [
    "node:*",
    "@napi-rs/*",
    "lancedb",
    "openai",
    "crypto", "fs", "path", "os", "url", "util",
    "stream", "events", "http", "https", "net", "tls",
    "zlib", "child_process", "worker_threads",
  ],

  banner: {
    js: "// @suocommerce/memory-openclaw v2.1.0 — bundled with esbuild",
  },
});

console.log("✓ Step 1: esbuild bundle complete");

// ── Step 2: Replace inlined definePluginEntry with external import ──────────

const openclawDist = "/opt/homebrew/lib/node_modules/openclaw/dist";
const pluginEntryFile = readdirSync(openclawDist)
  .find(f => f.startsWith("plugin-entry-") && f.endsWith(".js"));

if (!pluginEntryFile) {
  console.error("ERROR: Could not find plugin-entry-*.js in", openclawDist);
  process.exit(1);
}

const pluginEntryPath = `${openclawDist}/${pluginEntryFile}`;

const lines = readFileSync("dist/index.js", "utf8").split("\n");
const importLine = `import { t as definePluginEntry } from "${pluginEntryPath}";`;

// Find and remove these two top-level functions that esbuild inlined from
// the plugin-entry chunk:
//   function resolvePluginConfigSchema(...) { ... }
//   function definePluginEntry({ ... }) { ... }
//
// Strategy: scan for lines starting with "function resolvePluginConfigSchema("
// or "function definePluginEntry(", then track brace depth to find the end
// of each function body. Remove all lines in those ranges.

const linesToRemove = new Set();
let braceDepth = 0;
let tracking = false;

for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trimStart();

  if (
    !tracking && (
      trimmed.startsWith("function resolvePluginConfigSchema(") ||
      trimmed.startsWith("function definePluginEntry(")
    )
  ) {
    tracking = true;
    braceDepth = 0;
  }

  if (tracking) {
    linesToRemove.add(i);
    for (const ch of lines[i]) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }
    if (braceDepth <= 0 && lines[i].includes("}")) {
      tracking = false;
    }
  }
}

if (linesToRemove.size > 0) {
  const filtered = lines.filter((_, i) => !linesToRemove.has(i));

  // Insert the external import after the banner (line 0)
  filtered.splice(1, 0, importLine);

  writeFileSync("dist/index.js", filtered.join("\n"));
  console.log(`✓ Step 2: Removed ${linesToRemove.size} inlined lines, added import from ${pluginEntryFile}`);
} else {
  console.warn("⚠ Could not find definePluginEntry function in bundle — skipping");
}

console.log("✓ Build complete");
