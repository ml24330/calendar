/* Launcher.

   node:sqlite needed --experimental-sqlite until Node 23.4, so work out
   whether this Node wants the flag and re-exec with it. Beats a README
   instruction people forget, and beats a native module that has to compile
   on the host.

   Modes: dev | build | preview  (Vite)      start (production server) */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `\n  Org Calendar needs Node 22.5 or newer for its built-in SQLite.\n` +
    `  This is ${process.versions.node}.\n`
  );
  process.exit(1);
}

const needsFlag = major === 22 || (major === 23 && minor < 4);
const flags = needsFlag ? ["--experimental-sqlite", "--no-warnings"] : [];
const mode = process.argv[2] || "dev";

let target;
if (mode === "start") {
  // Production. Vite is a devDependency and may not be installed at all.
  target = [path.resolve("server/index.js")];
} else {
  let vite;
  try {
    vite = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  } catch {
    vite = path.resolve("node_modules/vite/bin/vite.js");
  }
  if (!existsSync(vite)) {
    console.error("\n  Can't find Vite. Run `npm install` first.\n");
    process.exit(1);
  }
  target = [vite, ...(mode === "dev" ? [] : [mode])];
}

const child = spawn(process.execPath, [...flags, ...target], { stdio: "inherit" });
// Let Render/Docker stop us cleanly instead of being SIGKILLed after a timeout.
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
