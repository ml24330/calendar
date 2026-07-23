import { startOfDay, addDays, key } from "./dates.js";

/** Every calendar day an event touches, as `YYYY-MM-DD` keys. */
export function expandDays(ev) {
  const out = [];
  let d = startOfDay(new Date(ev.start));
  const last = startOfDay(new Date(ev.end));
  let guard = 0;
  while (d <= last && guard++ < 400) {
    out.push(key(d));
    d = addDays(d, 1);
  }
  return out;
}

/**
 * Side-by-side placement for overlapping timed events.
 * Groups events into clusters of transitive overlap, then greedily assigns
 * each a column. Returns items annotated with `col` and total `cols`.
 */
export function layoutOverlaps(items) {
  const sorted = [...items].sort((a, b) => a.s - b.s || b.e - a.e);
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const ends = [];
    cluster.forEach((it) => {
      let c = ends.findIndex((end) => end <= it.s);
      if (c === -1) {
        ends.push(it.e);
        c = ends.length - 1;
      } else {
        ends[c] = it.e;
      }
      it.col = c;
    });
    cluster.forEach((it) => out.push({ ...it, cols: ends.length }));
    cluster = [];
    clusterEnd = -Infinity;
  };

  sorted.forEach((it) => {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  });
  flush();
  return out;
}

/** #RRGGBB → rgba() at the given alpha. */
export function tint(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Pick a legible tick/text colour for a given background.
 * Tag colours are user-editable, so a hardcoded white tick would vanish on a
 * pale yellow. Uses WCAG relative luminance rather than a naive brightness
 * average, which gets green badly wrong.
 */
export function readableOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "#17203A" : "#FFFFFF";
}
