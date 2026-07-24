import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { handle } from "./server/api.js";
import * as db from "./server/db.js";
import { ORG_NAME } from "./src/config.js";

/* The API lives in server/. It's mounted with a direct middlewares.use(),
   which installs it AHEAD of Vite's internal stack — if it went after,
   Vite's single-page-app fallback would answer /feed.ics and /export.pdf
   with index.html and a 200. */
/* Connect ahead of the first request so bad credentials show up at startup,
   and wrap the handler: it's async, and connect middleware doesn't await, so
   a rejected promise would otherwise leave the request hanging forever. */
function mount(server) {
  db.openWithTimeout()
    .then(() => console.log(`  database: ${db.dbPath()}${db.isRemote() ? "  (remote)" : "  (local file)"}`))
    .catch((err) => console.error(`\n  Database unavailable: ${err.message}\n`));

  server.middlewares.use((req, res, next) => {
    Promise.resolve(handle(req, res, next)).catch((err) => {
      console.error("Unhandled request error:", err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Internal error" }));
      }
    });
  });
}

function calendarApi() {
  return {
    name: "org-calendar-api",
    // Braces matter: Vite treats ANY value returned from configureServer as a
    // post-hook and calls it. `middlewares.use()` returns the connect app, so
    // an arrow with an implicit return hands Vite a function it then invokes
    // with no request — "Cannot read properties of undefined (reading 'url')".
    configureServer(server) {
      mount(server);
    },
    configurePreviewServer(server) {
      mount(server);
    },
  };
}

/* The tab title is static HTML, so it can't read React state. Injecting it at
   build time means it's correct before a single byte of JS runs, and there's
   still only one place to edit. */
function pageTitle() {
  return {
    name: "org-calendar-title",
    transformIndexHtml: (html) => html.replace("<!--org-name-->", ORG_NAME),
  };
}

export default defineConfig({
  plugins: [react(), calendarApi(), pageTitle()],
  server: {
    port: 5173,
    // true to let other machines on your network reach it
    host: false,
  },
});
