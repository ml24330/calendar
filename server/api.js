/* The HTTP surface. Mounted into Vite by vite.config.js.

   Everything that decides what a caller may see goes through `isAdmin`, which
   is a server-side session lookup — not something the browser asserts. Drafts
   and the write routes are both behind it. */

import * as db from "./db.js";
import { hashPassphrase, verifyPassphrase, newToken, tokenFrom } from "./auth.js";
import { renderCalendarPdf } from "./pdf.js";
import { buildICS } from "../src/lib/ics.js";
import { slug, periodRange } from "../src/lib/dates.js";
import { ORG_NAME } from "../src/config.js";

const json = (res, code, body) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const isAdmin = (req, url) => db.sessionValid(tokenFrom(req, url));

/* --------------------------------------------------------------- validation */

const MAX = { title: 300, location: 300, contactName: 200, contactEmail: 320, details: 8000, link: 2000 };

function validateEvent(body, { partial = false } = {}) {
  const out = {};
  const err = (m) => { throw new Error(m); };

  const str = (k, required) => {
    if (body[k] === undefined) {
      if (required && !partial) err(`${k} is required`);
      return;
    }
    if (typeof body[k] !== "string") err(`${k} must be text`);
    if (body[k].length > MAX[k]) err(`${k} is longer than ${MAX[k]} characters`);
    out[k] = body[k].trim();
  };

  str("title", true);
  if (out.title !== undefined && !out.title) err("title cannot be empty");
  ["location", "contactName", "contactEmail", "details", "link"].forEach((k) => str(k, false));

  if (out.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(out.contactEmail)) {
    err("contactEmail is not a valid address");
  }

  for (const k of ["start", "end"]) {
    if (body[k] === undefined) {
      if (!partial) err(`${k} is required`);
      continue;
    }
    const d = new Date(body[k]);
    if (isNaN(d)) err(`${k} is not a valid date`);
    out[k] = d.toISOString();
  }
  if (out.start && out.end && new Date(out.end) < new Date(out.start)) {
    err("end is before start");
  }

  if (body.allDay !== undefined) out.allDay = !!body.allDay;
  if (body.published !== undefined) out.published = !!body.published;
  if (body.tagId !== undefined) {
    if (body.tagId !== null && typeof body.tagId !== "string") err("tagId must be a string or null");
    out.tagId = body.tagId || null;
  }
  return out;
}

/* -------------------------------------------------------------------- routes */

export async function handle(req, res, next) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    /* ---- everything the app needs on load ---- */
    if (p === "/api/bootstrap" && req.method === "GET") {
      const admin = isAdmin(req, url);
      return json(res, 200, {
        claimed: !!db.getMeta("adminHash"),
        admin,
        tags: db.listTags(),
        events: db.listEvents({ includeDrafts: admin }),
      });
    }

    /* ---- sessions ---- */
    if (p === "/api/session") {
      if (req.method === "POST") {
        const body = await readBody(req);
        const pass = String(body.passphrase || "");
        const existing = db.getMeta("adminHash");

        if (!existing) {
          // First run: whoever gets here first claims the calendar.
          if (pass.length < 8) return json(res, 400, { error: "Use at least 8 characters." });
          db.setMeta("adminHash", hashPassphrase(pass));
        } else if (!verifyPassphrase(pass, existing)) {
          // Uniform delay so a wrong passphrase can't be distinguished by timing.
          await new Promise((r) => setTimeout(r, 250));
          return json(res, 401, { error: "That passphrase doesn't match." });
        }

        const token = newToken();
        const expires = db.createSession(token);
        return json(res, 200, { token, expires });
      }

      if (req.method === "DELETE") {
        const t = tokenFrom(req, url);
        if (t) db.destroySession(t);
        return json(res, 200, { ok: true });
      }
    }

    /* ---- writes: all admin-only ---- */
    if (p === "/api/events" && req.method === "POST") {
      if (!isAdmin(req, url)) return json(res, 401, { error: "Log in to edit first." });
      const body = await readBody(req);
      return json(res, 201, db.createEvent(validateEvent(body)));
    }

    const eventMatch = p.match(/^\/api\/events\/([\w-]+)$/);
    if (eventMatch) {
      const id = eventMatch[1];
      if (!isAdmin(req, url)) return json(res, 401, { error: "Log in to edit first." });

      if (req.method === "PATCH") {
        const body = await readBody(req);
        const patch = validateEvent(body, { partial: true });
        const result = db.updateEvent(id, patch, body.version);
        if (!result) return json(res, 404, { error: "That event no longer exists." });
        if (result.conflict) {
          return json(res, 409, {
            error: "Someone else changed this event while you had it open.",
            current: result.current,
          });
        }
        return json(res, 200, result);
      }

      if (req.method === "DELETE") {
        return db.deleteEvent(id)
          ? json(res, 200, { ok: true })
          : json(res, 404, { error: "That event no longer exists." });
      }
    }


    if (p === "/api/tags" && req.method === "PUT") {
      if (!isAdmin(req, url)) return json(res, 401, { error: "Log in to edit first." });
      const body = await readBody(req);
      if (!Array.isArray(body.tags)) return json(res, 400, { error: "Expected { tags: [] }" });
      for (const t of body.tags) {
        if (!t.id || !t.name || !/^#[0-9a-fA-F]{6}$/.test(t.color || "")) {
          return json(res, 400, { error: "Each tag needs an id, a name, and a #rrggbb colour." });
        }
      }
      return json(res, 200, { tags: db.replaceTags(body.tags) });
    }

    /* ---- calendar feed: published only, unless a token says otherwise ---- */
    if (p === "/feed.ics" && req.method === "GET") {
      const admin = isAdmin(req, url);
      const tags = db.listTags();
      let events = db.listEvents({ includeDrafts: admin });
      let name = ORG_NAME;

      const wanted = url.searchParams.get("tag");
      if (wanted) {
        const tag = tags.find((t) => slug(t.name) === slug(wanted) || t.id === wanted);
        if (!tag) {
          res.statusCode = 404;
          return res.end(`No tag matches "${wanted}". Available: ${tags.map((t) => slug(t.name)).join(", ")}`);
        }
        events = events.filter((e) => e.tagId === tag.id);
        name = `${name} — ${tag.name}`;
      }
      if (admin) name += " (incl. drafts)";

      const tagsById = Object.fromEntries(tags.map((t) => [t.id, t]));
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Content-Disposition", `inline; filename="${slug(name) || "calendar"}.ics"`);
      return res.end(buildICS(events, tagsById, name));
    }

    /* ---- pdf of whatever view the caller was looking at ---- */
    if (p === "/export.pdf" && req.method === "GET") {
      const admin = isAdmin(req, url);
      const view = ["year", "month", "week", "day"].includes(url.searchParams.get("view"))
        ? url.searchParams.get("view")
        : "month";
      const dateParam = url.searchParams.get("date");
      const date = dateParam && !isNaN(new Date(dateParam)) ? new Date(dateParam) : new Date();
      const { from, to, label } = periodRange(view, date);

      let events = db.listEvents({
        includeDrafts: admin,
        from: from.toISOString(),
        to: to.toISOString(),
      });

      const allTags = db.listTags();
      const only = (url.searchParams.get("tags") || "").split(",").filter(Boolean);
      let tags = allTags;
      if (only.length) {
        const set = new Set(only);
        events = events.filter((e) => set.has(e.tagId || "__none"));
        tags = allTags.filter((t) => set.has(t.id));
      }
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (q) {
        events = events.filter((e) =>
          [e.title, e.location, e.details, e.contactName, e.contactEmail]
            .filter(Boolean).join(" ").toLowerCase().includes(q)
        );
      }

      const orgName = ORG_NAME;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${slug(orgName + " " + label)}.pdf"`);
      return renderCalendarPdf(res, {
        view, date, events, tags, orgName,
        includeDrafts: admin,
        filtered: only.length > 0 || !!q,
      });
    }

    if (p.startsWith("/api/")) {
      res.statusCode = 405;
      return res.end("Method not allowed");
    }
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  next();
}
