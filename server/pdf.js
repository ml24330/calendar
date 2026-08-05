/* PDF export, drawn with pdfkit.

   The document has two parts: a grid page laid out like the view you were
   looking at, then an agenda listing every event in the period with the
   details a grid cell has no room for. Drafts appear only when the request
   is authenticated, and are marked as drafts wherever they show up. */

import PDFDocument from "pdfkit";
import {
  MONTHS, MON_ABBR, DAY_ABBR, DAY_LETTER, daysInMonth, startOfMonth,
  startOfWeek, startOfDay, addDays, key, sameDay, fmtTime, fmtRange,
  fmtLongDate, periodRange, orderedDays, WEEK_START,
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

/**
 * Trim text until it wraps into at most `maxLines`, adding an ellipsis.
 *
 * Bounding the height is what keeps one long title from resizing a whole
 * week: measurement and drawing both use the clamped string, so a cell's
 * height can never exceed what was reserved for it. Binary search rather than
 * shrinking a character at a time — a pathological title can be thousands of
 * characters and each measurement costs real work.
 */
function clampToLines(doc, text, width, maxLines) {
  // Measure an actual rendered line rather than trusting currentLineHeight():
  // pdfkit adds line gap on top of it, so a real line is taller than that
  // figure and a cap built from it silently allows one line fewer.
  const max = doc.heightOfString("Xg", { width }) * maxLines + 0.5;
  if (doc.heightOfString(text, { width }) <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.heightOfString(text.slice(0, mid) + "\u2026", { width }) <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "\u2026";
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
  const month = date.getMonth();

 /* Hard caps, so a day full of very long titles can only ever claim a bounded
     amount of the page. Without them a single day could shrink every other
     row to nothing — and did. */
  const MAX_PER_DAY = 5;
  const MAX_LINES = 2;

  const FS = 6.5;              // event label size
  const LINE = 8;              // one wrapped line of a label
  const GAP = 1.5;             // between events
  const TOP_PAD = 15;          // below the date number
  const BOT_PAD = 3;
  const textW = colW - 12;     // usable width beside the colour bar

  // Only as many weeks as the month occupies, matching the on-screen grid.
  const lead = (startOfMonth(date).getDay() - WEEK_START + 7) % 7;
  const weeks = Math.ceil((lead + daysInMonth(date.getFullYear(), month)) / 7);

  const rawLabel = (ev) =>
    (ev.allDay ? "" : fmtTime(toZoned(ev.start)) + " ") + (ev.published ? "" : "\u25e6 ") + ev.title;
  // Always measured and drawn from the same clamped string.
  const label = (ev) => clampToLines(doc, rawLabel(ev), textW, MAX_LINES);

  /* Pass 1: measure. heightOfString does the same wrapping the renderer will,
     so the measurement and the drawing cannot disagree. */
  doc.font(SANS).fontSize(FS);
  const cellNeeds = [];
  for (let r = 0; r < weeks; r++) {
    for (let c = 0; c < 7; c++) {
      const list = byDay.get(key(addDays(first, r * 7 + c))) || [];
      const shown = list.slice(0, MAX_PER_DAY);
      let h = TOP_PAD + BOT_PAD;
      for (const ev of shown) h += doc.heightOfString(label(ev), { width: textW }) + GAP;
      if (list.length > shown.length) h += LINE;   // room for the "+n more" line
      cellNeeds[r * 7 + c] = h;
    }
  }

  /* Pass 2: rows keep the plain uniform height unless their content genuinely
     needs more.
   *
   * The obvious approach — size each row to its content, then share the
   * leftover page space equally — inflates every row well past what it needs,
   * so a week with four events ends up half empty. Instead the uniform height
   * is the baseline: a row only grows when its content won't fit, and the
   * space for that growth is taken from the rows that had room to spare.
   */
  const avail = bottom - top - headH;
  const rowNeeds = [];
  for (let r = 0; r < weeks; r++) {
    rowNeeds[r] = Math.max(...Array.from({ length: 7 }, (_, c) => cellNeeds[r * 7 + c]));
  }

  const baseH = avail / weeks;
  const MIN_ROW = 46;                       // still readable once shrunk
  const rowH = rowNeeds.map((n) => Math.max(baseH, n));

  // Growing some rows has to be paid for by the others, down to MIN_ROW.
  let over = rowH.reduce((a, b) => a + b, 0) - avail;
  if (over > 0) {
    const donors = rowH
      .map((h, i) => ({ i, spare: Math.max(0, h - Math.max(MIN_ROW, rowNeeds[i])) }))
      .filter((d) => d.spare > 0);
    const pool = donors.reduce((a, d) => a + d.spare, 0);
    if (pool > 0) {
      const take = Math.min(1, over / pool);
      for (const d of donors) rowH[d.i] -= d.spare * take;
      over -= pool * take;
    }
    // Still over: every row is genuinely full, so scale them all and let the
    // per-cell "+n more" absorb what no longer fits.
    if (over > 0.5) {
      const total = rowH.reduce((a, b) => a + b, 0);
      const scale = avail / total;
      for (let i = 0; i < rowH.length; i++) rowH[i] *= scale;
    }
  }

  const rowTop = [];
  rowH.reduce((acc, h, i) => { rowTop[i] = acc; return acc + h; }, top + headH);

  doc.font(BOLD).fontSize(7.5).fillColor(MUTED);
  orderedDays.forEach((d, i) => {
    doc.text(DAY_ABBR[d].toUpperCase(), left + i * colW + 4, top + 4, {
      width: colW - 8, characterSpacing: 0.8,
    });
  });

  for (let r = 0; r < weeks; r++) {
    for (let c = 0; c < 7; c++) {
      const d = addDays(first, r * 7 + c);
      const x = left + c * colW;
      const y = rowTop[r];
      const h = rowH[r];
      const outside = d.getMonth() !== month;

      doc.rect(x, y, colW, h).lineWidth(0.5).strokeColor(RULE_SOFT).stroke();
      if (outside) doc.rect(x + 0.5, y + 0.5, colW - 1, h - 1).fill("#FAFBFD");

      doc.font(BOLD).fontSize(8).fillColor(outside ? "#B4BACD" : INK)
        .text(String(d.getDate()), x + 4, y + 4, { width: colW - 8, lineBreak: false });

      const list = byDay.get(key(d)) || [];
      const shown = list.slice(0, MAX_PER_DAY);
      let ey = y + TOP_PAD;
      for (let i = 0; i < shown.length; i++) {
        const ev = shown[i];
        doc.font(SANS).fontSize(FS);
        const th = doc.heightOfString(label(ev), { width: textW });

        // Not enough room for this one: say how many are left rather than
        // clipping a title mid-word.
        if (ey + th > y + h - BOT_PAD) {
          doc.font(SANS).fontSize(6).fillColor(MUTED)
            .text(`+${list.length - i} more`, x + 4, ey, { width: colW - 8, lineBreak: false });
          ey = Infinity;   // marks that the tail note is already drawn
          break;
        }

        const color = (tagsById[ev.tagId] || {}).color || "#9AA2BC";
        doc.rect(x + 4, ey, 2, th - 1).fill(color);
        doc.font(SANS).fontSize(FS).fillColor(ev.published ? INK : DRAFT);
        doc.text(label(ev), x + 9, ey, { width: textW });
        ey += th + GAP;
      }

      // Events beyond the per-day cap still get counted, so nothing vanishes
      // silently the way it used to.
      if (ey !== Infinity && list.length > shown.length) {
        doc.font(SANS).fontSize(6).fillColor(MUTED)
          .text(`+${list.length - shown.length} more`, x + 4, ey, { width: colW - 8, lineBreak: false });
      }
    }
  }
}

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
