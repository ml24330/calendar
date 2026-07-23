/* Pure date helpers. Safe to import from Node (no browser globals). */

export const WEEK_START = 0; // 0 = Sunday, 1 = Monday

export const pad = (n) => String(n).padStart(2, "0");

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const endOfDay = (d) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
export const startOfWeek = (d) =>
  addDays(startOfDay(d), -(((d.getDay() - WEEK_START) + 7) % 7));

export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

export const isToday = (d) => sameDay(d, new Date());
export const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export const MON_ABBR = MONTHS.map((m) => m.slice(0, 3));
export const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_LETTER = ["S", "M", "T", "W", "T", "F", "S"];
export const orderedDays = Array.from({ length: 7 }, (_, i) => (i + WEEK_START) % 7);

export function fmtTime(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m === 0 ? `${h}${ap}` : `${h}:${pad(m)}${ap}`;
}

export function fmtRange(ev) {
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  if (ev.allDay) {
    return sameDay(s, e) ? "All day" : `All day · through ${MON_ABBR[e.getMonth()]} ${e.getDate()}`;
  }
  if (sameDay(s, e)) return `${fmtTime(s)} – ${fmtTime(e)}`;
  return `${MON_ABBR[s.getMonth()]} ${s.getDate()}, ${fmtTime(s)} → ${MON_ABBR[e.getMonth()]} ${e.getDate()}, ${fmtTime(e)}`;
}

export function fmtLongDate(d) {
  return `${DAY_ABBR[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/* <input type="datetime-local"> and <input type="date"> value formats */
export const toInput = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const toDateInput = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The inclusive date span a view covers. Shared by the client (to label the
 * export) and the server (to select rows for the PDF), so the button and the
 * document can't disagree about what "current view" means.
 * @returns {{from: Date, to: Date, label: string}}
 */
export function periodRange(view, date) {
  const d = new Date(date);
  if (view === "year") {
    return {
      from: new Date(d.getFullYear(), 0, 1),
      to: new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999),
      label: String(d.getFullYear()),
    };
  }
  if (view === "month") {
    return {
      from: startOfMonth(d),
      to: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999),
      label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    };
  }
  if (view === "week") {
    const from = startOfWeek(d);
    const to = endOfDay(addDays(from, 6));
    const span = from.getMonth() === to.getMonth()
      ? `${MON_ABBR[from.getMonth()]} ${from.getDate()}–${to.getDate()}`
      : `${MON_ABBR[from.getMonth()]} ${from.getDate()} – ${MON_ABBR[to.getMonth()]} ${to.getDate()}`;
    return { from, to, label: `${span}, ${to.getFullYear()}` };
  }
  return { from: startOfDay(d), to: endOfDay(d), label: fmtLongDate(d) };
}
