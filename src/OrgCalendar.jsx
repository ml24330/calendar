import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  MONTHS, MON_ABBR, DAY_ABBR, addDays, addMonths, startOfDay, startOfWeek, slug,
} from "./lib/dates.js";
import { expandDays, readableOn } from "./lib/layout.js";
import { toZoned, fromZoned, zonedNow, ZONE_LABEL, viewerIsElsewhere, CALENDAR_TZ } from "./lib/tz.js";
import { downloadICS } from "./lib/ics.js";
import * as api from "./lib/api.js";
import { ORG_NAME, CUR_YEAR } from "./config.js";
import { YearPlanner, MonthGrid, TimeGrid } from "./components/views.jsx";
import {
  EventDetail, EventForm, TagManager, AuthDialog, SubscribeHelp,
} from "./components/dialogs.jsx";

export default function OrgCalendar() {
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [claimed, setClaimed] = useState(true);
  const [admin, setAdmin] = useState(false);
  const [tags, setTags] = useState([]);
  const [events, setEvents] = useState([]);

  const [view, setView] = useState("month");
  const [cursor, setCursor] = useState(() => zonedNow());
  const [hidden, setHidden] = useState(() => new Set());
  const [showDrafts, setShowDrafts] = useState(true);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState(null);
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
      .catch((err) => { setOffline(true); setNotice({ kind: "error", text: err.message }); })
      .finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(zonedNow()), 60000);
    return () => clearInterval(t);
  }, []);

  /* Pick up other people's edits. Skipped while a dialog is open, so a
     background refresh can't yank the form out from under you. */
  useEffect(() => {
    if (offline) return;
    const t = setInterval(() => {
      if (!dialogRef.current) refresh().catch(() => setOffline(true));
    }, 15000);
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

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((ev) => {
      if (!ev.published && !showDrafts) return false;
      if (hidden.has(ev.tagId || "__none")) return false;
      if (!q) return true;
      return [ev.title, ev.location, ev.details, ev.contactName, ev.contactEmail]
        .filter(Boolean).join(" ").toLowerCase().includes(q);
    });
  }, [events, hidden, query, showDrafts]);

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
        <input
          className="search mono"
          placeholder="Search events"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search events"
        />
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
              <button className="more" style={{ marginLeft: "auto" }} onClick={() => setHidden(new Set())}>
                show all
              </button>
            </div>
            <div className="panel-b" style={{ paddingTop: 6, paddingBottom: 6 }}>
              {tags.map((t) => {
                const off = hidden.has(t.id);
                return (
                  <button key={t.id} className={"tag-row" + (off ? " off" : "")}
                    onClick={() => toggleFilter(t.id)} aria-pressed={!off}
                    title={off ? `Show ${t.name}` : `Hide ${t.name}`}>
                    <TagCheck color={t.color} on={!off} />
                    <span className="n">{t.name}</span>
                    <span className="count">{counts[t.id] || 0}</span>
                  </button>
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
            switch views. All times are in {ZONE_LABEL}.
          </p>
        </aside>

        <main>
          {offline && (
            <div className="banner">
              The calendar server isn't responding. Start it with{" "}
              <span className="mono">npm run dev</span>, then reload.
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
                onOpen={(ev) => setDialog({ kind: "detail", ev })}
                onPickDay={(d) => { setCursor(d); setView("day"); }} />
            )}
            {view === "week" && (
              <TimeGrid days={Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i))}
                byDay={byDay} tagsById={tagsById} now={now}
                onOpen={(ev) => setDialog({ kind: "detail", ev })}
                onPickDay={(d) => { setCursor(d); setView("day"); }} />
            )}
            {view === "day" && (
              <TimeGrid days={[startOfDay(cursor)]} byDay={byDay} tagsById={tagsById} now={now}
                onOpen={(ev) => setDialog({ kind: "detail", ev })}
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
