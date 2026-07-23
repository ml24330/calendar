import { toZoned, fromZoned, zoneAbbr, zonedParts, CALENDAR_TZ } from "../src/lib/tz.js";

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ` +
                   `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
let fail = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(52)} ${got}${ok ? "" : "   want " + want}`);
};

console.log(`process TZ = ${process.env.TZ || "(unset)"}   calendar TZ = ${CALENDAR_TZ}\n`);

// 19:00Z on 23 Jul 2026 is noon PDT
check("19:00Z Jul 23 renders as", fmt(toZoned(new Date("2026-07-23T19:00:00Z"))), "2026-07-23 12:00");
// 20:00Z on 15 Jan 2026 is noon PST
check("20:00Z Jan 15 renders as", fmt(toZoned(new Date("2026-01-15T20:00:00Z"))), "2026-01-15 12:00");
check("abbr in July", zoneAbbr(new Date("2026-07-23T19:00:00Z")), "PDT");
check("abbr in January", zoneAbbr(new Date("2026-01-15T20:00:00Z")), "PST");

// Day boundary: 06:59Z is still the previous day in PT
check("06:00Z Jul 24 is still Jul 23 in PT", fmt(toZoned(new Date("2026-07-24T06:00:00Z"))), "2026-07-23 23:00");
check("07:00Z Jul 24 rolls over to Jul 24", fmt(toZoned(new Date("2026-07-24T07:00:00Z"))), "2026-07-24 00:00");

// DST: spring forward 8 Mar 2026 2am -> 3am; fall back 1 Nov 2026
check("09:59Z Mar 8 (just before spring forward)", fmt(toZoned(new Date("2026-03-08T09:59:00Z"))), "2026-03-08 01:59");
check("10:00Z Mar 8 (2am becomes 3am)",           fmt(toZoned(new Date("2026-03-08T10:00:00Z"))), "2026-03-08 03:00");
check("08:00Z Nov 1 (first 1am, PDT)",            fmt(toZoned(new Date("2026-11-01T08:00:00Z"))), "2026-11-01 01:00");
check("09:00Z Nov 1 (second 1am, PST)",           fmt(toZoned(new Date("2026-11-01T09:00:00Z"))), "2026-11-01 01:00");

// Round trip across a full year, every 37 minutes.
//
// Two windows can't round-trip, and both are properties of civil time rather
// than bugs:
//   1. The PT fall-back hour (09:00-10:00Z on 1 Nov 2026). Two instants share
//      one wall time; only one can come back.
//   2. The *machine's* own spring-forward gap, if it has one. A local time
//      that doesn't exist on this host can't be held in a Date, so it gets
//      normalised an hour forward.
// Everything else must be exact, and no mismatch may ever be anything other
// than exactly an hour — a wrong day would mean the logic is broken.
const PT_AMBIGUOUS = [Date.parse("2026-11-01T09:00:00Z"), Date.parse("2026-11-01T10:00:00Z")];
const machineGap = (instant) => {
  // A local hour that vanishes on this host can't be stored in a Date, so
  // constructing it hands back a different hour. Probe with the hour we
  // *intended*, not the one we got — the corrupted value looks fine.
  const w = zonedParts(instant);
  const probe = new Date(w.year, w.month, w.day, w.hour, w.minute, w.second);
  return probe.getHours() !== w.hour;
};

let n = 0;
const bad = [];
for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 37 * 60000) {
  const inst = new Date(t);
  const back = fromZoned(toZoned(inst));
  if (back.getTime() !== inst.getTime()) bad.push({ inst, back, delta: (back - inst) / 60000 });
  n++;
}
const unexplained = bad.filter(({ inst }) => {
  const inAmbiguous = inst.getTime() >= PT_AMBIGUOUS[0] && inst.getTime() < PT_AMBIGUOUS[1];
  return !inAmbiguous && !machineGap(inst);
});
check(`round trip over ${n} instants, unexplained mismatches`, String(unexplained.length), "0");
check("every mismatch is exactly one hour, never a day",
  bad.every((b) => Math.abs(b.delta) === 60) ? "yes" : "no", "yes");

// Typing "12:00" on 23 Jul into the form should mean 19:00Z
const typed = new Date(2026, 6, 23, 12, 0);
check("form input 2026-07-23 12:00 saves as", fromZoned(typed).toISOString(), "2026-07-23T19:00:00.000Z");
const typedWinter = new Date(2026, 0, 15, 12, 0);
check("form input 2026-01-15 12:00 saves as", fromZoned(typedWinter).toISOString(), "2026-01-15T20:00:00.000Z");

console.log(fail ? `\n  ${fail} FAILED\n` : "\n  all passed\n");
process.exit(fail ? 1 : 0);
