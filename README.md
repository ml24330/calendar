# Org Calendar

A shared calendar for an organization. Everyone can read it; only people with
the passphrase can change it. Events carry a tag, can be filtered by tag,
exported to PDF or `.ics`, subscribed to from a calendar app, and held back as
unpublished drafts until they're ready.

## Run it

Node 20.6 or newer.

```bash
npm install
npm run dev          # local database, a file in this directory
```

Open <http://localhost:5173>. First run creates `calendar.db` with a couple of
weeks of sample events, including two drafts. Delete it to start over.

### Two development modes

| Command | Database | For |
| --- | --- | --- |
| `npm run dev` | `./calendar.db`, local file | normal work. Break whatever you like |
| `npm run dev-live-db` | the hosted Turso database | reproducing something real, or fixing live data |

`dev-live-db` reads `.env` (via Node's own `--env-file`, no dependency) and
prints a red banner, because **it is the production database**. An event you
delete while poking around is gone for everyone.

```bash
cp .env.example .env      # then fill in
turso db show <your-db> --url
turso db tokens create <your-db>
```

`.env` is gitignored. `npm run dev` ignores it entirely.

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
calendar.db             local SQLite file (npm run dev only)
scripts/run.mjs         loads .env for npm run dev-live-db
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

**Why libSQL rather than plain SQLite.** One driver speaks both `file:` and
`libsql://`, so local development and production run identical code down to
the query layer. The cost is that every database call is async — a network
round trip can't honestly pretend to be synchronous.


**PDF fonts.** pdfkit's built-in Helvetica keeps the repo small. To match the
screen, drop IBM Plex `.ttf` files into `server/fonts/`, register them with
`doc.registerFont`, and change the two font constants at the top of
`server/pdf.js`.

## Deploying to Render

### Build pipeline

```
npm ci            # exact versions from package-lock.json
npm run build     # vite build -> dist/
```

`dist/` is the client only: fingerprinted JS and CSS plus `index.html`. The
server is **not** bundled — `server/` and `src/lib/` ship as plain ESM and run
from source, so don't prune them. `npm ci --omit=dev` would break the build
(Vite is a devDependency); install everything, build, and let Render keep the
resulting `node_modules`.

### Deploy pipeline

```
npm start   ->   scripts/run.mjs start   ->   node server/index.js
```

`server/index.js` serves `dist/` and mounts the same `handle` function the Vite
plugin uses in development. One code path, both environments.

In development, Vite serves the client and the API is a plugin. In production,
`server/index.js` serves both. The API is identical either way — that was the
point of keeping `handle` a plain `(req, res, next)`.

### Setting it up

`render.yaml` is in the repo. In Render: **New → Blueprint**, pick the repo,
then set `ADMIN_PASSPHRASE` in the dashboard when prompted. Or configure a Web
Service by hand:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check path | `/healthz` |

| Variable | Required | Does |
| --- | --- | --- |
| `ADMIN_PASSPHRASE` | **yes** | claims the calendar at boot. Change it to rotate; that revokes every session |
| `TURSO_DATABASE_URL` | **yes** | the hosted database |
| `TURSO_AUTH_TOKEN` | **yes** | token for it, from `turso db tokens create` |
| `NODE_VERSION` | yes | 22.5+ for built-in SQLite. Pinned in `.node-version` too |
| `PORT` | no | Render sets this |

### Where the data lives

The database is hosted on Turso, which is libSQL — a fork of SQLite. The
schema and every query in `server/db.js` are ordinary SQLite; only the driver
changed. Set two variables in the Render dashboard:

```
TURSO_DATABASE_URL = libsql://<your-db>.turso.io
TURSO_AUTH_TOKEN   = <turso db tokens create <your-db>>
```

Because nothing is stored on the instance, no persistent disk is needed and
the free plan works. That also removes the two constraints a disk imposed:
the service is no longer pinned to one instance, and deploys no longer have to
stop-then-start.

If `TURSO_DATABASE_URL` is missing the server refuses to start on Render
rather than writing a local file that the next deploy would erase. `/healthz`
reports which database is in use and whether it survives a deploy.

Free Turso databases are generous but not unlimited, and the plans move; check
<https://turso.tech/pricing> before assuming headroom.

### Backups

`turso db shell <your-db> ".dump" > backup.sql` takes a portable snapshot.
`GET /feed.ics` with an admin token is a second, coarser copy: every event
including drafts, in a format any calendar can read.

Locally, `calendar.db` is a normal SQLite file. The shutdown path checkpoints
the WAL on SIGTERM, so a copy taken while the server is stopped is complete.

### Why the server refuses to start without `ADMIN_PASSPHRASE`

The "first visitor claims the calendar" flow is fine on localhost and a land
grab on a public URL: anyone who finds the address before you sets the
passphrase and owns it. Setting the variable claims it at boot instead, so
there's no window. The production server exits with an explanation rather than
serving an unclaimed calendar.

### Still outstanding

- **Rate-limit `POST /api/session`.** There's a 250 ms delay on a failed
  passphrase and nothing else. On a public address that wants a real limiter.
- **One shared passphrase, one role**, and no record of who changed what. For
  per-person accounts, replace `POST /api/session` with your SSO and add a
  `created_by` column; the other routes already check a session and won't
  change.
- **Draft feed URLs are credentials.** `?token=` includes unpublished events,
  and calendar apps store the URL in plain text.

TLS is handled — Render terminates HTTPS at its edge and redirects HTTP.

## Time and timezones

The calendar runs on one clock, set by `CALENDAR_TZ` in `src/lib/tz.js`
(currently `America/Los_Angeles`). A seminar at noon Pacific reads as noon to
everyone, whether they're in Palo Alto, London, or on a laptop still set to
whatever timezone they flew in from, and whether the page is rendered in the
browser or the PDF is rendered on a server in Virginia.

Storage doesn't change: instants are UTC in SQLite and UTC in the `.ics` feed,
which is what makes the feed correct when someone subscribes from another
country — their calendar app converts, as it should. Only the *display* clock
is pinned.

Why this needed doing: every helper in `dates.js` reads wall-clock values with
`getHours()` and friends, which report the machine's zone. In the browser
that's the viewer's laptop; on Render it's UTC. Before this, a noon Pacific
seminar printed as 7pm in the PDF.

`toZoned()` turns a stored instant into a Date whose local getters read as
Pacific, so the existing helpers work unchanged. `fromZoned()` inverts it, and
is what the event form uses to turn what someone typed into a real instant.
The rule is: convert at the edges, never store a converted Date, and never
hand one to `toISOString()`.

Run `npm test` to check it. The suite runs the same assertions under eight
machine timezones, including both DST transitions and Chatham's 45-minute
offset.

Two cases can't round-trip, and both are properties of civil time rather than
bugs. When the clocks go back, two instants share one wall time and only one
can come back. And a wall time that falls in the *viewer's own* spring-forward
gap can't be held in a `Date` at all, so it reads an hour off — one hour a
year, only for viewers in a zone whose transition happens to overlap. Fixing
that last one properly means dropping `Date` for wall clock and rendering from
parts (`zonedParts` is exported for that), or waiting for `Temporal`.

To move the calendar to another campus, change `CALENDAR_TZ` and run
`npm test`.

## Renaming the calendar

Edit `ORG_NAME` in `src/config.js`, commit, deploy. That one constant feeds the
masthead, the browser tab, the `.ics` calendar name and the PDF header.

It is deliberately not an environment variable and not a database row. Both of
those meant the name could disagree with the code, and left you asking whether
a stale value was coming from the dashboard, a blueprint that hadn't synced, or
a row written months ago. A constant in the repo is greppable, diffable, and
wrong in only one place if it's wrong.

The tab title is static HTML and can't read React state, so Vite injects it at
build time from the same constant — correct before any JS runs, still only one
place to edit.

## Odds and ends

- Times are stored as ISO strings in UTC and written to `.ics` in UTC.
- No recurring events. Adding them means `RRULE` on output and real `VTIMEZONE`
  blocks — UTC stamps stop being enough once a rule crosses a daylight-saving
  boundary.
- The week starts on Sunday. Change `WEEK_START` in `src/lib/dates.js` to `1`.
