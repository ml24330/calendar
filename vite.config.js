import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { handle } from "./server/api.js";
import { ORG_NAME } from "./src/config.js";

/* The API lives in server/. It's mounted with a direct middlewares.use(),
   which installs it AHEAD of Vite's internal stack — if it went after,
   Vite's single-page-app fallback would answer /feed.ics and /export.pdf
   with index.html and a 200. */
function calendarApi() {
  return {
    name: "org-calendar-api",
    // Braces matter: Vite treats ANY value returned from configureServer as a
    // post-hook and calls it. `middlewares.use()` returns the connect app, so
    // an arrow with an implicit return hands Vite a function it then invokes
    // with no request — "Cannot read properties of undefined (reading 'url')".
    configureServer(server) {
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handle);
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
