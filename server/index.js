/* Production server.

   In development the API is mounted into Vite as a plugin. Here the same
   `handle` runs in a plain Node server that also serves the built dist/.
   It's the identical function in both places — nothing about the API is
   dev-only, which is the point. */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { handle } from "./api.js";
import * as db from "./db.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DIST = path.resolve(process.env.DIST_DIR || "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function sendFile(res, filePath, { immutable }) {
  const ext = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  // Vite fingerprints filenames in assets/, so those can be cached hard.
  // index.html must not be, or deploys won't reach anyone.
  res.setHeader(
    "Cache-Control",
    immutable ? "public, max-age=31536000, immutable" : "no-cache"
  );
  fs.createReadStream(filePath)
    .on("error", () => { res.statusCode = 500; res.end("Read error"); })
    .pipe(res);
}

function serveStatic(req, res, next) {
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // Resolve then confirm the result is still inside DIST, so ../ can't escape.
  const candidate = path.resolve(DIST, "." + pathname);
  if (candidate !== DIST && !candidate.startsWith(DIST + path.sep)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return sendFile(res, candidate, { immutable: pathname.startsWith("/assets/") });
  }

  // Single-page app: unknown paths get index.html so the client can route.
  const index = path.join(DIST, "index.html");
  if (fs.existsSync(index)) return sendFile(res, index, { immutable: false });

  res.statusCode = 404;
  res.end("Not built. Run `npm run build`.");
}

const server = http.createServer((req, res) => {
  securityHeaders(res);


  // The API answers what it recognises and calls next() for everything else.
  handle(req, res, () => serveStatic(req, res, () => {
    res.statusCode = 404;
    res.end("Not found");
  })).catch((err) => {
    console.error("Unhandled request error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  });
});

/* Refuse to start on a host that will silently eat the database.

   With TURSO_DATABASE_URL set the data lives elsewhere and none of this
   applies. Without it we are writing a local file, and on Render that file
   is replaced on every deploy — the calendar quietly resets to sample data,
   which is the worst kind of failure because it looks like it worked.

   Set ALLOW_EPHEMERAL_DATA=1 if you genuinely want a throwaway instance. */
if (process.env.RENDER && !db.isRemote() && !process.env.ALLOW_EPHEMERAL_DATA) {
  console.error(
    "\n  Refusing to start: TURSO_DATABASE_URL is not set, so this would write\n" +
    "  a local file that Render replaces on every deploy.\n\n" +
    "  Point it at the hosted database instead:\n" +
    "    Environment -> TURSO_DATABASE_URL = libsql://<your-db>.turso.io\n" +
    "    Environment -> TURSO_AUTH_TOKEN  = <turso db tokens create ...>\n\n" +
    "  Or attach a persistent disk and set DATA_DIR to its mount path.\n"
  );
  process.exit(1);
}

try {
  await db.openWithTimeout(); // connect and migrate before we accept traffic
} catch (err) {
  const where = db.isRemote() ? db.dbPath() : db.dbPath();
  console.error(
    `\n  Could not open the database (${where}).\n\n  ${err.message}\n\n` +
    (db.isRemote()
      ? "  Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN. A token is scoped to\n" +
        "  one database, so a mismatch reads as an auth failure. Confirm with:\n" +
        "    turso db show <your-db> --url\n" +
        "    turso db tokens create <your-db>\n"
      : "  Check that the directory exists and is writable.\n")
  );
  process.exit(1);
}

/* An unclaimed calendar on a public URL belongs to whoever finds it first.
   Refuse to start rather than serve one. */
if (!(await db.getMeta("adminHash"))) {
  console.error(
    "\n  This calendar has no admin passphrase, and on a public address the\n" +
    "  first visitor would be able to claim it.\n\n" +
    "  Set ADMIN_PASSPHRASE (8+ characters) and start again.\n"
  );
  process.exit(1);
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  Port ${PORT} is already in use. Stop the other process, or set PORT.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`  Org Calendar listening on http://${HOST}:${PORT}`);
  console.log(`  database: ${db.dbPath()}${db.isRemote() ? "  (remote)" : "  (local file)"}`);
  console.log(`  serving:  ${DIST}`);
});

/* Render sends SIGTERM on deploy and restart. Close the SQLite handle so WAL
   is checkpointed rather than leaving the database to recover on next boot. */
let closing = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log(`\n  ${sig} received, shutting down`);

    const finish = async (why) => {
      await db.close(); // checkpoints the WAL — must run on every exit path
      console.log(`  closed (${why})`);
      process.exit(0);
    };

    server.close(() => finish("connections drained"));
    // Idle keep-alive sockets keep server.close() pending indefinitely, which
    // would strand us until Render's SIGKILL and skip the checkpoint entirely.
    server.closeIdleConnections?.();
    setTimeout(() => {
      server.closeAllConnections?.();
      finish("forced after 5s");
    }, 5000).unref();
  });
}
