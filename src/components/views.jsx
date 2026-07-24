import { useEffect, useRef } from "react";
import {
  MON_ABBR, DAY_ABBR, DAY_LETTER, orderedDays, daysInMonth, startOfMonth,
  startOfWeek, startOfDay, endOfDay, addDays, key, isToday, fmtTime, fmtRange,
  fmtLongDate, WEEK_START,
} from "../lib/dates.js";
import { layoutOverlaps, tint } from "../lib/layout.js";
import { toZoned, zonedNow } from "../lib/tz.js";

export const HOUR_H = 52; // px per hour

/* ---------------------------------------------------------- year planner --
   Laid out like a printed wall planner: months across, days 1–31 down.
   Better than twelve mini-months for seeing how a year clusters.          */

export function YearPlanner({ year, byDay, tagsById, tags, hidden, onPickDay }) {
  const cells = [];

  for (let day = 1; day <= 31; day++) {
    cells.push(<div key={`n${day}`} className="yp-rn" style={{ gridRow: day + 1 }}>{day}</div>);

    for (let m = 0; m < 12; m++) {
      if (day > daysInMonth(year, m)) {
        cells.push(<div key={`v${m}-${day}`} className="yp-c void" style={{ gridRow: day + 1 }} />);
        continue;
      }
      const d = new Date(year, m, day);
      const list = byDay.get(key(d)) || [];
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      const bars = list.slice(0, 4);

      cells.push(
        <button
          key={`c${m}-${day}`}
          className={"yp-c" + (weekend ? " wknd" : "") + (isToday(d) ? " today" : "")}
          style={{ gridRow: day + 1 }}
          onClick={() => onPickDay(d)}
          title={list.length
            ? `${fmtLongDate(d)} — ${list.map((e) => e.title).join(", ")}`
            : fmtLongDate(d)}
        >
          <span className="wd">{DAY_LETTER[d.getDay()]}</span>
          <span className="yp-bars">
            {bars.map((ev, i) => (
              <span
                key={i}
                className={"yp-bar" + (ev.published ? "" : " draft")}
                style={{
                  width: 7,
                  ...(ev.published
                    ? { background: (tagsById[ev.tagId] || {}).color || "#9AA2BC" }
                    : { borderColor: (tagsById[ev.tagId] || {}).color || "#9AA2BC" }),
                }}
              />
            ))}
            {list.length > 4 && <span className="wd">+</span>}
          </span>
        </button>
      );
    }
  }

  return (
    <>
      <div className="yp-scroll">
        <div className="yp" style={{ gridTemplateColumns: "36px repeat(12, minmax(58px, 1fr))" }}>
          <div className="yp-corner" style={{ gridRow: 1, gridColumn: 1 }} />
          {MON_ABBR.map((m, i) => (
            <div key={m} className="yp-mh" style={{ gridRow: 1, gridColumn: i + 2 }}>{m}</div>
          ))}
          {cells}
        </div>
      </div>
      <div className="yp-legend">
        {tags.filter((t) => !hidden.has(t.id)).map((t) => (
          <span key={t.id} className="yp-leg">
            <span className="swatch" style={{ background: t.color }} />{t.name}
          </span>
        ))}
        {zonedNow().getFullYear() === year && (
          <span className="yp-leg" style={{ marginLeft: "auto", color: "var(--signal)" }}>
            Red outline marks today
          </span>
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ month grid */

export function MonthGrid({ cursor, byDay, tagsById, onOpen, onPickDay }) {
  const monthStart = startOfMonth(cursor);
  const first = startOfWeek(monthStart);
  const month = cursor.getMonth();

  /* Only as many weeks as the month actually occupies. A fixed six rows means
     a February beginning on the first day of the week shows a whole trailing
     week of March for nothing. Counting from weekdays rather than subtracting
     timestamps keeps this right across a daylight-saving change. */
  const lead = (monthStart.getDay() - WEEK_START + 7) % 7;
  const weeks = Math.ceil((lead + daysInMonth(cursor.getFullYear(), month)) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDays(first, i));

  return (
    <>
      <div className="m-head">
        {orderedDays.map((d) => (
          <div key={d}><span className="eyebrow">{DAY_ABBR[d]}</span></div>
        ))}
      </div>
      <div className="m-body">
        {cells.map((d) => {
          const list = byDay.get(key(d)) || [];
          const shown = list.slice(0, 3);
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          return (
            <div
              key={key(d)}
              className={"m-cell" + (d.getMonth() !== month ? " dim" : "") + (weekend ? " wknd" : "")}
            >
              <button className={"m-num" + (isToday(d) ? " today" : "")} onClick={() => onPickDay(d)}>
                {d.getDate()}
              </button>
              {shown.map((ev) => {
                const c = (tagsById[ev.tagId] || {}).color || "#9AA2BC";
                return (
                  <button
                    key={ev.id}
                    className={"chip" + (ev.published ? "" : " draft")}
                    style={{ borderLeftColor: c, background: tint(c, ev.published ? 0.07 : 0.03) }}
                    onClick={() => onOpen(ev)}
                    title={ev.published ? ev.title : `Draft — ${ev.title}`}
                  >
                    {!ev.allDay && <span className="h">{fmtTime(toZoned(ev.start))}</span>}
                    <span className="t">{ev.title}</span>
                  </button>
                );
              })}
              {list.length > 3 && (
                <button className="more" onClick={() => onPickDay(d)}>
                  +{list.length - 3} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------ week / day grid  */

export function TimeGrid({ days, byDay, tagsById, onOpen, now, onPickDay }) {
  const scroller = useRef(null);
  const cols = `54px repeat(${days.length}, minmax(0,1fr))`;

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7.5 * HOUR_H;
  }, [days.length]);

  const hasAllDay = days.some((d) => (byDay.get(key(d)) || []).some((e) => e.allDay));
  const anyTimed = days.some((d) => (byDay.get(key(d)) || []).some((e) => !e.allDay));

  return (
    <div className="tg-wrap">
      <div className="tg-top" style={{ gridTemplateColumns: cols }}>
        <div className="gut" />
        {days.map((d) => (
          <button
            key={key(d)}
            className={"tg-day" + (isToday(d) ? " now" : "")}
            onClick={() => onPickDay(d)}
          >
            <div className="eyebrow">{DAY_ABBR[d.getDay()]}</div>
            <div className="d">{d.getDate()}</div>
          </button>
        ))}
      </div>

      {hasAllDay && (
        <div className="tg-allday" style={{ gridTemplateColumns: cols }}>
          <div className="gut"><span className="eyebrow">All day</span></div>
          {days.map((d) => (
            <div key={key(d)} className="col">
              {(byDay.get(key(d)) || []).filter((e) => e.allDay).map((ev) => {
                const c = (tagsById[ev.tagId] || {}).color || "#9AA2BC";
                return (
                  <button
                    key={ev.id}
                    className={"chip" + (ev.published ? "" : " draft")}
                    style={{ borderLeftColor: c, background: tint(c, ev.published ? 0.12 : 0.04) }}
                    onClick={() => onOpen(ev)}
                  >
                    <span className="t">{ev.title}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {!anyTimed && !hasAllDay && (
        <div className="empty">
          <b>Nothing scheduled</b>
          Nothing on {days.length === 1 ? "this day" : "this week"} matches your filters.
        </div>
      )}

      <div className="tg-scroll" ref={scroller}>
        <div className="tg-grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_H }}>
          <div className="tg-gutter">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span key={h} className="tg-hr" style={{ top: h * HOUR_H }}>
                {h % 12 || 12}{h < 12 ? "am" : "pm"}
              </span>
            ))}
          </div>

          {days.map((d) => {
            const dayStart = startOfDay(d).getTime();
            const dayEnd = endOfDay(d).getTime();
            const items = (byDay.get(key(d)) || [])
              .filter((e) => !e.allDay)
              .map((ev) => {
                const s = Math.max(toZoned(ev.start).getTime(), dayStart);
                const e = Math.min(toZoned(ev.end).getTime(), dayEnd);
                return { ev, s, e: Math.max(e, s + 15 * 60000) };
              });
            const placed = layoutOverlaps(items);
            const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H;

            return (
              <div key={key(d)} className="tg-col">
                {Array.from({ length: 48 }, (_, i) => (
                  <div
                    key={i}
                    className={"tg-line" + (i % 2 ? " half" : "")}
                    style={{ top: (i / 2) * HOUR_H }}
                  />
                ))}
                {isToday(d) && <div className="tg-now" style={{ top: nowTop }} />}
                {placed.map(({ ev, s, e, col, cols: n }) => {
                  const c = (tagsById[ev.tagId] || {}).color || "#9AA2BC";
                  const top = ((s - dayStart) / 3600000) * HOUR_H;
                  const h = Math.max(((e - s) / 3600000) * HOUR_H, 20);
                  const w = 100 / n;
                  return (
                    <button
                      key={ev.id}
                      className={"ev" + (ev.published ? "" : " draft")}
                      style={{
                        top,
                        height: h - 2,
                        left: `calc(${col * w}% + 2px)`,
                        width: `calc(${w}% - 4px)`,
                        background: tint(c, ev.published ? 0.13 : 0.05),
                        borderLeftColor: c,
                      }}
                      onClick={() => onOpen(ev)}
                    >
                      <div className="t">{ev.published ? ev.title : `Draft · ${ev.title}`}</div>
                      {h > 34 && <div className="s">{fmtRange(ev)}</div>}
                      {h > 58 && ev.location && <div className="s">{ev.location}</div>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
