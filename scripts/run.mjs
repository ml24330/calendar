/* Launcher for `npm run dev-live-db`.

   Loads .env (Node's own --env-file, no dependency) so the Vite dev server
   picks up TURSO_DATABASE_URL, then hands over. `npm run dev` doesn't come
   through here at all — it's plain Vite against a local file. */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 20 || (major === 20 && minor < 6)) {
  console.error(`\n  Needs Node 20.6+ for --env-file. This is ${process.versions.node}.\n`);
  process.exit(1);
}

const ENV_FILE = path.resolve(".env");
if (!existsSync(ENV_FILE)) {
  console.error(
    "\n  No .env file.\n\n" +
    "  Copy .env.example to .env and fill in your Turso credentials:\n" +
    "    cp .env.example .env\n\n" +
    "  Get them with:\n" +
    "    turso db show <your-db> --url\n" +
    "    turso db tokens create <your-db>\n"
  );
  process.exit(1);
}

if (!/^\s*TURSO_DATABASE_URL\s*=\s*\S/m.test(readFileSync(ENV_FILE, "utf8"))) {
  console.error("\n  .env has no TURSO_DATABASE_URL, so this would just use the local file.\n");
  process.exit(1);
}

console.log(
  "\n  \x1b[41m\x1b[97m  LIVE DATABASE  \x1b[0m  Edits here change what everyone sees.\n" +
  "  Use `npm run dev` for a local copy.\n"
);

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

const child = spawn(process.execPath, [`--env-file=${ENV_FILE}`, vite], { stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
