/* Launcher for Vite.
   node:sqlite is built into Node but needed --experimental-sqlite until 23.4,
   so work out whether this Node wants the flag and re-exec with it. Beats
   telling people to remember a flag, and beats a native module that has to
   compile on their machine. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `\n  Org Calendar needs Node 22.5 or newer for its built-in SQLite.\n` +
    `  You're on ${process.versions.node}.\n`
  );
  process.exit(1);
}

const needsFlag = major === 22 || (major === 23 && minor < 4);
const mode = ["preview", "build"].includes(process.argv[2]) ? process.argv[2] : "";
// vite's package exports don't expose bin/, so resolve via package.json
// and fall back to the conventional path.
let vite;
try {
  vite = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
} catch {
  vite = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
}
if (!existsSync(vite)) {
  console.error("\n  Can't find Vite. Run `npm install` first.\n");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [...(needsFlag ? ["--experimental-sqlite", "--no-warnings"] : []), vite, ...(mode ? [mode] : [])],
  { stdio: "inherit" }
);
child.on("exit", (code) => process.exit(code ?? 0));
