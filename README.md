# Economics Social Calendar

A shared calendar for the Stanford Department of Economics, so anyone in the
department can see the social events that are happening — seminars,
receptions, happy hours, visits — in one place, and subscribe to the ones they
care about.

Everyone can read it. Editing is behind a passphrase.

## What it does

**Four views.** Year, month, week and day. The year view is laid out like a
printed wall planner — months across, days down — which makes it easy to see
how a year clusters. Keyboard: `←` `→` to move, `T` for today, `Y` `M` `W` `D`
to switch views.

**Events** carry a title, a tag, a time or an all-day date, a location, a point
of contact with an email, free-text details and an optional link.

**Tags** are colour-coded and filterable. Click a tag in the sidebar to hide
it; everything else — the counts, the exports, the year legend — follows the
filter.

**Drafts.** An event can be saved unpublished. Drafts are visible only to
people who have logged in to edit, and stay out of the feed, the downloads and
the PDF for everyone else. Useful when a date isn't confirmed yet.

**Export and subscribe.**

- A printable PDF of whatever view you're looking at: a wall planner for the
  year, a grid for a month or week, an agenda for a day, followed by full
  details of every event in the period. Filters carry over.
- A one-time `.ics` download of the events currently on screen, so filtering to
  one tag and downloading gives you just that tag.
- A live `.ics` feed, for the whole calendar or a single tag, that calendar
  apps re-check on their own.

**Times are shown in Pacific Time** regardless of where the reader is, so a
seminar at noon reads as noon to everyone. Events are stored in UTC, so a
subscriber abroad still gets the right local time in their own calendar app.

## Running it locally

Node 20.6 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The first run creates a local `calendar.db` with
a couple of weeks of sample events, including two drafts. Delete that file to
start over. The first person to open an unclaimed calendar sets the editing
passphrase.

```bash
npm run build     # production bundle into dist/
npm start         # serve dist/ and the API
npm test          # timezone conversion suite
```

### Two development modes

| Command | Database |
| --- | --- |
| `npm run dev` | `./calendar.db`, a local file. Break whatever you like |
| `npm run dev-live-db` | the same hosted database the deployed site uses |

`dev-live-db` is for reproducing something that only happens with real data, or
for fixing a bad entry without going through the deployed site. It is the same
application; only the database differs.

**It is the live database.** An event deleted while poking around is deleted
for everyone, immediately. The script prints a red banner on startup so this is
hard to forget.

It reads credentials from `.env`, using Node's built-in `--env-file`, and
refuses to start if that file is missing or has no database URL — rather than
quietly falling back to the local file and leaving you unsure which one you are
looking at.

```bash
cp .env.example .env    # then fill in; see the file for what each value is
```

`.env` is gitignored, and `npm run dev` ignores it entirely.

## Layout

```
index.html
vite.config.js          Vite, plus the API mounted as a plugin in development
src/
  config.js             calendar name and academic year
  OrgCalendar.jsx       state, filtering, navigation, layout
  styles.css
  components/
    views.jsx           year planner, month grid, week/day time grid
    dialogs.jsx         event detail, add/edit, tags, login, subscribe
  lib/
    api.js              client for the API
    dates.js            date arithmetic and formatting
    ics.js              iCalendar output, shared with the server
    layout.js           overlap packing, multi-day expansion, colour
    tz.js               pins the calendar to one timezone
server/
  db.js                 schema and queries
  api.js                every route
  auth.js               passphrase hashing and session tokens
  pdf.js                PDF rendering
  index.js              production server
```

| Route | Auth | Does |
| --- | --- | --- |
| `GET /api/bootstrap` | optional | tags and events. Drafts only with a session |
| `POST /api/session` | — | claims the calendar on first run, otherwise logs in |
| `DELETE /api/session` | token | logs out, revoking the token |
| `POST /api/events` | required | create |
| `PATCH /api/events/:id` | required | update, with a version check |
| `DELETE /api/events/:id` | required | delete |
| `PUT /api/tags` | required | replace the tag list |
| `GET /feed.ics[?tag=]` | optional | live feed, published events only |
| `GET /export.pdf` | optional | PDF of a view, with filters applied |
| `GET /healthz` | — | liveness |

## How it works

**Drafts are enforced on the server.** Unpublished events are filtered out of
the query for anyone without a valid session, so they never reach an anonymous
client at all — not in the page, not in the feed, not in the PDF.

**Concurrent edits are refused, not merged.** Every event carries a `version`.
An update sends the version it read; if someone else saved first the server
returns `409` with their copy, and the app reloads it rather than silently
overwriting their work.

**Passphrases are hashed with scrypt**, salted and verified in constant time,
and never leave the server. The browser holds only a session token.

**One iCalendar function.** `buildICS()` in `src/lib/ics.js` is imported by
both the download button and the feed route, so a downloaded file and a
subscribed feed cannot drift apart.

**One clock.** Every helper in `dates.js` reads wall-clock values that would
otherwise report the machine's timezone — the viewer's laptop in the browser,
the host on the server. `tz.js` pins both to `CALENDAR_TZ`. `npm test` checks
the conversions under eight machine timezones, including both daylight-saving
transitions.

## Configuration

| What | Where |
| --- | --- |
| Calendar name | `ORG_NAME` in `src/config.js` |
| Academic year in the masthead | `CUR_YEAR` in `src/config.js` |
| Timezone | `CALENDAR_TZ` in `src/lib/tz.js` |
| First day of the week | `WEEK_START` in `src/lib/dates.js` |
| Favicon | `public/favicon.svg` and the two PNGs |

## Limitations

- No recurring events. A weekly seminar is entered as separate events.
- One shared editing passphrase and one role, with no record of who changed
  what.
- A feed URL carrying a token includes drafts, so treat it as a password.

Deployment and day-to-day operation are covered in the user guide kept
alongside this repository.
