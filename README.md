# Org Calendar

A shared calendar for an organization. Everyone can read it; only people with
the passphrase can change it. Events carry a tag, can be filtered by tag,
exported to PDF or `.ics`, subscribed to from a calendar app, and held back as
unpublished drafts until they're ready.

## Run it

Node 22.5 or newer — the app uses Node's built-in SQLite, so there's no native
module to compile.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. First run creates `calendar.db` with a couple of
weeks of sample events, including two drafts. Delete that file to start over.

## Try it

**The views.** Buttons top right, or press `Y` `M` `W` `D`. Arrows move, `T`
jumps to today. The year view is a wall planner — months across, days down —
rather than twelve mini-months, which is the fastest way to see how a year
clusters. Click any day to drop into it.

**Tags.** Click one in the sidebar to hide it. Counts, exports and the PDF all
follow the filter.

**Editing and drafts.** Click "Unlock editing". The first time, you choose the
passphrase; after that you enter it. Then you get Add event, Edit, Remove and
Manage tags — and the two seeded drafts appear, hatched and marked. The event
form has two save buttons: publish, or keep as a draft. Drafts are visible only
to people who have unlocked editing.

**PDF.** The Export panel has a button for the current view. You get a printable
sheet — a wall planner for year, a grid for month and week, an agenda for day —
followed by every event in the period with its full details. Filters carry over.
If you're unlocked, drafts are included and marked `DRAFT`; if you're not, they
aren't there at all.

**Sync.** Filter to one tag and download an `.ics` of exactly what's on screen,
or subscribe to a live feed:

```
http://localhost:5173/feed.ics
http://localhost:5173/feed.ics?tag=seminars
```

Apple Calendar accepts localhost (File → New Calendar Subscription), so the
whole subscribe loop is testable now. Google and Outlook fetch feeds from their
own servers and need a public address — use the download button while testing,
or run a tunnel.

To watch the sharing work, open two browser windows. Add an event in one; the
other picks it up within about fifteen seconds.

## Layout

```
index.html
vite.config.js          Vite + the API, mounted as a plugin
calendar.db             SQLite, created on first run
scripts/run.mjs         launcher (see "Why a launcher" below)
server/
  db.js                 schema, migrations, queries, seed
  auth.js               scrypt hashing, session tokens
  api.js                every route
  pdf.js                PDF rendering
src/
  OrgCalendar.jsx       state, filtering, navigation, layout
  styles.css
  components/
    views.jsx           YearPlanner, MonthGrid, TimeGrid
    dialogs.jsx         detail, add/edit, tags, passphrase, subscribe
  lib/
    api.js              client for the API
    dates.js            date maths, formatting, period ranges
    ics.js              iCalendar output — imported by browser AND server
    layout.js           overlap packing, multi-day expansion, colour
```

| Route | Auth | Does |
| --- | --- | --- |
| `GET /api/bootstrap` | optional | org name, tags, events. Drafts only with a session |
| `POST /api/session` | — | claims the calendar on first run, otherwise logs in |
| `DELETE /api/session` | token | logs out and revokes the token |
| `POST /api/events` | **required** | create |
| `PATCH /api/events/:id` | **required** | update, with a version check |
| `DELETE /api/events/:id` | **required** | delete |
| `PUT /api/tags` | **required** | replace the tag list |
| `GET /feed.ics[?tag=]` | optional | live feed. Published only unless `?token=` |
| `GET /export.pdf?view=&date=&tags=&q=` | optional | PDF. Drafts only with a token |

## Notes on the design

**Drafts are enforced on the server, not hidden in the browser.** Unpublished
events are filtered out of the SQL query for anyone without a valid session, so
they never reach an anonymous client at all — not in the page, not in devtools,
not in the feed, not in the PDF. Hiding them client-side would have been
theatre.

**Concurrent edits are refused, not merged.** Every event row carries a
`version`. `PATCH` sends the version you read; if someone else saved first the
server returns `409` with their current copy, and the app reloads it and tells
you to try again. Without this, the last person to hit save silently wins.

**Passphrases are scrypt-hashed** with a per-passphrase salt, verified in
constant time, and never leave the server. The browser holds only a session
token, in `sessionStorage`, valid for 12 hours.

**One iCalendar function.** `buildICS()` in `src/lib/ics.js` is imported by both
the browser's download button and the server's feed route, so a downloaded file
and a subscribed feed can't drift apart. Nothing in that module touches browser
globals at import time, which is what lets Node load it — worth remembering if
you edit it.

**Why a launcher.** `node:sqlite` needed `--experimental-sqlite` until Node
23.4. `scripts/run.mjs` checks your version and adds the flag only if it's
wanted, which beats a README instruction people forget. The alternative,
`better-sqlite3`, needs a prebuilt binary for your exact platform and Node
version or it falls back to compiling with node-gyp — which is a bad first
experience for anyone you hand this to.

**PDF fonts.** pdfkit's built-in Helvetica keeps the repo small. To match the
screen, drop IBM Plex `.ttf` files into `server/fonts/`, register them with
`doc.registerFont`, and change the two font constants at the top of
`server/pdf.js`.

## Before it goes on a real network

**Auth is real but minimal.** One shared passphrase, one role. Everyone who can
edit is the same person as far as the server is concerned, and there's no audit
trail of who changed what. If you need per-person accounts, replace
`POST /api/session` with your SSO and add a `created_by` column; the rest of the
routes already check a session and won't need changing.

**Serve it properly.** Vite's dev server isn't a production server. Run
`npm run build` and serve `dist/` from nginx or Caddy, and move `server/api.js`
into a small Express or Fastify app — the handler is plain
`(req, res, next)` and transfers unchanged. Put TLS in front of it: the
passphrase and session token cross the wire in the clear otherwise.

**Rate-limit the login route.** There's a 250 ms delay on a failed passphrase
and nothing else. On a public address you want a real limiter on
`POST /api/session`.

**Draft feed URLs are credentials.** `?token=` in a feed URL includes your
drafts, and calendar apps store that URL in plain text. Treat it accordingly.

**Backups are `cp calendar.db backup.db`** — but use `VACUUM INTO` or stop the
server first, since WAL mode means the `.db` file alone isn't a complete
snapshot while it's running.

## Odds and ends

- Times are stored as ISO strings in UTC and written to `.ics` in UTC.
  Everything displays in the viewer's local time.
- No recurring events. Adding them means `RRULE` on output and real `VTIMEZONE`
  blocks — UTC stamps stop being enough once a rule crosses a daylight-saving
  boundary.
- The week starts on Sunday. Change `WEEK_START` in `src/lib/dates.js` to `1`.
