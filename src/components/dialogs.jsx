import { useEffect, useMemo, useState } from "react";
import { startOfDay, toInput, toDateInput, fmtLongDate, fmtRange, slug } from "../lib/dates.js";
import { downloadICS, googleUrl } from "../lib/ics.js";
import { tint } from "../lib/layout.js";

const TAG_COLORS = [
  "#2F6FE0", "#00857A", "#B4530A", "#7A3EA8",
  "#C21B58", "#4A6E12", "#0F6EA8", "#8A5A00",
];
const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));

/* -------------------------------------------------------------- scaffold */

export function Scrim({ children, onClose, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" style={wide ? { maxWidth: 640 } : undefined} role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

function CopyButton({ text }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn sm" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      } catch { /* clipboard blocked */ }
    }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function DraftBadge() {
  return <span className="pill draft-pill">Draft · not visible to readers</span>;
}

/* ---------------------------------------------------------- event detail */

export function EventDetail({ ev, tag, admin, onClose, onEdit, onDelete, onTogglePublished }) {
  const [confirming, setConfirming] = useState(false);
  const c = (tag && tag.color) || "#9AA2BC";

  return (
    <Scrim onClose={onClose}>
      <div className="dlg-h" style={{ borderTop: `4px solid ${ev.published ? c : "#C9A227"}` }}>
        <div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {tag && (
              <span className="pill" style={{ background: tint(c, 0.13), color: c }}>
                <span className="swatch" style={{ background: c }} />{tag.name}
              </span>
            )}
            {!ev.published && <DraftBadge />}
          </div>
          <h2 style={{ marginTop: 8 }}>{ev.title}</h2>
        </div>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="dlg-b">
        <dl className="meta">
          <dt>When</dt>
          <dd>
            {fmtLongDate(new Date(ev.start))}<br />
            <span className="mono" style={{ fontSize: 13 }}>{fmtRange(ev)}</span>
          </dd>
          {ev.location && (<><dt>Where</dt><dd>{ev.location}</dd></>)}
          {(ev.contactName || ev.contactEmail) && (
            <>
              <dt>Contact</dt>
              <dd>
                {ev.contactName}
                {ev.contactEmail && (
                  <>{ev.contactName ? " · " : ""}<a href={`mailto:${ev.contactEmail}`}>{ev.contactEmail}</a></>
                )}
              </dd>
            </>
          )}
          {ev.link && (
            <><dt>Link</dt><dd><a href={ev.link} target="_blank" rel="noreferrer noopener">{ev.link}</a></dd></>
          )}
          {ev.details && (<><dt>Details</dt><dd style={{ whiteSpace: "pre-wrap" }}>{ev.details}</dd></>)}
        </dl>
      </div>

      <div className="dlg-f">
        {ev.published ? (
          <>
            <a className="btn" href={googleUrl(ev, tag && tag.name)} target="_blank" rel="noreferrer noopener">
              Add to Google Calendar
            </a>
            <button className="btn" onClick={() => downloadICS(
              [ev], tag ? { [tag.id]: tag } : {}, ev.title,
              `${slug(ev.title).slice(0, 40) || "event"}.ics`
            )}>
              Download .ics
            </button>
          </>
        ) : (
          <span className="note" style={{ maxWidth: 300 }}>
            Publish this event to make it available in the feed and downloads.
          </span>
        )}

        {admin && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn" onClick={onTogglePublished}>
              {ev.published ? "Unpublish" : "Publish"}
            </button>
            <button className="btn" onClick={onEdit}>Edit</button>
            {confirming
              ? <button className="btn danger" onClick={onDelete}>Really remove?</button>
              : <button className="btn danger" onClick={() => setConfirming(true)}>Remove</button>}
          </div>
        )}
      </div>
    </Scrim>
  );
}

/* ------------------------------------------------------------ event form */

export function EventForm({ ev, tags, defaultDate, onClose, onSave }) {
  const base = useMemo(() => {
    if (ev) return ev;
    const d = startOfDay(defaultDate);
    return {
      title: "",
      tagId: tags[0] ? tags[0].id : null,
      start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0).toISOString(),
      end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 11, 0).toISOString(),
      allDay: false,
      published: true,
      location: "", contactName: "", contactEmail: "", details: "", link: "",
    };
  }, [ev, defaultDate, tags]);

  const [f, setF] = useState(() => ({
    ...base,
    startIn: base.allDay ? toDateInput(new Date(base.start)) : toInput(new Date(base.start)),
    endIn: base.allDay ? toDateInput(new Date(base.end)) : toInput(new Date(base.end)),
  }));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  const toggleAllDay = (on) => setF((p) => ({
    ...p,
    allDay: on,
    startIn: on ? p.startIn.slice(0, 10) : `${p.startIn.slice(0, 10)}T10:00`,
    endIn: on ? p.endIn.slice(0, 10) : `${p.endIn.slice(0, 10)}T11:00`,
  }));

  const submit = async (publish) => {
    if (!f.title.trim()) return setErr("Give the event a title.");
    if (!f.startIn || !f.endIn) return setErr("Set a start and an end.");
    const s = new Date(f.allDay ? `${f.startIn}T00:00` : f.startIn);
    const e = new Date(f.allDay ? `${f.endIn}T00:00` : f.endIn);
    if (isNaN(s) || isNaN(e)) return setErr("That date doesn't parse. Check the start and end.");
    if (e < s) return setErr("The end is before the start.");
    if (f.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contactEmail)) {
      return setErr("That contact email doesn't look right.");
    }
    setErr("");
    setBusy(true);
    await onSave({
      ...(ev ? { id: ev.id, version: ev.version } : {}),
      title: f.title.trim(),
      tagId: f.tagId || null,
      start: s.toISOString(),
      end: e.toISOString(),
      allDay: !!f.allDay,
      published: publish,
      location: f.location.trim(),
      contactName: f.contactName.trim(),
      contactEmail: f.contactEmail.trim(),
      details: f.details.trim(),
      link: f.link.trim(),
    });
    setBusy(false);
  };

  return (
    <Scrim onClose={onClose} wide>
      <div className="dlg-h">
        <h2>{ev ? "Edit event" : "Add event"}</h2>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="dlg-b">
        <div className="field">
          <label className="eyebrow" htmlFor="f-title">Title</label>
          <input id="f-title" className="inp" value={f.title} autoFocus
            onChange={(e) => set("title", e.target.value)} placeholder="Weekly research seminar" />
        </div>

        <div className="two">
          <div className="field">
            <label className="eyebrow" htmlFor="f-tag">Tag</label>
            <select id="f-tag" className="inp" value={f.tagId || ""}
              onChange={(e) => set("tagId", e.target.value || null)}>
              <option value="">Untagged</option>
              {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ display: "flex", alignItems: "flex-end", paddingBottom: 9 }}>
            <label className="check">
              <input type="checkbox" checked={f.allDay}
                onChange={(e) => toggleAllDay(e.target.checked)} />
              All-day event
            </label>
          </div>
        </div>

        <div className="two">
          <div className="field">
            <label className="eyebrow" htmlFor="f-start">Starts</label>
            <input id="f-start" className="inp mono" type={f.allDay ? "date" : "datetime-local"}
              value={f.startIn} onChange={(e) => set("startIn", e.target.value)} />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="f-end">Ends</label>
            <input id="f-end" className="inp mono" type={f.allDay ? "date" : "datetime-local"}
              value={f.endIn} onChange={(e) => set("endIn", e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label className="eyebrow" htmlFor="f-loc">Location</label>
          <input id="f-loc" className="inp" value={f.location}
            onChange={(e) => set("location", e.target.value)} placeholder="Building 4, Room 210" />
        </div>

        <div className="two">
          <div className="field">
            <label className="eyebrow" htmlFor="f-cn">Point of contact</label>
            <input id="f-cn" className="inp" value={f.contactName}
              onChange={(e) => set("contactName", e.target.value)} placeholder="Priya Raman" />
          </div>
          <div className="field">
            <label className="eyebrow" htmlFor="f-ce">Contact email</label>
            <input id="f-ce" className="inp" type="email" value={f.contactEmail}
              onChange={(e) => set("contactEmail", e.target.value)} placeholder="praman@example.org" />
          </div>
        </div>

        <div className="field">
          <label className="eyebrow" htmlFor="f-link">Link</label>
          <input id="f-link" className="inp" value={f.link}
            onChange={(e) => set("link", e.target.value)} placeholder="https://…" />
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label className="eyebrow" htmlFor="f-det">Details</label>
          <textarea id="f-det" className="inp" value={f.details}
            onChange={(e) => set("details", e.target.value)}
            placeholder="Anything attendees should know before they arrive." />
        </div>

        {err && <p className="err">{err}</p>}
      </div>

      <div className="dlg-f">
        <button className="btn primary" disabled={busy} onClick={() => submit(true)}>
          {ev ? (f.published ? "Save changes" : "Save and publish") : "Add and publish"}
        </button>
        <button className="btn" disabled={busy} onClick={() => submit(false)}>
          {ev && !f.published ? "Save draft" : "Save as draft"}
        </button>
        <button className="btn" onClick={onClose} style={{ marginLeft: "auto" }}>Cancel</button>
        <p className="note" style={{ width: "100%", margin: "6px 0 0" }}>
          A draft is visible only to people who unlock editing. It stays out of the calendar
          feed, the .ics downloads and the PDF until you publish it.
        </p>
      </div>
    </Scrim>
  );
}

/* ----------------------------------------------------------- tag manager */

export function TagManager({ tags, counts, onClose, onSave }) {
  const [list, setList] = useState(tags);
  const [busy, setBusy] = useState(false);
  const update = (id, patch) => setList((l) => l.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  return (
    <Scrim onClose={onClose}>
      <div className="dlg-h">
        <h2>Manage tags</h2>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="dlg-b">
        {list.map((t) => (
          <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input type="color" value={t.color} aria-label="Tag colour"
              style={{ width: 34, height: 34, padding: 2, border: "1px solid var(--rule)" }}
              onChange={(e) => update(t.id, { color: e.target.value })} />
            <input className="inp" value={t.name} onChange={(e) => update(t.id, { name: e.target.value })} />
            <span className="count" style={{ width: 22, textAlign: "right" }}>{counts[t.id] || 0}</span>
            <button className="btn sm danger"
              onClick={() => setList((l) => l.filter((x) => x.id !== t.id))}>Remove</button>
          </div>
        ))}
        <button className="btn sm" style={{ marginTop: 4 }}
          onClick={() => setList((l) => [...l, {
            id: newId(), name: "New tag", color: TAG_COLORS[l.length % TAG_COLORS.length],
          }])}>
          Add a tag
        </button>
        <p className="note" style={{ marginBottom: 0 }}>
          Removing a tag leaves its events in place and marks them untagged.
        </p>
      </div>
      <div className="dlg-f">
        <button className="btn primary" disabled={busy} onClick={async () => {
          setBusy(true);
          await onSave(list.filter((t) => t.name.trim()).map((t) => ({ ...t, name: t.name.trim() })));
          setBusy(false);
        }}>
          Save tags
        </button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Scrim>
  );
}

/* ------------------------------------------------------------ passphrase */

export function AuthDialog({ claimed, onClose, onSubmit }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (!claimed) {
      if (pw.length < 8) return setErr("Use at least 8 characters.");
      if (pw !== pw2) return setErr("The two entries don't match.");
    }
    setErr("");
    setBusy(true);
    try {
      await onSubmit(pw);
    } catch (e) {
      setErr(e.message || "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Scrim onClose={onClose}>
      <div className="dlg-h">
        <h2>{claimed ? "Unlock editing" : "Set the editing passphrase"}</h2>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="dlg-b">
        <p className="note" style={{ marginTop: 0 }}>
          {claimed
            ? "Enter the passphrase your calendar owner shared with you. Unlocking also shows unpublished events."
            : "Nobody has claimed this calendar yet. Choose a passphrase and share it with whoever should be able to add and edit events."}
        </p>
        <div className="field">
          <label className="eyebrow" htmlFor="pw">Passphrase</label>
          <input id="pw" className="inp" type="password" value={pw} autoFocus
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && claimed) go(); }} />
        </div>
        {!claimed && (
          <div className="field">
            <label className="eyebrow" htmlFor="pw2">Confirm passphrase</label>
            <input id="pw2" className="inp" type="password" value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
          </div>
        )}
        {err && <p className="err">{err}</p>}
        <p className="note">
          The passphrase is checked on the server and stored as a scrypt hash. Your browser
          holds only a session token, which expires after 12 hours.
        </p>
      </div>
      <div className="dlg-f">
        <button className="btn primary" disabled={busy} onClick={go}>
          {busy ? "Checking…" : claimed ? "Unlock" : "Set passphrase"}
        </button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </Scrim>
  );
}

/* ------------------------------------------------------------- subscribe */

export function SubscribeHelp({ tags, admin, onClose }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const all = `${origin}/feed.ics`;

  return (
    <Scrim onClose={onClose} wide>
      <div className="dlg-h">
        <h2>Subscribe to this calendar</h2>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="dlg-b">
        <p className="note" style={{ marginTop: 0 }}>
          Downloading gives you a one-time copy. Subscribing points your calendar app at a URL
          it re-checks on its own, so new and changed events arrive without you doing anything.
          Feeds carry published events only.
        </p>

        <p className="eyebrow" style={{ marginTop: 16, marginBottom: 6 }}>Everything</p>
        <div className="feed-row">
          <code className="code">{all}</code>
          <CopyButton text={all} />
        </div>

        <p className="eyebrow" style={{ marginTop: 16, marginBottom: 6 }}>One tag at a time</p>
        {tags.map((t) => {
          const url = `${origin}/feed.ics?tag=${slug(t.name)}`;
          return (
            <div className="feed-row" key={t.id}>
              <span className="swatch" style={{ background: t.color }} />
              <code className="code">{url}</code>
              <CopyButton text={url} />
            </div>
          );
        })}

        {admin && (
          <p className="banner" style={{ marginTop: 16 }}>
            Adding <span className="mono">?token=…</span> to a feed URL includes your drafts.
            Anyone holding that URL sees them, and calendar apps store it in plain text — so
            treat it as a password, not a link to paste in chat.
          </p>
        )}

        <p className="eyebrow" style={{ marginTop: 18, marginBottom: 6 }}>Apple Calendar</p>
        <p className="note" style={{ marginTop: 0 }}>
          File → New Calendar Subscription, paste the URL. It accepts localhost, so this works
          while you're testing.
        </p>

        <p className="eyebrow" style={{ marginTop: 14, marginBottom: 6 }}>Google Calendar and Outlook</p>
        <p className="note" style={{ marginTop: 0, marginBottom: 0 }}>
          Other calendars → From URL, or Add calendar → Subscribe from web. Both fetch from
          their own servers, so they need a public address — localhost won't reach them. Use
          the download button while testing, or expose the port with a tunnel.
        </p>
      </div>
      <div className="dlg-f">
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Scrim>
  );
}
