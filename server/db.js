/* Data layer, on libSQL.

   One driver covers both modes, because libSQL speaks SQLite:

     file:./calendar.db        `npm run dev`      — a plain local file
     libsql://…turso.io        `npm run dev-live-db`, and production

   The SQL below is ordinary SQLite and doesn't change between the two. What
   does change is that every call is async — a remote database is a network
   round trip, and pretending otherwise would mean lying about it somewhere.
*/

import { createClient } from "@libsql/client";
import path from "node:path";
import crypto from "node:crypto";
import { startOfDay } from "../src/lib/dates.js";
import { hashPassphrase, verifyPassphrase } from "./auth.js";

let client;
let ready;
let target;

/** Where the data lives, decided once from the environment. */
export function resolveTarget() {
  if (target) return target;
  const url = process.env.TURSO_DATABASE_URL;
  if (url) {
    target = {
      remote: true,
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
      label: url.replace(/^libsql:\/\//, "").split("?")[0],
    };
  } else {
    const file = path.join(path.resolve(process.env.DATA_DIR || process.cwd()), "calendar.db");
    target = { remote: false, url: "file:" + file, label: file, file };
  }
  return target;
}

export const dbPath = () => resolveTarget().label;
export const isRemote = () => resolveTarget().remote;

/* ------------------------------------------------------------------ schema */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  color    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  tag_id        TEXT REFERENCES tags(id) ON DELETE SET NULL,
  start_utc     TEXT NOT NULL,
  end_utc       TEXT NOT NULL,
  all_day       INTEGER NOT NULL DEFAULT 0,
  published     INTEGER NOT NULL DEFAULT 1,
  location      TEXT NOT NULL DEFAULT '',
  contact_name  TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  details       TEXT NOT NULL DEFAULT '',
  link          TEXT NOT NULL DEFAULT '',
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_start ON events(start_utc);
CREATE INDEX IF NOT EXISTS events_published ON events(published);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

/**
 * Connect, once, whoever asks first.
 *
 * There are two entry points — the production server and the Vite plugin —
 * and only one of them used to call this. Every accessor now goes through it,
 * so the layer works no matter who reaches it first. `client` is assigned
 * before the first await, which is what stops connect() deadlocking on its own
 * in-flight promise when seeding calls back in through run().
 */
export function open() {
  if (!ready) ready = connect();
  return ready;
}

async function connect() {
  const t = resolveTarget();
  client = createClient({ url: t.url, authToken: t.authToken });

  if (!t.remote) {
    // Only meaningful for a local file. A remote database manages its own
    // durability, and these pragmas are rejected or ignored there.
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA foreign_keys = ON");
  }

  await client.executeMultiple(SCHEMA);

  if (!(await getMeta("seeded"))) {
    await setMeta("seeded", new Date().toISOString());
    await seed();
    console.log(`\n  [org-calendar] initialised ${t.label} with sample events\n`);
  }

  await applyEnvPassphrase();
  return client;
}

/** How long to wait for a first response before saying so. Without this a bad
    URL or a blocked network just hangs, which reads as "the app is broken". */
const CONNECT_TIMEOUT_MS = Number(process.env.DB_TIMEOUT_MS) || 15000;

export function openWithTimeout() {
  return Promise.race([
    open(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(
        `No response from ${resolveTarget().label} after ${CONNECT_TIMEOUT_MS / 1000}s`
      )), CONNECT_TIMEOUT_MS).unref()
    ),
  ]);
}

export async function close() {
  ready = undefined;
  if (!client) return;
  try {
    if (!resolveTarget().remote) {
      // Fold the WAL back in so a copy of the .db file is complete.
      await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    client.close();
  } catch { /* already gone */ }
  client = undefined;
}

const run = async (sql, args = []) => {
  if (!client) await open();
  return client.execute({ sql, args });
};
const one = async (sql, args = []) => (await run(sql, args)).rows[0] ?? null;
const all = async (sql, args = []) => (await run(sql, args)).rows;

/* -------------------------------------------------------------------- meta */

export async function getMeta(key) {
  const row = await one("SELECT value FROM meta WHERE key = ?", [key]);
  return row ? row.value : null;
}

export async function setMeta(key, value) {
  await run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

/* -------------------------------------------------------------------- tags */

export const listTags = () =>
  all("SELECT id, name, color FROM tags ORDER BY position, name");

/** Tags are few and always edited together, so one batched replace is simpler
    than per-tag routes and just as safe. */
export async function replaceTags(tags) {
  const keep = tags.map((t) => t.id);
  const stmts = [];

  // A parameterised NOT IN, built to the right width.
  const holes = keep.map(() => "?").join(", ");
  stmts.push(
    keep.length
      ? { sql: `DELETE FROM tags WHERE id NOT IN (${holes})`, args: keep }
      : { sql: "DELETE FROM tags", args: [] }
  );

  tags.forEach((t, i) => stmts.push({
    sql: `INSERT INTO tags (id, name, color, position) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                                        color = excluded.color,
                                        position = excluded.position`,
    args: [t.id, t.name, t.color, i],
  }));

  // batch() is transactional: all of it lands, or none of it does.
  await client.batch(stmts, "write");
  return listTags();
}

/* ------------------------------------------------------------------ events */

const toApi = (r) => ({
  id: r.id,
  title: r.title,
  tagId: r.tag_id,
  start: r.start_utc,
  end: r.end_utc,
  allDay: !!r.all_day,
  published: !!r.published,
  location: r.location,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  details: r.details,
  link: r.link,
  version: Number(r.version),
  updatedAt: r.updated_at,
});

export async function listEvents({ includeDrafts = false, from, to } = {}) {
  const where = [];
  const args = [];
  if (!includeDrafts) where.push("published = 1");
  if (from && to) {
    // Any overlap with the window, not just events starting inside it.
    where.push("end_utc >= ? AND start_utc <= ?");
    args.push(from, to);
  }
  const rows = await all(
    "SELECT * FROM events" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY start_utc",
    args
  );
  return rows.map(toApi);
}

export async function getEvent(id, { includeDrafts = false } = {}) {
  const row = await one("SELECT * FROM events WHERE id = ?", [id]);
  if (!row) return null;
  if (!row.published && !includeDrafts) return null;
  return toApi(row);
}

export async function createEvent(ev) {
  const now = new Date().toISOString();
  const id = ev.id || crypto.randomUUID();
  await run(
    `INSERT INTO events (id, title, tag_id, start_utc, end_utc, all_day, published,
                         location, contact_name, contact_email, details, link,
                         version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [
      id, ev.title, ev.tagId ?? null, ev.start, ev.end,
      ev.allDay ? 1 : 0, ev.published === false ? 0 : 1,
      ev.location ?? "", ev.contactName ?? "", ev.contactEmail ?? "",
      ev.details ?? "", ev.link ?? "", now, now,
    ]
  );
  return getEvent(id, { includeDrafts: true });
}

/**
 * Optimistic concurrency: the caller sends the version it read. If someone
 * else saved meanwhile the versions differ and we refuse, rather than
 * silently overwriting their work.
 */
export async function updateEvent(id, patch, expectedVersion) {
  const row = await one("SELECT * FROM events WHERE id = ?", [id]);
  if (!row) return null;
  if (expectedVersion != null && Number(row.version) !== Number(expectedVersion)) {
    return { conflict: true, current: toApi(row) };
  }
  const m = { ...toApi(row), ...patch };
  await run(
    `UPDATE events SET title=?, tag_id=?, start_utc=?, end_utc=?, all_day=?, published=?,
       location=?, contact_name=?, contact_email=?, details=?, link=?,
       version = version + 1, updated_at=?
     WHERE id = ?`,
    [
      m.title, m.tagId ?? null, m.start, m.end,
      m.allDay ? 1 : 0, m.published ? 1 : 0,
      m.location ?? "", m.contactName ?? "", m.contactEmail ?? "",
      m.details ?? "", m.link ?? "", new Date().toISOString(), id,
    ]
  );
  return getEvent(id, { includeDrafts: true });
}

export async function deleteEvent(id) {
  const res = await run("DELETE FROM events WHERE id = ?", [id]);
  return Number(res.rowsAffected) > 0;
}

/* ---------------------------------------------------------------- sessions */

export async function createSession(token, ttlHours = 12) {
  const now = new Date();
  const exp = new Date(now.getTime() + ttlHours * 3600 * 1000);
  await run("INSERT INTO sessions (token, created_at, expires_at) VALUES (?,?,?)", [
    token, now.toISOString(), exp.toISOString(),
  ]);
  return exp.toISOString();
}

export async function sessionValid(token) {
  if (!token) return false;
  await run("DELETE FROM sessions WHERE expires_at < ?", [new Date().toISOString()]);
  return !!(await one("SELECT token FROM sessions WHERE token = ?", [token]));
}

export async function destroySession(token) {
  await run("DELETE FROM sessions WHERE token = ?", [token]);
}

/* -------------------------------------------------------------- passphrase */

/* On a public URL the "first visitor claims the calendar" flow is a land
   grab. Setting ADMIN_PASSPHRASE closes that window by claiming it at boot.
   Changing the variable rotates the passphrase and signs everyone out. */
async function applyEnvPassphrase() {
  const envPass = process.env.ADMIN_PASSPHRASE;
  if (!envPass) return;
  if (envPass.length < 8) {
    console.error("  [org-calendar] ADMIN_PASSPHRASE must be at least 8 characters. Ignoring it.");
    return;
  }
  const stored = await getMeta("adminHash");
  if (stored && verifyPassphrase(envPass, stored)) return;
  await setMeta("adminHash", hashPassphrase(envPass));
  await run("DELETE FROM sessions");
  console.log(stored
    ? "  [org-calendar] ADMIN_PASSPHRASE changed — existing sessions revoked"
    : "  [org-calendar] admin passphrase set from ADMIN_PASSPHRASE");
}

/* ------------------------------------------------------------------- seed */

const TAG_COLORS = ["#2F6FE0", "#00857A", "#B4530A", "#7A3EA8", "#C21B58", "#4A6E12"];

async function seed() {
  const base = startOfDay(new Date());
  const at = (day, h, m = 0) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + day, h, m).toISOString();

  await replaceTags([
    { id: "t1", name: "Seminars", color: TAG_COLORS[0] },
    { id: "t2", name: "Deadlines", color: TAG_COLORS[4] },
    { id: "t3", name: "Social", color: TAG_COLORS[3] },
    { id: "t4", name: "Facilities", color: TAG_COLORS[5] },
  ]);

  const rows = [
    ["Weekly research seminar", "t1", at(0, 12), at(0, 13, 30), 0, 1, "Landau 007",
      "John Doe", "johndoe@stanford.edu", "Open to everyone. Lunch provided; RSVP not required."],
    ["Reading group", "t1", at(0, 13), at(0, 14), 0, 1, "Landau 132",
      "Jane Roe", "janeroe@stanford.edu", "Overlaps the seminar on purpose — a good test of the week view."],
    ["Grant narrative due", "t2", at(3, 0), at(3, 0), 1, 1, "",
      "Jane Roe", "janeroe@stanford.edu", "Submit the final PDF through the internal portal before end of day."],
    ["New-hire coffee", "t3", at(1, 9), at(1, 10), 0, 1, "Landau atrium",
      "John Doe", "", "Drop in any time in the hour."],
    ["Network maintenance window", "t4", at(5, 20), at(5, 23, 59), 0, 1, "All buildings",
      "IT service desk", "it@stanford.edu", "Wired and wireless access will be intermittent."],
    ["Site visit — external reviewers", "t2", at(12, 0), at(14, 0), 1, 1, "Main campus",
      "Jane Roe", "janeroe@stanford.edu", "Three days. A multi-day event, to check the year and month views."],
    ["Happy Hour", "t3", at(2, 17), at(2, 19), 0, 1, "Landau 007",
      "John Doe", "johndoe@stanford.edu", "Drinks and snacks provided."],
    ["Quarterly all-hands", "t1", at(8, 15), at(8, 16, 30), 0, 1, "Auditorium + livestream",
      "Department office", "econ-office@stanford.edu", "Agenda circulated the week before."],
    /* Two drafts, so there's something to see once you log in to edit. */
    ["Reorg announcement (date not fixed)", "t1", at(6, 10), at(6, 11), 0, 0, "Auditorium",
      "Department office", "econ-office@stanford.edu", "Draft — do not circulate until the date is confirmed."],
    ["Holiday party — venue TBC", "t3", at(30, 18), at(30, 22), 0, 0, "TBC",
      "Social committee", "econ-social@stanford.edu", "Draft — waiting on a quote from the venue."],
  ];

  for (const [title, tagId, start, end, allDay, published, location, cn, ce, details] of rows) {
    await createEvent({
      title, tagId, start, end,
      allDay: !!allDay, published: !!published,
      location, contactName: cn, contactEmail: ce, details, link: "",
    });
  }
}
