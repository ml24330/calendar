/* PDF export, drawn with pdfkit.

   The document has two parts: a grid page laid out like the view you were
   looking at, then an agenda listing every event in the period with the
   details a grid cell has no room for. Drafts appear only when the request
   is authenticated, and are marked as drafts wherever they show up. */

import PDFDocument from "pdfkit";
import {
  MONTHS, MON_ABBR, DAY_ABBR, DAY_LETTER, daysInMonth, startOfMonth,
  startOfWeek, startOfDay, addDays, key, sameDay, fmtTime, fmtRange,
  fmtLongDate, periodRange, orderedDays,
} from "../src/lib/dates.js";
import { expandDays } from "../src/lib/layout.js";
import { toZoned, ZONE_LABEL } from "../src/lib/tz.js";

const INK = "#17203A";
const MUTED = "#737C99";
const RULE = "#D5D9E5";
const RULE_SOFT = "#E6E9F1";
const DRAFT = "#8A5A00";

/* pdfkit's built-in Helvetica needs no font files shipped. To match the
   screen exactly, drop IBM Plex .ttf files in server/fonts/ and register
   them with doc.registerFont — every doc.font() call below goes through
   these two constants. */
const SANS = "Helvetica";
const BOLD = "Helvetica-Bold";

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(c + (255 - c) * (1 - a))
  );
};
const tintHex = (hex, a) => "#" + rgba(hex, a).map((c) => c.toString(16).padStart(2, "0")).join("");

function ellipsis(doc, text, width) {
  if (doc.widthOfString(text) <= width) return text;
  let s = text;
  while (s.length > 1 && doc.widthOfString(s + "…") > width) s = s.slice(0, -1);
  return s + "…";
}

/* ------------------------------------------------------------------ chrome */

function header(doc, { orgName, label, view, tags, includeDrafts, filtered }) {
  const { left, right } = { left: doc.page.margins.left, right: doc.page.margins.right };
  const w = doc.page.width - left - right;

  doc.font(BOLD).fontSize(9).fillColor(MUTED)
    .text(orgName.toUpperCase(), left, doc.page.margins.top, { characterSpacing: 1.2 });

  doc.font(BOLD).fontSize(20).fillColor(INK).text(label, left, doc.y + 2);

  const meta = [
    view[0].toUpperCase() + view.slice(1) + " view",
    filtered ? "filtered" : "all tags",
    includeDrafts ? "includes drafts" : "published only",
    "times in " + ZONE_LABEL,
    "generated " + new Date().toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric",
    }),
  ].join("   ·   ");

  doc.font(SANS).fontSize(8).fillColor(MUTED).text(meta, left, doc.y + 3);

  // Tag legend
  let x = left;
  const y = doc.y + 6;
  doc.fontSize(8);
  for (const t of tags) {
    const label2 = t.name;
    const wSw = 7;
    doc.rect(x, y + 1, wSw, wSw).fill(t.color);
    doc.fillColor(INK).text(label2, x + wSw + 4, y, { lineBreak: false });
    x += wSw + 6 + doc.widthOfString(label2) + 12;
  }

  const ruleY = y + 16;
  doc.moveTo(left, ruleY).lineTo(left + w, ruleY).lineWidth(1).stroke(INK);
  doc.y = ruleY + 12;
  return doc.y;
}

function footer(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // pdfkit adds a fresh page whenever text lands below the bottom margin,
    // so a footer drawn in the margin silently doubles your page count.
    // Drop the margin for the duration of the write.
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(SANS).fontSize(7.5).fillColor(MUTED).text(
      `Page ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      doc.page.height - keep + 10,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: "right", lineBreak: false }
    );
    doc.page.margins.bottom = keep;
  }
}

/* ------------------------------------------------------------- grid: month */

function monthGrid(doc, { date, byDay, tagsById, top }) {
  const left = doc.page.margins.left;
  const w = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom - 8;
  const first = startOfWeek(startOfMonth(date));
  const colW = w / 7;
  const headH = 16;
  const rowH = (bottom - top - headH) / 6;
  const month = date.getMonth();

  doc.font(BOLD).fontSize(7.5).fillColor(MUTED);
  orderedDays.forEach((d, i) => {
    doc.text(DAY_ABBR[d].toUpperCase(), left + i * colW + 4, top + 4, {
      width: colW - 8, characterSpacing: 0.8,
    });
  });

  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      const d = addDays(first, r * 7 + c);
      const x = left + c * colW;
      const y = top + headH + r * rowH;
      const outside = d.getMonth() !== month;

      doc.rect(x, y, colW, rowH).lineWidth(0.5).strokeColor(RULE_SOFT).stroke();
      if (outside) doc.rect(x + 0.5, y + 0.5, colW - 1, rowH - 1).fill("#FAFBFD");

      doc.font(BOLD).fontSize(8).fillColor(outside ? "#B4BACD" : INK)
        .text(String(d.getDate()), x + 4, y + 4, { width: colW - 8, lineBreak: false });

      const list = byDay.get(key(d)) || [];
      let ey = y + 15;
      const lineH = 9.5;
      for (const ev of list) {
        if (ey + lineH > y + rowH - 2) {
          doc.font(SANS).fontSize(6.5).fillColor(MUTED)
            .text(`+${list.length - list.indexOf(ev)} more`, x + 4, ey, { width: colW - 8, lineBreak: false });
          break;
        }
        const color = (tagsById[ev.tagId] || {}).color || "#9AA2BC";
        doc.rect(x + 4, ey, 2, lineH - 2).fill(color);
        const prefix = ev.published ? "" : "◦ ";
        const label = (ev.allDay ? "" : fmtTime(toZoned(ev.start)) + " ") + prefix + ev.title;
        doc.font(SANS).fontSize(6.5).fillColor(ev.published ? INK : DRAFT);
        doc.text(ellipsis(doc, label, colW - 14), x + 9, ey + 0.5, { width: colW - 12, lineBreak: false });
        ey += lineH;
      }
    }
  }
}

/* -------------------------------------------------------------- grid: week */

function weekGrid(doc, { date, byDay, tagsById, top }) {
  const left = doc.page.margins.left;
  const w = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom - 8;
  const start = startOfWeek(date);
  const colW = w / 7;

  for (let c = 0; c < 7; c++) {
    const d = addDays(start, c);
    const x = left + c * colW;
    doc.rect(x, top, colW, bottom - top).lineWidth(0.5).strokeColor(RULE_SOFT).stroke();
    doc.rect(x, top, colW, 20).fill("#F5F6FA");
    doc.font(BOLD).fontSize(8).fillColor(INK)
      .text(`${DAY_ABBR[d.getDay()]} ${d.getDate()}`, x + 5, top + 6, { width: colW - 10, lineBreak: false });

    let y = top + 26;
    for (const ev of byDay.get(key(d)) || []) {
      if (y > bottom - 24) break;
      const color = (tagsById[ev.tagId] || {}).color || "#9AA2BC";
      doc.rect(x + 4, y, 2.5, 20).fill(color);
      doc.font(SANS).fontSize(6.5).fillColor(MUTED)
        .text(ev.allDay ? "All day" : fmtTime(toZoned(ev.start)), x + 10, y, { width: colW - 14, lineBreak: false });
      doc.font(BOLD).fontSize(7).fillColor(ev.published ? INK : DRAFT);
      const title = (ev.published ? "" : "DRAFT · ") + ev.title;
      doc.text(ellipsis(doc, title, colW - 16), x + 10, y + 8, { width: colW - 14, lineBreak: false });
      if (ev.location) {
        doc.font(SANS).fontSize(6).fillColor(MUTED)
          .text(ellipsis(doc, ev.location, colW - 16), x + 10, y + 16, { width: colW - 14, lineBreak: false });
      }
      y += 26;
    }
  }
}

/* -------------------------------------------------------------- grid: year */

function yearPlanner(doc, { date, byDay, tagsById, top }) {
  const left = doc.page.margins.left;
  const w = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom - 8;
  const year = date.getFullYear();
  const numW = 16;
  const colW = (w - numW) / 12;
  const headH = 14;
  const rowH = (bottom - top - headH) / 31;

  doc.font(BOLD).fontSize(7).fillColor(INK);
  MON_ABBR.forEach((m, i) => {
    doc.text(m.toUpperCase(), left + numW + i * colW, top + 4, {
      width: colW, align: "center", characterSpacing: 0.6,
    });
  });
  doc.moveTo(left, top + headH).lineTo(left + w, top + headH).lineWidth(0.7).stroke(RULE);

  for (let day = 1; day <= 31; day++) {
    const y = top + headH + (day - 1) * rowH;
    doc.font(SANS).fontSize(5.5).fillColor(MUTED)
      .text(String(day), left, y + rowH / 2 - 3, { width: numW - 3, align: "right", lineBreak: false });

    for (let m = 0; m < 12; m++) {
      const x = left + numW + m * colW;
      if (day > daysInMonth(year, m)) {
        doc.rect(x, y, colW, rowH).fill("#F2F3F7");
        continue;
      }
      const d = new Date(year, m, day);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      if (weekend) doc.rect(x, y, colW, rowH).fill("#F4F6FA");
      doc.rect(x, y, colW, rowH).lineWidth(0.3).strokeColor(RULE_SOFT).stroke();

      doc.font(SANS).fontSize(4.5).fillColor("#AEB4C8")
        .text(DAY_LETTER[d.getDay()], x + 1.5, y + rowH / 2 - 2.5, { lineBreak: false });

      const list = byDay.get(key(d)) || [];
      let bx = x + 7;
      for (const ev of list.slice(0, 5)) {
        const color = (tagsById[ev.tagId] || {}).color || "#9AA2BC";
        if (ev.published) doc.rect(bx, y + rowH / 2 - 2, 3.4, 4).fill(color);
        else doc.rect(bx, y + rowH / 2 - 2, 3.4, 4).lineWidth(0.5).strokeColor(color).stroke();
        bx += 4.6;
        if (bx > x + colW - 4) break;
      }
    }
  }
}

/* ----------------------------------------------------------------- agenda */

function agenda(doc, { events, tagsById, includeDrafts }) {
  doc.addPage();
  const left = doc.page.margins.left;
  const w = doc.page.width - left - doc.page.margins.right;

  doc.font(BOLD).fontSize(11).fillColor(INK).text("Events in this period", left, doc.page.margins.top);
  doc.moveTo(left, doc.y + 4).lineTo(left + w, doc.y + 4).lineWidth(1).stroke(INK);
  doc.y += 14;

  if (!events.length) {
    doc.font(SANS).fontSize(9).fillColor(MUTED)
      .text("Nothing scheduled in this period with the filters you had applied.", left, doc.y);
    return;
  }

  let lastDay = null;
  for (const ev of events) {
    const start = toZoned(ev.start);

    // Keep a whole entry on one page rather than splitting it across the break.
    if (doc.y > doc.page.height - doc.page.margins.bottom - 74) {
      doc.addPage();
      lastDay = null;
    }

    if (!lastDay || !sameDay(lastDay, start)) {
      doc.y += lastDay ? 10 : 0;
      doc.font(BOLD).fontSize(8.5).fillColor(MUTED)
        .text(fmtLongDate(start).toUpperCase(), left, doc.y, { characterSpacing: 0.8 });
      doc.moveTo(left, doc.y + 2).lineTo(left + w, doc.y + 2).lineWidth(0.5).stroke(RULE);
      doc.y += 8;
      lastDay = start;
    }

    const tag = tagsById[ev.tagId];
    const color = (tag && tag.color) || "#9AA2BC";
    const y0 = doc.y;

    doc.rect(left, y0 + 1, 3, 30).fill(ev.published ? color : tintHex(color, 0.4));

    doc.font(BOLD).fontSize(9.5).fillColor(ev.published ? INK : DRAFT);
    doc.text((ev.published ? "" : "DRAFT — ") + ev.title, left + 10, y0, { width: w - 130 });

    doc.font(SANS).fontSize(7.5).fillColor(MUTED);
    doc.text(fmtRange(ev) + (tag ? `   ·   ${tag.name}` : ""), left + 10, doc.y + 1, { width: w - 130 });

    const facts = [];
    if (ev.location) facts.push(ev.location);
    if (ev.contactName || ev.contactEmail) {
      facts.push([ev.contactName, ev.contactEmail].filter(Boolean).join(" · "));
    }
    if (ev.link) facts.push(ev.link);
    if (facts.length) {
      doc.font(SANS).fontSize(7.5).fillColor(INK).text(facts.join("   ·   "), left + 10, doc.y + 1, { width: w - 20 });
    }
    if (ev.details) {
      doc.font(SANS).fontSize(7.5).fillColor("#4A5372")
        .text(ev.details, left + 10, doc.y + 2, { width: w - 30 });
    }
    doc.y += 9;
  }

  if (includeDrafts) {
    doc.y += 8;
    doc.font(SANS).fontSize(7).fillColor(DRAFT)
      .text("Entries marked DRAFT are unpublished and are not visible to readers of the calendar.", left, doc.y, { width: w });
  }
}

/* ------------------------------------------------------------------ entry */

export function renderCalendarPdf(res, opts) {
  const { view, date, events, tags, orgName, includeDrafts, filtered } = opts;
  const landscape = view !== "day";
  const doc = new PDFDocument({
    size: "A4",
    layout: landscape ? "landscape" : "portrait",
    margins: { top: 34, bottom: 34, left: 36, right: 36 },
    bufferPages: true,
    info: { Title: `${orgName} — ${periodRange(view, date).label}`, Author: orgName },
  });

  doc.pipe(res);

  const tagsById = Object.fromEntries(tags.map((t) => [t.id, t]));
  const byDay = new Map();
  for (const ev of events) {
    for (const k of expandDays(ev)) {
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(ev);
    }
  }
  for (const list of byDay.values()) {
    list.sort((a, b) =>
      a.allDay === b.allDay ? new Date(a.start) - new Date(b.start) : (a.allDay ? -1 : 1)
    );
  }

  const top = header(doc, {
    orgName,
    label: periodRange(view, date).label,
    view, tags, includeDrafts, filtered,
  });

  if (view === "year") yearPlanner(doc, { date, byDay, tagsById, top });
  else if (view === "month") monthGrid(doc, { date, byDay, tagsById, top });
  else if (view === "week") weekGrid(doc, { date, byDay, tagsById, top });

  agenda(doc, { events, tagsById, includeDrafts });
  footer(doc);
  doc.end();
}
