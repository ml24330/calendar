import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  MONTHS, MON_ABBR, DAY_ABBR, addDays, addMonths, startOfDay, startOfWeek, slug,
} from "./lib/dates.js";
import { expandDays, readableOn } from "./lib/layout.js";
import { toZoned, fromZoned, zonedNow, ZONE_LABEL, ZONE_NAME, viewerIsElsewhere, CALENDAR_TZ } from "./lib/tz.js";
import { downloadICS } from "./lib/ics.js";
import * as api from "./lib/api.js";
import { readParams, buildShareUrl, matchesToken } from "./lib/share.js";
import { ORG_NAME, CUR_YEAR } from "./config.js";
import { YearPlanner, MonthGrid, TimeGrid } from "./components/views.jsx";
import {
  EventDetail, EventForm, TagManager, AuthDialog, SubscribeHelp, ShareLink,
} from "./components/dialogs.jsx";

/* Parsed once per page load. Nothing writes back to the URL. */
const LINK = readParams();

export default function OrgCalendar() {
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [claimed, setClaimed] = useState(true);
  const [admin, setAdmin] = useState(false);
  const [tags, setTags] = useState([]);
  const [events, setEvents] = useState([]);

  const [view, setView] = useState(LINK.view || "month");
  const [cursor, setCursor] = useState(() => LINK.date || zonedNow());
  const [hidden, setHidden] = useState(() => new Set());
  const [showDrafts, setShowDrafts] = useState(true);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  const [now, setNow] = useState(() => zonedNow());

  const dialogRef = useRef(null);
  dialogRef.current = dialog;

  const refresh = useCallback(async () => {
    const data = await api.bootstrap();
    setClaimed(data.claimed);
    setAdmin(data.admin);
    setTags(data.tags);
    setEvents(data.events);
    setOffline(false);
    return data;
  }, []);

  useEffect(() => {
    refresh()
      /* A failed load means the server is unreachable — the offline banner
         says so on its own. The raw fetch message adds only noise. */
      .catch(() => setOffline(true))
      .finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(zonedNow()), 60000);
    return () => clearInterval(t);
  }, []);

  /* Pick up other people's edits. Skipped while a dialog is open, so a
     background refresh can't yank the form out from under you.
     60s rather than 15s: a shared calendar doesn't need second-level
     freshness, and every poll is a full read of the event table. */
  useEffect(() => {
    if (offline) return;
    const t = setInterval(() => {
      if (!dialogRef.current) refresh().catch(() => setOffline(true));
    }, 60000);
    return () => clearInterval(t);
  }, [refresh, offline]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(t);
  }, [notice]);

  /* ------------------------------------------------------------- actions */

  const run = useCallback(async (fn, successText) => {
    try {
      await fn();
      await refresh();
      if (successText) setNotice({ kind: "ok", text: successText });
      return true;
    } catch (err) {
      if (err.status === 409) {
        await refresh();
        setNotice({
          kind: "error",
          text: "Someone else changed that event while you had it open. I've loaded their version — try again.",
        });
      } else if (err.status === 401) {
        setAdmin(false);
        setNotice({ kind: "error", text: "Your editing session expired. Log in again to keep going." });
      } else {
        setNotice({ kind: "error", text: err.message });
      }
      return false;
    }
  }, [refresh]);

  const saveEvent = async (ev) => {
    const ok = await run(
      () => (ev.id ? api.updateEvent(ev.id, ev) : api.createEvent(ev)),
      ev.id
        ? (ev.published ? "Saved." : "Saved as a draft.")
        : (ev.published ? "Event added." : "Draft added — readers can't see it yet.")
    );
    if (ok) setDialog(null);
  };

  const removeEvent = async (id) => {
    if (await run(() => api.deleteEvent(id), "Event removed.")) setDialog(null);
  };

  const saveTags = async (next) => {
    if (await run(() => api.saveTags(next), "Tags saved.")) setDialog(null);
  };


  const unlock = async (passphrase) => {
    await api.login(passphrase);
    await refresh();
    setDialog(null);
    setNotice({ kind: "ok", text: "Logged in. Drafts are visible to you now." });
  };

  const lock = async () => {
    await api.logout();
    await refresh();
    setNotice({ kind: "ok", text: "Logged out." });
  };

  /* ------------------------------------------------------------- derived */

  const tagsById = useMemo(() => Object.fromEntries(tags.map((t) => [t.id, t])), [tags]);

  /* A query beginning with ":" selects a whole tag — ":Happy Hours" — rather
     than searching text. Matched against the tag's name and its id, so the
     sidebar buttons can use the name people actually recognise. */
  const tagQuery = useMemo(() => {
    const q = query.trim();
    if (!q.startsWith(":")) return null;
    const want = q.slice(1).trim().toLowerCase();
    if (!want) return null;
    if (want === "untagged" || want === "none") return "__none";
    /* Exact match only. Prefix matching would make a tag whose name is a
       prefix of another — "ABC" alongside "ABCD" — impossible to select on its
       own, and silently picking whichever came first was worse still. A
       partial name simply matches nothing until it is complete. */
    const hit = tags.find(
      (t) => t.name.toLowerCase() === want || t.id.toLowerCase() === want
    );
    return hit ? hit.id : "__nomatch";
  }, [query, tags]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((ev) => {
      if (!ev.published && !showDrafts) return false;
      if (hidden.has(ev.tagId || "__none")) return false;
      if (tagQuery) return (ev.tagId || "__none") === tagQuery;
      if (!q) return true;
      return [ev.title, ev.location, ev.details, ev.contactName, ev.contactEmail]
        .filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [events, hidden, query, showDrafts, tagQuery]);

  const byDay = useMemo(() => {
    const map = new Map();
    visible.forEach((ev) => expandDays(ev).forEach((k) => {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(ev);
    }));
    map.forEach((list) => list.sort((a, b) =>
      a.allDay === b.allDay ? toZoned(a.start) - toZoned(b.start) : (a.allDay ? -1 : 1)
    ));
    return map;
  }, [visible]);

  const counts = useMemo(() => {
    const c = {};
    events.forEach((ev) => {
      const k = ev.tagId || "__none";
      c[k] = (c[k] || 0) + 1;
    });
    return c;
  }, [events]);

  const draftCount = useMemo(() => events.filter((e) => !e.published).length, [events]);

  /* A shared link is applied whole or not at all.
   *
   * Partial application was worse than it sounds: a link whose date was
   * unreadable but whose tags were fine would open on today with a filter the
   * reader didn't choose, and no clear sense of what they were looking at.
   * Either the link is followed exactly, or the calendar opens at its default
   * with every tag showing and says so once.
   *
   * The check has to wait for the tag list, since a tag can only be known
   * missing once the real tags have loaded. Run once, so a later refresh can't
   * undo the reader's own filtering. */
  const linkSettled = useRef(false);
  useEffect(() => {
    if (!ready || linkSettled.current) return;
    if (LINK.tags && LINK.tags.length > 0 && tags.length === 0) return; // tags not in yet
    linkSettled.current = true;

    const all = [...tags.map((t) => t.id), "__none"];
    const unknownTag =
      !!LINK.tags && LINK.tags.some((tok) => !all.some((id) => matchesToken(id, tok)));
    const broken = LINK.invalid.length > 0 || unknownTag;

    if (broken) {
      setView("month");
      setCursor(zonedNow());
      setHidden(new Set());
      setNotice({
        kind: "error",
        text: "That link couldn't be read, so the calendar is showing its default view with every tag selected.",
      });
      return;
    }

    if (LINK.tags) {
      setHidden(new Set(all.filter((id) => !LINK.tags.some((tok) => matchesToken(id, tok)))));
    }
  }, [ready, tags]);

  const openShareDialog = () =>
    setDialog({ kind: "share", url: buildShareUrl({ view, cursor, hidden, tags, hasUntagged: (counts.__none || 0) > 0 }) });

  /* Every route into an event's detail goes through here, so a view is counted
     once per open and nowhere is missed. Fire-and-forget: the count must never
     delay the dialog or surface an error.

     Admin opens don't count. The number is meant to show what the department
     is actually reading, and whoever maintains the calendar opens events far
     more often than anyone else — counting those would drown the signal. */
  const openEvent = useCallback((ev) => {
    setDialog({ kind: "detail", ev });
    if (!admin) api.recordView(ev.id).catch(() => {});
  }, [admin]);

  /* Typeahead results. Drawn from the same set the calendar is showing, so
     the list and the grid can never disagree.
     Every match is listed and the panel scrolls, rather than silently cutting
     off at an arbitrary count — with a tag query especially, "show me all of
     them" is the whole point.
     Ordered by distance from today in either direction: what you are looking
     for is usually near now, and whether it is just behind or just ahead is
     not something the search box can know. Measured in whole days, so an
     all-day event today ranks with everything else today rather than being
     pushed back by its midnight start. */
  const searchHits = useMemo(() => {
    if (query.trim().length < 2) return [];
    const DAY = 86400000;
    const today = startOfDay(zonedNow()).getTime();
    return visible
      .map((ev) => {
        const at = toZoned(ev.start);
        const day = startOfDay(at).getTime();
        return { ev, day, at: at.getTime(), away: Math.abs(day - today) / DAY };
      })
      .sort((a, b) =>
        a.away - b.away ||   // nearest first
        b.day - a.day ||     // a tie is one ahead and one behind: prefer ahead
        a.at - b.at          // same day: earlier in the day first
      )
      .map((x) => x.ev);   // no cap: the list scrolls
  }, [visible, query]);

  useEffect(() => { setSearchIndex(0); }, [query]);

  /* Jump the calendar to the event and open it. Navigating as well as opening
     means closing the dialog leaves you somewhere useful rather than back
     where you started. */
  const pickHit = (ev) => {
    setCursor(toZoned(ev.start));
    openEvent(ev);
    setSearchOpen(false);
  };

  const searchRef = useRef(null);
  /* The close-on-blur timer, held so it can be cancelled. Clicking a control
     that reopens the list blurs the input first, arming this; without a handle
     on it the list would reopen and then be shut again 120ms later. */
  const blurTimer = useRef(null);
  const hitsRef = useRef(null);
  useEffect(() => {
    const el = hitsRef.current?.children[searchIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [searchIndex]);

  /* Browse a whole tag: fill the box with the tag query and open the list.
     Un-hides the tag first — asking to see a tag's events and getting nothing
     because it happens to be filtered out would be its own small puzzle. */
  const browseTag = (t) => {
    clearTimeout(blurTimer.current);   // this click may have just blurred the box
    setHidden((h) => { const n = new Set(h); n.delete(t.id); return n; });
    setQuery(`:${t.name}`);
    setSearchIndex(0);
    setSearchOpen(true);
    searchRef.current?.focus();
  };

  const onSearchKey = (e) => {
    if (e.key === "Escape") { setSearchOpen(false); return; }
    if (!searchHits.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSearchOpen(true);
      setSearchIndex((i) => (i + 1) % searchHits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSearchIndex((i) => (i - 1 + searchHits.length) % searchHits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickHit(searchHits[searchIndex] || searchHits[0]);
    }
  };

  /* ---------------------------------------------------------- navigation */

  const step = useCallback((dir) => {
    setCursor((c) => {
      if (view === "year") return new Date(c.getFullYear() + dir, c.getMonth(), 1);
      if (view === "month") return addMonths(c, dir);
      if (view === "week") return addDays(c, dir * 7);
      return addDays(c, dir);
    });
  }, [view]);

  useEffect(() => {
    const onKey = (e) => {
      if (dialogRef.current) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target?.tagName)) return;
      const k = e.key.toLowerCase();
      if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
      else if (k === "t") setCursor(zonedNow());
      else if (["y", "m", "w", "d"].includes(k)) {
        setView({ y: "year", m: "month", w: "week", d: "day" }[k]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  /* -------------------------------------------------------------- labels */

  const periodLabel = () => {
    if (view === "year") return String(cursor.getFullYear());
    if (view === "month") return MONTHS[cursor.getMonth()];
    if (view === "week") {
      const s = startOfWeek(cursor);
      const e = addDays(s, 6);
      return s.getMonth() === e.getMonth()
        ? `${MON_ABBR[s.getMonth()]} ${s.getDate()}–${e.getDate()}`
        : `${MON_ABBR[s.getMonth()]} ${s.getDate()} – ${MON_ABBR[e.getMonth()]} ${e.getDate()}`;
    }
    return `${MON_ABBR[cursor.getMonth()]} ${cursor.getDate()}`;
  };
  const periodSub = () => {
    if (view === "year") return "";
    if (view === "day") return `${DAY_ABBR[cursor.getDay()]} ${cursor.getFullYear()}`;
    return String(cursor.getFullYear());
  };

  const isFiltered = hidden.size > 0 || !!query.trim();

  const exportPdf = () => {
    const keep = [];
    if (isFiltered) {
      tags.forEach((t) => { if (!hidden.has(t.id)) keep.push(t.id); });
      if (!hidden.has("__none")) keep.push("__none");
    }
    window.open(
      api.pdfUrl({ view, date: fromZoned(cursor), tagIds: keep, query: query.trim() }),
      "_blank",
      "noopener"
    );
  };

  const exportName = () => {
    const active = tags.filter((t) => !hidden.has(t.id));
    return active.length === 1 ? `${slug(active[0].name)}.ics` : "org-calendar.ics";
  };

  const toggleFilter = (id) => setHidden((h) => {
    const n = new Set(h);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  if (!ready) {
    return <div className="empty" style={{ paddingTop: "22vh" }}>Loading the calendar…</div>;
  }

  return (
    <>
      <header className="masthead">
        <div className="mark">
          <b>{ORG_NAME}</b>
          <span>{CUR_YEAR}–{CUR_YEAR + 1}</span>
        </div>
        <div className="search-wrap">
          <input
            ref={searchRef}
            className="search mono"
            placeholder="Search events"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => { clearTimeout(blurTimer.current); setSearchOpen(true); }}
            /* Let a click on a result land before the list disappears. */
            onBlur={() => { blurTimer.current = setTimeout(() => setSearchOpen(false), 120); }}
            onKeyDown={onSearchKey}
            aria-label="Search events"
            aria-expanded={searchOpen && searchHits.length > 0}
            aria-autocomplete="list"
          />
          {searchOpen && searchHits.length > 0 && (
            <ul className="search-hits" role="listbox" ref={hitsRef}>
              {searchHits.length > 6 && (
                <li className="hits-count" aria-hidden="true">
                  {searchHits.length} matches — scroll for more
                </li>
              )}
              {searchHits.map((ev, i) => {
                const d = toZoned(ev.start);
                const tag = tagsById[ev.tagId];
                return (
                  <li key={ev.id} role="option" aria-selected={i === searchIndex}>
                    <button
                      className={"hit" + (i === searchIndex ? " on" : "")}
                      onMouseDown={(e) => { e.preventDefault(); pickHit(ev); }}
                      onMouseEnter={() => setSearchIndex(i)}
                    >
                      {/* Date only, and always the year: a time would be blank
                          for all-day events, and "Jul 24" is ambiguous once
                          results span more than one year. */}
                      <span className="hit-when mono">
                        {MON_ABBR[d.getMonth()]} {d.getDate()} {d.getFullYear()}
                      </span>
                      <span className="hit-title">
                        {!ev.published && <span className="hit-draft">draft</span>}
                        {ev.title}
                      </span>
                      {tag && <span className="swatch" style={{ background: tag.color }} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <button
          className={"lock" + (admin ? " on" : "")}
          onClick={() => (admin ? lock() : setDialog({ kind: "auth" }))}
          disabled={offline}
        >
          {admin ? "Log out" : "Log in to edit"}
        </button>
      </header>

      <div className="shell">
        <aside className="rail">
          {admin && (
            <button className="btn primary wide" onClick={() => setDialog({ kind: "form", ev: null })}>
              Add event
            </button>
          )}

          <section className="panel">
            <div className="panel-h" style={{ display: "flex", alignItems: "center" }}>
              <span className="eyebrow">Tags</span>
              {/* Only when there's something to clear. A permanently visible
                  control next to a list reads as "expand", which this is not —
                  the list is never truncated. */}
              {hidden.size > 0 && (
                <button className="more" style={{ marginLeft: "auto" }}
                  onClick={() => setHidden(new Set())}
                  title="Stop filtering and show every tag's events">
                  select all
                </button>
              )}
            </div>
            <div className="panel-b" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {tags.map((t) => {
                const off = hidden.has(t.id);
                return (
                  <div key={t.id} className="tag-line">
                    <button className={"tag-row" + (off ? " off" : "")}
                      onClick={() => toggleFilter(t.id)} aria-pressed={!off}
                      title={off ? `Show ${t.name}` : `Hide ${t.name}`}>
                      <TagCheck color={t.color} on={!off} />
                      <span className="n">{t.name}</span>
                      <span className="count">{counts[t.id] || 0}</span>
                    </button>
                    <button className="tag-browse"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => browseTag(t)}
                      title={`List every ${t.name} event`}
                      aria-label={`List every ${t.name} event`}>
                      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                        <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                        <line x1="10.2" y1="10.2" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                );
              })}
              {counts.__none > 0 && (
                <button className={"tag-row" + (hidden.has("__none") ? " off" : "")}
                  onClick={() => toggleFilter("__none")} aria-pressed={!hidden.has("__none")}
                  title={hidden.has("__none") ? "Show untagged events" : "Hide untagged events"}>
                  <TagCheck color="#9AA2BC" on={!hidden.has("__none")} />
                  <span className="n">Untagged</span>
                  <span className="count">{counts.__none}</span>
                </button>
              )}
              {admin && (
                <button className="btn sm wide" style={{ marginTop: 8 }}
                  onClick={() => setDialog({ kind: "tags" })}>
                  Manage tags
                </button>
              )}
              {/* Deliberately outside the admin check: sharing a filtered view
                  is something any reader might want. It sits last so the gap
                  above it is the same whether or not "Manage tags" is there. */}
              <button className="btn sm wide" style={{ marginTop: 8 }}
                onClick={openShareDialog}
                title="Get a link that opens this view, date and tag selection">
                Share calendar with selected tags
              </button>
            </div>
          </section>

          {admin && (
            <section className="panel">
              <div className="panel-h"><span className="eyebrow">Drafts</span></div>
              <div className="panel-b">
                <label className="check" style={{ marginBottom: 8 }}>
                  <input type="checkbox" checked={showDrafts}
                    onChange={(e) => setShowDrafts(e.target.checked)} />
                  Show unpublished events
                </label>
                <p className="note" style={{ margin: 0 }}>
                  {draftCount === 0
                    ? "Nothing unpublished right now."
                    : `${draftCount} unpublished. Only people logged in to edit can see ${draftCount === 1 ? "it" : "them"}; the feed, the downloads and the PDF leave ${draftCount === 1 ? "it" : "them"} out for everyone else.`}
                </p>
              </div>
            </section>
          )}


          <section className="panel">
            <div className="panel-h"><span className="eyebrow">Export</span></div>
            <div className="panel-b">
              <button className="btn wide" onClick={exportPdf} disabled={offline}>
                {periodLabel()} as PDF
              </button>
              <p className="note" style={{ marginTop: 6, marginBottom: 10 }}>
                A printable {view} sheet plus full details, matching your filters.
              </p>
              <button className="btn wide"
                onClick={() => downloadICS(visible, tagsById, ORG_NAME, exportName())}>
                Download {visible.length} event{visible.length === 1 ? "" : "s"} (.ics)
              </button>
              <button className="more" style={{ marginTop: 10 }}
                onClick={() => setDialog({ kind: "subscribe" })}>
                Subscribe to a live feed →
              </button>
            </div>
          </section>

          <p className="note">
            Keys: <span className="mono">←</span> <span className="mono">→</span> to move,
            <span className="mono"> T</span> for today, <span className="mono">Y M W D</span> to
            switch views. All times are in {ZONE_NAME}.
          </p>
        </aside>

        <main>
          {offline && (
            <div className="banner">
              The calendar isn't responding. Try refreshing the page in a moment.
            </div>
          )}
          {viewerIsElsewhere() && (
            <div className="banner">
              Your device is on a different clock. Every time here is shown in{" "}
              {ZONE_LABEL} ({CALENDAR_TZ.split("/")[1].replace("_", " ")}), not your local time.
              Events you add to your own calendar will convert automatically.
            </div>
          )}
          {notice && (
            <div className={"banner" + (notice.kind === "ok" ? " ok" : " bad")}>{notice.text}</div>
          )}
          {!claimed && !admin && !offline && (
            <div className="banner">
              Nobody has claimed this calendar yet. Choose “Log in to edit” to set the
              passphrase and become its editor.
            </div>
          )}

          <div className="toolbar">
            <div className="stepper">
              <button onClick={() => step(-1)} aria-label="Previous">‹</button>
              <button onClick={() => setCursor(zonedNow())}>Today</button>
              <button onClick={() => step(1)} aria-label="Next">›</button>
            </div>
            <h1 className="period">
              {periodLabel()} {periodSub() && <em>{periodSub()}</em>}
            </h1>
            <div className="views">
              {["year", "month", "week", "day"].map((v) => (
                <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="surface">
            {view === "year" && (
              <YearPlanner year={cursor.getFullYear()} byDay={byDay} tagsById={tagsById}
                tags={tags} hidden={hidden}
                onPickDay={(d) => { setCursor(d); setView("day"); }} />
            )}
            {view === "month" && (
              <MonthGrid cursor={cursor} byDay={byDay} tagsById={tagsById}
                onOpen={openEvent}
                onPickDay={(d) => { setCursor(d); setView("day"); }} />
            )}
            {view === "week" && (
              <TimeGrid days={Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i))}
                byDay={byDay} tagsById={tagsById} now={now}
                onOpen={openEvent}
                onPickDay={(d) => { setCursor(d); setView("day"); }} />
            )}
            {view === "day" && (
              <TimeGrid days={[startOfDay(cursor)]} byDay={byDay} tagsById={tagsById} now={now}
                onOpen={openEvent}
                onPickDay={(d) => setCursor(d)} />
            )}
          </div>
        </main>
      </div>

      {dialog?.kind === "detail" && (
        <EventDetail ev={dialog.ev} tag={tagsById[dialog.ev.tagId]} admin={admin}
          onClose={() => setDialog(null)}
          onEdit={() => setDialog({ kind: "form", ev: dialog.ev })}
          onDelete={() => removeEvent(dialog.ev.id)}
          onTogglePublished={() => saveEvent({ ...dialog.ev, published: !dialog.ev.published })} />
      )}
      {dialog?.kind === "form" && (
        <EventForm ev={dialog.ev} tags={tags} defaultDate={cursor}
          onClose={() => setDialog(null)} onSave={saveEvent} />
      )}
      {dialog?.kind === "tags" && (
        <TagManager tags={tags} counts={counts}
          onClose={() => setDialog(null)} onSave={saveTags} />
      )}
      {dialog?.kind === "auth" && (
        <AuthDialog claimed={claimed} onClose={() => setDialog(null)} onSubmit={unlock} />
      )}
      {dialog?.kind === "subscribe" && (
        <SubscribeHelp tags={tags} admin={admin} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "share" && (
        <ShareLink
          url={dialog.url}
          view={view}
          shownCount={tags.filter((t) => !hidden.has(t.id)).length}
          totalCount={tags.length}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

/**
 * The filter swatch. Filled with a tick while the tag is showing, an empty
 * outline once it's hidden — the tick is what tells you the row is a toggle
 * rather than a colour key. Decorative: the button around it already carries
 * the label and aria-pressed.
 */
function TagCheck({ color, on }) {
  return (
    <span
      className={"tag-check" + (on ? " on" : "")}
      style={{ borderColor: color, backgroundColor: on ? color : "transparent" }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 12 12">
        <path d="M2.4 6.3 L4.9 8.7 L9.6 3.4" stroke={readableOn(color)} />
      </svg>
    </span>
  );
}
