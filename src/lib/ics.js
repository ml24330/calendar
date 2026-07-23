/* iCalendar (RFC 5545) output.
   This module is imported by BOTH the browser and the dev server, so the
   downloaded file and the subscribed feed can never drift apart.
   Nothing at module scope touches browser globals. */

import { pad, addDays } from "./dates.js";

export const icsEsc = (s = "") =>
  String(s)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

export const utcStamp = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
  `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

export const dateStamp = (d) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

/* RFC 5545 says lines wrap at 75 octets, continuations start with a space. */
export function fold(line) {
  if (line.length <= 74) return line;
  const parts = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length > 73) {
    parts.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  parts.push(" " + rest);
  return parts.join("\r\n");
}

export function describe(ev, tagName) {
  const bits = [];
  if (ev.details) bits.push(ev.details);
  if (ev.contactName || ev.contactEmail) {
    bits.push(`Point of contact: ${[ev.contactName, ev.contactEmail].filter(Boolean).join(" · ")}`);
  }
  if (ev.link) bits.push(ev.link);
  if (tagName) bits.push(`Tag: ${tagName}`);
  return bits.join("\n\n");
}

export function buildICS(events, tagsById, calName) {
  const now = new Date();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Org Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" + icsEsc(calName),
    "X-PUBLISHED-TTL:PT2H",
  ];

  events.forEach((ev) => {
    const s = new Date(ev.start);
    const e = new Date(ev.end);
    const tag = tagsById[ev.tagId];
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.id}@org-calendar`);
    lines.push(`DTSTAMP:${utcStamp(now)}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(s)}`);
      lines.push(`DTEND;VALUE=DATE:${dateStamp(addDays(e, 1))}`);
    } else {
      lines.push(`DTSTART:${utcStamp(s)}`);
      lines.push(`DTEND:${utcStamp(e)}`);
    }
    lines.push(`SUMMARY:${icsEsc(ev.title)}`);
    if (ev.location) lines.push(`LOCATION:${icsEsc(ev.location)}`);
    const desc = describe(ev, tag && tag.name);
    if (desc) lines.push(`DESCRIPTION:${icsEsc(desc)}`);
    if (tag) lines.push(`CATEGORIES:${icsEsc(tag.name)}`);
    if (ev.contactEmail) {
      lines.push(`ORGANIZER;CN=${icsEsc(ev.contactName || ev.contactEmail)}:mailto:${ev.contactEmail}`);
    }
    if (ev.link) lines.push(`URL:${icsEsc(ev.link)}`);
    lines.push(`LAST-MODIFIED:${utcStamp(new Date(ev.updatedAt || ev.start))}`);
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/* Browser-only. The globals are referenced inside the body, never at import
   time, so Node can safely import this module. */
export function downloadICS(events, tagsById, calName, filename) {
  const blob = new Blob([buildICS(events, tagsById, calName)], {
    type: "text/calendar;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function googleUrl(ev, tagName) {
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const dates = ev.allDay
    ? `${dateStamp(s)}/${dateStamp(addDays(e, 1))}`
    : `${utcStamp(s)}/${utcStamp(e)}`;
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: ev.title || "Event",
    dates,
    details: describe(ev, tagName),
    location: ev.location || "",
  });
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}
