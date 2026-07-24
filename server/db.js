/* SQLite via Node's built-in driver — no native module to compile.
   The database is a single file, calendar.db, next to package.json. */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { startOfDay } from "../src/lib/dates.js";
import { hashPassphrase, verifyPassphrase } from "./auth.js";

/* DATA_DIR matters in production: on a PaaS the app directory is wiped on
   every deploy, so the database has to live on a mounted disk instead. */
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.cwd());
const DB_FILE = path.join(DATA_DIR, "calendar.db");

let db;

export const dbPath = () => DB_FILE;

export function close() {
  if (!db) return;
  try {
    // Fold the WAL back into the main file so a `cp` of the .db is complete.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  } catch { /* already closed */ }
  db = undefined;
}

/* ------------------------------------------------------------------ schema */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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

export function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(SCHEMA);

  // The calendar's name is a constant in src/config.js, not a stored value,
  // so "seeded" is what marks a database as initialised.
  if (!getMeta("seeded")) {
    setMeta("seeded", new Date().toISOString());
    seed();
    console.log(`\n  [org-calendar] created ${DB_FILE} with sample events\n`);
  }

  applyEnvPassphrase();
  return db;
}

/* On a public URL the "first visitor claims the calendar" flow is a land
   grab — anyone who finds the address before you owns it. Setting
   ADMIN_PASSPHRASE closes that window by claiming it at boot. Changing the
   variable rotates the passphrase and signs everyone out. */
function applyEnvPassphrase() {
  const envPass = process.env.ADMIN_PASSPHRASE;
  if (!envPass) return;
  if (envPass.length < 8) {
    console.error("  [org-calendar] ADMIN_PASSPHRASE must be at least 8 characters. Ignoring it.");
    return;
  }
  const stored = getMeta("adminHash");
  if (stored && verifyPassphrase(envPass, stored)) return; // unchanged
  setMeta("adminHash", hashPassphrase(envPass));
  db.prepare("DELETE FROM sessions").run();
  console.log(stored
    ? "  [org-calendar] ADMIN_PASSPHRASE changed — existing sessions revoked"
    : "  [org-calendar] admin passphrase set from ADMIN_PASSPHRASE");
}

/* ------------------------------------------------------------------- meta */

export function getMeta(key) {
  const row = open().prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  open()
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

/* ------------------------------------------------------------------- tags */

export function listTags() {
  return open()
    .prepare("SELECT id, name, color FROM tags ORDER BY position, name")
    .all();
}

/** Tags are few and always edited together, so a bulk replace in one
    transaction is simpler than per-tag routes and just as safe. */
export function replaceTags(tags) {
  const d = open();
  d.exec("BEGIN");
  try {
    const keep = new Set(tags.map((t) => t.id));
    for (const row of d.prepare("SELECT id FROM tags").all()) {
      // ON DELETE SET NULL leaves the events, untagged.
      if (!keep.has(row.id)) d.prepare("DELETE FROM tags WHERE id = ?").run(row.id);
    }
    const up = d.prepare(`
      INSERT INTO tags (id, name, color, position) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, position = excluded.position
    `);
    tags.forEach((t, i) => up.run(t.id, t.name, t.color, i));
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
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
  version: r.version,
  updatedAt: r.updated_at,
});

/**
 * @param {object} opts
 * @param {boolean} opts.includeDrafts  only ever true for an authenticated admin
 * @param {string}  [opts.from] [opts.to] ISO bounds, inclusive of overlap
 */
export function listEvents({ includeDrafts = false, from, to } = {}) {
  const where = [];
  const args = [];
  if (!includeDrafts) where.push("published = 1");
  if (from && to) {
    // Any overlap with the window, not just events starting inside it.
    where.push("end_utc >= ? AND start_utc <= ?");
    args.push(from, to);
  }
  const sql =
    "SELECT * FROM events" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY start_utc";
  return open().prepare(sql).all(...args).map(toApi);
}

export function getEvent(id, { includeDrafts = false } = {}) {
  const row = open().prepare("SELECT * FROM events WHERE id = ?").get(id);
  if (!row) return null;
  if (!row.published && !includeDrafts) return null;
  return toApi(row);
}

export function createEvent(ev) {
  const now = new Date().toISOString();
  const id = ev.id || crypto.randomUUID();
  open().prepare(`
    INSERT INTO events (id, title, tag_id, start_utc, end_utc, all_day, published,
                        location, contact_name, contact_email, details, link,
                        version, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)
  `).run(
    id, ev.title, ev.tagId ?? null, ev.start, ev.end,
    ev.allDay ? 1 : 0, ev.published === false ? 0 : 1,
    ev.location ?? "", ev.contactName ?? "", ev.contactEmail ?? "",
    ev.details ?? "", ev.link ?? "", now, now
  );
  return getEvent(id, { includeDrafts: true });
}

/**
 * Optimistic concurrency: the caller sends the version it read. If someone
 * else saved in the meantime the versions differ and we refuse, rather than
 * silently overwriting their work.
 * @returns {{conflict: true, current: object} | object}
 */
export function updateEvent(id, patch, expectedVersion) {
  const d = open();
  const row = d.prepare("SELECT * FROM events WHERE id = ?").get(id);
  if (!row) return null;
  if (expectedVersion != null && row.version !== expectedVersion) {
    return { conflict: true, current: toApi(row) };
  }
  const merged = { ...toApi(row), ...patch };
  d.prepare(`
    UPDATE events SET title=?, tag_id=?, start_utc=?, end_utc=?, all_day=?, published=?,
      location=?, contact_name=?, contact_email=?, details=?, link=?,
      version = version + 1, updated_at=?
    WHERE id = ?
  `).run(
    merged.title, merged.tagId ?? null, merged.start, merged.end,
    merged.allDay ? 1 : 0, merged.published ? 1 : 0,
    merged.location ?? "", merged.contactName ?? "", merged.contactEmail ?? "",
    merged.details ?? "", merged.link ?? "", new Date().toISOString(), id
  );
  return getEvent(id, { includeDrafts: true });
}

export function deleteEvent(id) {
  return open().prepare("DELETE FROM events WHERE id = ?").run(id).changes > 0;
}

/* --------------------------------------------------------------- sessions */

export function createSession(token, ttlHours = 12) {
  const now = new Date();
  const exp = new Date(now.getTime() + ttlHours * 3600 * 1000);
  open()
    .prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?,?,?)")
    .run(token, now.toISOString(), exp.toISOString());
  return exp.toISOString();
}

export function sessionValid(token) {
  if (!token) return false;
  const d = open();
  d.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  return !!d.prepare("SELECT token FROM sessions WHERE token = ?").get(token);
}

export function destroySession(token) {
  open().prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/* ------------------------------------------------------------------- seed */

const TAG_COLORS = ["#2F6FE0", "#00857A", "#B4530A", "#7A3EA8", "#C21B58", "#4A6E12"];

function seed() {
  const base = startOfDay(new Date());
  const at = (day, h, m = 0) =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + day, h, m).toISOString();

  replaceTags([
    { id: "t1", name: "Seminars", color: TAG_COLORS[0] },
    { id: "t2", name: "Deadlines", color: TAG_COLORS[4] },
    { id: "t3", name: "Social", color: TAG_COLORS[3] },
    { id: "t4", name: "Facilities", color: TAG_COLORS[5] },
  ]);

  const rows = [
    ["Weekly research seminar", "t1", at(0, 12), at(0, 13, 30), 0, 1, "Building 4, Room 210",
      "Priya Raman", "praman@example.org", "Open to everyone. Lunch provided; RSVP not required."],
    ["Reading group: attention mechanisms", "t1", at(0, 13), at(0, 14), 0, 1, "Building 4, Room 118",
      "Sam Okonkwo", "sokonkwo@example.org", "Overlaps the seminar on purpose — a good test of the week view."],
    ["Grant narrative due to the dean's office", "t2", at(3, 0), at(3, 0), 1, 1, "",
      "Ana Duarte", "aduarte@example.org", "Submit the final PDF through the internal portal before end of day."],
    ["New-hire coffee", "t3", at(1, 9), at(1, 10), 0, 1, "Atrium café",
      "Marcus Bell", "", "Drop in any time in the hour."],
    ["Network maintenance window", "t4", at(5, 20), at(5, 23, 59), 0, 1, "All buildings",
      "IT service desk", "it@example.org", "Wired and wireless access will be intermittent."],
    ["Site visit — external reviewers", "t2", at(12, 0), at(14, 0), 1, 1, "Main campus",
      "Ana Duarte", "aduarte@example.org", "Three days. A multi-day event, to check the year and month views."],
    ["Quarterly all-hands", "t1", at(8, 15), at(8, 16, 30), 0, 1, "Auditorium + livestream",
      "Office of the Director", "director@example.org", "Agenda circulated the week before."],
    ["Summer picnic", "t3", at(24, 11), at(24, 15), 0, 1, "Riverside park, shelter B",
      "Social committee", "social@example.org", "Families welcome. Bring a dish if you can."],
    /* Two drafts, so there's something to see once you unlock editing. */
    ["Reorg announcement (date not fixed)", "t1", at(6, 10), at(6, 11), 0, 0, "Auditorium",
      "Office of the Director", "director@example.org", "Draft — do not circulate until the date is confirmed."],
    ["Holiday party — venue TBC", "t3", at(30, 18), at(30, 22), 0, 0, "TBC",
      "Social committee", "social@example.org", "Draft — waiting on a quote from the venue."],
  ];

  for (const [title, tagId, start, end, allDay, published, location, cn, ce, details] of rows) {
    createEvent({
      title, tagId, start, end,
      allDay: !!allDay, published: !!published,
      location, contactName: cn, contactEmail: ce, details, link: "",
    });
  }
}
