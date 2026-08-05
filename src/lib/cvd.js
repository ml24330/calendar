/* Are two tag colours tellable apart?
 *
 * Roughly 8% of men and 0.5% of women have some colour vision deficiency, and
 * the year planner encodes tags by colour alone, so a pair that collapses
 * under deuteranopia genuinely loses information for those readers.
 *
 * Each colour is projected through a simulation of the three common types and
 * compared in CIE Lab, where distance corresponds reasonably to how different
 * two colours look. It is an approximation — real colour vision varies — but
 * it reliably catches the pairs that are obviously wrong.
 */

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

const hexToRgb = (h) => {
  const s = h.replace("#", "");
  const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
};

/* Deuteranopia (~6% of men), protanopia (~2%), tritanopia (rare). */
const MATRICES = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
  protanopia: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]],
  tritanopia: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]],
};

export const CVD_TYPES = Object.keys(MATRICES);

function simulate(hex, kind) {
  const lin = hexToRgb(hex).map(srgbToLin);
  const m = MATRICES[kind];
  return m
    .map((row) => row.reduce((a, k, i) => a + k * lin[i], 0))
    .map((v) => linToSrgb(Math.min(1, Math.max(0, v))));
}

function toLab([r, g, b]) {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / 0.9505), fy = f(Y), fz = f(Z / 1.089);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Perceptual distance between two colours as a given viewer would see them. */
export function distance(a, b, kind = "normal") {
  const [A, B] = [toLab(simulate(a, kind)), toLab(simulate(b, kind))];
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/* Below this, two colours read as the same at the size these swatches are
   drawn. Chosen to flag genuine collisions without crying wolf on every
   palette — the default set clears it comfortably up to five tags. */
export const CONFUSABLE = 15;

const LABEL = {
  normal: "normal vision",
  deuteranopia: "red-green colour blindness",
  protanopia: "red-green colour blindness",
  tritanopia: "blue-yellow colour blindness",
};

/**
 * Pairs of tags that would be hard to tell apart, worst first.
 * Each entry names the two tags and the kind of vision it affects.
 */
export function confusablePairs(tags, threshold = CONFUSABLE) {
  const out = [];
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      let worst = { d: Infinity, kind: "normal" };
      for (const kind of CVD_TYPES) {
        const d = distance(tags[i].color, tags[j].color, kind);
        if (d < worst.d) worst = { d, kind };
      }
      if (worst.d < threshold) {
        out.push({ a: tags[i], b: tags[j], distance: worst.d, affects: LABEL[worst.kind] });
      }
    }
  }
  return out.sort((x, y) => x.distance - y.distance);
}
