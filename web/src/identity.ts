// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "identity"); behaviour must match v52.

/* Build identity: everything about a card's look comes from the build's id (sendou's build id), so the same
   build always gets the same card, even before we store anything about it. Shared by v14.html and palette.html. */
export function hash32(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) {            // mulberry32: small, fast, good enough for looks
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/* What a build IS, as one string: the three gear slots in order, each its gear row ("*" when blank or any gear), main ability
   and three subs. The look (ink, splats, sticker, corner ink, Up next) is seeded from this, never from b.id, so the same
   contents look the same on every machine. The weapon and the title are not part of it. */
export function buildKey(b) {
  const t = v => String(v ?? "").trim();
  return [0, 1, 2].map(i => {
    const [row, main, subs] = (b && b.set && b.set[i]) || [];
    return [t(row) || "*", t(main), ...[0, 1, 2].map(k => t(subs && subs[k]))].join("|");
  }).join("/");
}
/* The Splatoon colour space: "toothpaste" brights, one tuned band per hue family (OKLCH).
   Alex's picks (2026-11-18): hot pink, violet, lemon and coral are right; deep green and amber are wrong.
   So amber/orange-yellow (hue 45-95) is left out, greens are mint, and each family gets its own lightness/chroma. */
export const BANDS = [
  { name: "coral",  h: [15, 45],   L: [.66, .74], C: [.15, .19] },
  { name: "lemon",  h: [95, 130],  L: [.88, .92], C: [.16, .19] },
  { name: "mint",   h: [130, 185], L: [.78, .84], C: [.12, .15] },
  { name: "sky",    h: [185, 235], L: [.72, .80], C: [.12, .15] },
  { name: "blue",   h: [235, 280], L: [.64, .72], C: [.14, .18] },
  { name: "violet", h: [280, 320], L: [.62, .70], C: [.16, .20] },
  { name: "pink",   h: [320, 375], L: [.66, .74], C: [.17, .21] },   // wraps past 360 into the reds
];
const SPAN = BANDS.reduce((t, b) => t + b.h[1] - b.h[0], 0);
export function bandFor(h) { const hh = h < 15 ? h + 360 : h; return BANDS.find(b => hh >= b.h[0] && hh < b.h[1]) || null; }
export function inkFor(id) {
  const r = rng(hash32(id));
  let u = r() * SPAN, band = BANDS[0];
  for (const b of BANDS) { const w = b.h[1] - b.h[0]; if (u < w) { band = b; break; } u -= w; }
  const h = Math.round(band.h[0] + u) % 360;
  const L = band.L[0] + r() * (band.L[1] - band.L[0]), C = band.C[0] + r() * (band.C[1] - band.C[0]);
  return { h, L, C, band: band.name, css: `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${h})`,
           deep: `oklch(${(L - .1).toFixed(3)} ${C.toFixed(3)} ${h})`,
           light: `oklch(${Math.min(.95, L + .08).toFixed(3)} ${(C * .8).toFixed(3)} ${h})`,
           text: L < .67 ? "#fff" : "#111" };
}
/* Card personality: where the splats land, how they turn, and one small charm. */
/* Card personality, placed only where it can't cover text:
   splats sit on a corner or edge anchor and are cropped by the card, like a splashtag;
   the charm sits in a free zone (the empty footer left of the buttons, or the card's top edge). */
const CHARMS = ["graffiti", "scuffs", "tape", "sticker", "stars", "drips", "doodle", "none"];
const ANCHORS = [{ x: 100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 55 }, { x: 0, y: 0 }, { x: 55, y: 100 }];
export function looksFor(id) {
  const r = rng(hash32(id + ":looks"));
  const order = ANCHORS.map(a => [r(), a]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
  const splats = order.slice(0, 1 + (r() < .55 ? 1 : 0)).map(a => ({
    x: Math.round(a.x + (r() * 20 - 10)), y: Math.round(a.y + (r() * 20 - 10)),   // near a corner or edge, never mid-card
    s: Math.round(170 + r() * 130), rot: Math.round(r() * 360), flip: r() < .5, deep: r() < .5 }));
  return { splats, tilt: +(r() * 3 - 1.5).toFixed(2), dx: Math.round(r() * 12 - 6), dy: Math.round(r() * 12 - 6), seed: hash32(id) };   // a little x/y wobble too
}
