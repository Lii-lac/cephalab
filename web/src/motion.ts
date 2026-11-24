// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "motion"); behaviour must match v52.
import { ui } from "./state";
import { late } from "./late";
import { beadSquid } from "./beadsquid";
import { S, STEP, applyScroll, filters, layoutGoo, paintBeads, renderBelow, renderWeapons } from "./weapons";
import { renderPath } from "./path";

/* ================= MOTION (v48) =================
   Whatever changes leaves first (~130ms), then the new state is drawn and arrives. A change that lands mid-way never
   cuts anything: what is already leaving keeps going, and only the newest state is drawn once it is gone. Leaving
   starts from wherever an element is on screen, so a quick second click picks up mid-arrival. Everything animates the
   individual translate/rotate/scale properties, which stack on top of the page's own (often !important) transforms.
   Reduced motion: short opacity fades only, no movement. */
export const MO = (() => {
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const RM = { get matches() { return mq.matches || document.documentElement.classList.contains("st-still"); } };   // Settings > Display > Motion: Reduced
  const OUT = "cubic-bezier(.4,0,1,1)", SOFT = "cubic-bezier(.2,.8,.2,1)", LEAVE = 130;
  const PROPS = ["opacity", "translate", "rotate", "scale"];
  const shown = el => el && el.isConnected && el.getClientRects().length > 0;

  // calm: the reduced-motion keyframes (default: just the opacity of `frames`, if it has one)
  function play(el, frames, opts, calm) {
    if (!el) return null;
    if (RM.matches) {
      const o = frames.opacity, f = calm !== undefined ? calm : o ? { opacity: [o[0], o[o.length - 1]] } : null;
      if (!f) return null;
      const t = { duration: Math.min(opts.duration || 160, 160), fill: opts.fill || "backwards" };
      if (opts.pseudoElement) t.pseudoElement = opts.pseudoElement;
      return el.animate(f, t);
    }
    return el.animate(frames, { fill: "backwards", ...opts });
  }
  // stop an element's own animations right where they are on screen; thaw() undoes it
  function freeze(el) {
    if (!el.__mo) { el.__mo = { pe: el.style.pointerEvents }; for (const p of PROPS) el.__mo[p] = el.style.getPropertyValue(p); }
    for (const a of el.getAnimations()) {
      if (a instanceof CSSTransition || a instanceof CSSAnimation) continue;
      if (!a.effect?.pseudoElement) try { a.commitStyles(); } catch {}
      a.cancel();
    }
  }
  function thaw(el) {
    for (const a of el.getAnimations()) if (!(a instanceof CSSTransition || a instanceof CSSAnimation)) a.cancel();
    if (!el.__mo) return;
    for (const p of PROPS) el.style.setProperty(p, el.__mo[p]);
    el.style.pointerEvents = el.__mo.pe; delete el.__mo;
  }
  function Stage() {
    let gen = 0, waits = [];
    const leaving = new Set();
    return {
      leave(els, frames, timing = () => ({}), calm) {
        [...els].forEach((el, i) => {
          if (leaving.has(el) || !shown(el)) return;
          freeze(el); leaving.add(el); el.style.pointerEvents = "none";
          const a = play(el, frames(el, i), { duration: LEAVE, easing: OUT, fill: "forwards", ...timing(el, i) }, calm);
          if (a) waits.push(a.finished.catch(() => {}));
        });
      },
      run(draw) {
        const my = ++gen;
        Promise.all(waits).then(() => {
          if (my !== gen) return;
          waits = [];
          for (const el of leaving) if (el.isConnected) thaw(el);   // what stays in the page (a screen, the bead row) is restored
          leaving.clear();
          draw();
        });
      },
    };
  }
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ---------- weapons screen: banner, builds, strip, beads ---------- */
  const W = Stage();
  let level = null, beadsLeaving = false, sortedSwap = false;

  function leaveBanner() {
    W.leave($$("#below .wpanel .wink, #below .wpanel .gun, #below .wpanel .ntape span, #below .wpanel .kb, #below .wordname, #below .archname, #below .artbox, #below .kitbar"),
      el => el.matches(".wink") ? { scale: [1, .82], opacity: [1, 0] }
        : el.matches(".gun") ? { translate: ["0px 0px", "0px 16px"], opacity: [1, 0] }
        : el.matches(".kb") ? { scale: [1, .7], opacity: [1, 0] }
        : { scale: [1, .94], opacity: [1, 0] });
  }
  function arriveBanner() {
    play($("#below .wpanel .wink"), { scale: [.15, 1.1, 1], rotate: ["-28deg", "3deg", "0deg"], opacity: [0, 1, 1], offset: [0, .6, 1] }, { duration: 380, easing: SOFT });
    play($("#below .wpanel .gun"), { translate: ["0px -26px", "0px 0px"], rotate: ["-12deg", "0deg"], scale: [.75, 1], opacity: [0, 1] }, { duration: 360, delay: 90, easing: SOFT });
    $$("#below .wpanel .ntape span").forEach((s, k) => play(s, { scale: [1.35, .96, 1], rotate: ["-7deg", "1deg", "0deg"], opacity: [0, 1, 1], offset: [0, .7, 1] },
      { duration: 260, delay: 150 + k * 70, easing: "cubic-bezier(.3,.6,.3,1)" }));
    $$("#below .wpanel .kb").forEach((b, k) => play(b, { scale: [0, 1.14, 1], rotate: ["-18deg", "2deg", "0deg"], opacity: [0, 1, 1], offset: [0, .65, 1] },
      { duration: 320, delay: 230 + k * 70, easing: SOFT }));
    $$("#below .wordname, #below .archname, #below .artbox, #below .kitbar").filter(shown).forEach((el, k) =>
      play(el, { translate: ["0px 10px", "0px 0px"], opacity: [0, 1] }, { duration: 280, delay: 100 + k * 50, easing: SOFT }));
  }
  // builds: the old cards slide up a touch and fade, the new ones slide up into place (Alex: keep it simple)
  const onScreen = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && r.width > 0; };
  function leaveBuilds() {
    W.leave($$("#below .pins > .bcard2").filter(onScreen), () => ({ translate: ["0px 0px", "0px -12px"], opacity: [1, 0] }));
  }
  function arriveBuilds() {
    $$("#below .pins > .bcard2").filter(onScreen).forEach((c, i) =>
      play(c, { translate: ["0px 16px", "0px 0px"], opacity: [0, 1] }, { duration: 260, delay: Math.min(i, 8) * 30, easing: SOFT }));
  }
  function leaveStrip(sorted) {
    cancelAnimationFrame(S.raf); S.raf = 0; S.anim = null; S.drag = false; S.hold = 1;   // the old strip can't move or pick (stripHtml lets go)
    const st = $("#strip3"); if (st) st.style.pointerEvents = "none";
    const slots = [...S.cards].filter(([, el]) => +el.style.opacity > .05);
    W.leave(slots.map(([, el]) => el.querySelector(".ecard")),
      (el, k) => { const u = slots[k][0] - S.pos; return { translate: ["0px 0px", `${(u * 8).toFixed(1)}px 24px`], scale: [1, .85], opacity: [1, 0] }; },
      (el, k) => ({ delay: Math.min(60, Math.abs(slots[k][0] - S.pos) * 12) }));
    if (sorted) W.leave($$("#weapons .sorttag2 .lbl"), () => ({ translate: ["0px 0px", "0px 10px"], opacity: [1, 0] }));
  }
  function arriveStrip(sorted) {
    for (const [i, el] of S.cards) {
      if (+el.style.opacity < .05) continue;
      const u = i - S.pos, card = el.querySelector(".ecard");
      play(card, { translate: [`${(-u * STEP * .78).toFixed(1)}px 6px`, "0px 0px"], rotate: [`${(-u * 6).toFixed(1)}deg`, "0deg"], scale: [.8, 1] },
        { duration: 520, delay: 20, easing: "cubic-bezier(.16,1,.3,1)" }, null);
      play(card, { opacity: [0, 1] }, { duration: 200, delay: 20 + Math.min(5, Math.abs(u)) * 18, easing: "linear" });
      if (el.classList.contains("on")) play(card, { scale: [.4, 1.12, 1], opacity: [0, 1, 1], offset: [0, .6, 1] },
        { duration: 340, delay: 150, easing: SOFT, pseudoElement: "::before" });
    }
    if (sorted) play($("#weapons .sorttag2 .lbl"), { translate: ["0px -10px", "0px 0px"], opacity: [0, 1] }, { duration: 240, easing: SOFT });
  }
  // the class splat leaves the old bead and splats onto the new one; the squid hops across
  const splatOut = new WeakMap();
  function swapSplat(oldOn, newOn) {
    if (!newOn || oldOn === newOn) return;
    splatOut.get(newOn)?.cancel();
    newOn.classList.remove("was"); newOn.style.zIndex = newOn.dataset.z;
    if (oldOn && oldOn.isConnected) {
      oldOn.classList.add("was"); oldOn.style.zIndex = 49;
      const a = play(oldOn, { scale: [1, .3], rotate: ["0deg", "24deg"], opacity: [1, 0] }, { duration: 200, easing: OUT, fill: "forwards", pseudoElement: "::before" });
      const done = () => { if (splatOut.get(oldOn) !== a) return; splatOut.delete(oldOn); oldOn.classList.remove("was"); oldOn.style.zIndex = oldOn.dataset.z; a?.cancel(); };
      splatOut.set(oldOn, a);
      a ? a.finished.then(done, () => {}) : done();
    }
    play(newOn, { scale: [.2, 1.12, 1], rotate: ["-30deg", "4deg", "0deg"], opacity: [0, 1, 1], offset: [0, .6, 1] }, { duration: 360, easing: SOFT, pseudoElement: "::before" });
    play(newOn.querySelector("img"), { scale: [.8, 1.12, 1], offset: [0, .6, 1] }, { duration: 320, easing: SOFT });
  }
  function hop(holder, from) {
    if (!holder || !from || !from.width) return;
    for (const a of holder.getAnimations()) a.cancel();
    const to = holder.getBoundingClientRect(), dx = from.left - to.left, dy = from.top - to.top;
    if (Math.hypot(dx, dy) < 1) return;
    // where the squid would sit on each bead: that bead's box plus the holder's offset inside its own bead
    const beads = $$("#beadslot .bead"), end = beads.indexOf(holder.closest(".bead"));
    if (end >= 0) {
      const er = beads[end].getBoundingClientRect(), ox = to.left - er.left, oy = to.top - er.top;
      const at = b => { const r = b.getBoundingClientRect(); return [r.left + ox - to.left, r.top + oy - to.top]; };
      let start = end, best = Infinity;                          // the bead it starts from (nearest, even mid-walk)
      beads.forEach((b, i) => { const [x, y] = at(b), d = Math.hypot(x - dx, y - dy); if (d < best) { best = d; start = i; } });
      if (Math.abs(end - start) > 1) {
        const dir = Math.sign(end - start), pts = [[dx, dy]];
        for (let i = start + dir; i !== end; i += dir) pts.push(at(beads[i]));
        pts.push([0, 0]);
        const path = [];
        for (let k = 0; k < pts.length - 1; k++) {
          const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
          for (let s = 0; s < 8; s++) {
            const u = s / 8, u2 = u * u, u3 = u2 * u;
            path.push([0, 1].map(j => .5 * (2 * p1[j] + (p2[j] - p0[j]) * u + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * u2 + (3 * p1[j] - p0[j] - 3 * p2[j] + p3[j]) * u3)));
          }
        }
        path.push([0, 0]);
        const len = [0];
        for (let k = 1; k < path.length; k++) len.push(len[k - 1] + Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]));
        const walk = Math.max(240, 42 * (pts.length - 1)), L = len[len.length - 1];
        play(holder, path.map((p, k) => ({ translate: `${p[0].toFixed(1)}px ${p[1].toFixed(1)}px`, offset: len[k] / L })),
          { duration: walk, easing: "cubic-bezier(.45,0,.25,1)" }, { opacity: [0, 1] });
        play(holder, { scale: ["1 1", "1.14 .84", "1 1"], offset: [0, .4, 1] }, { duration: 160, delay: walk - 20, easing: SOFT }, null);
        return;
      }
    }
    const lift = Math.min(46, 16 + Math.abs(dx) * .12);
    play(holder, { translate: [`${dx}px ${dy}px`, `${dx * .5}px ${dy * .5 - lift}px`, "0px 0px", "0px 0px"], scale: ["1 1", "1 1", "1.14 .84", "1 1"], offset: [0, .45, .82, 1] },
      { duration: 360 + Math.min(220, Math.abs(dx) * .5), easing: "cubic-bezier(.3,.3,.5,1)" }, { opacity: [0, 1] });
  }
  function arriveBeads() {
    const beads = $$("#beadslot .bead"), fi = beads.findIndex(b => b.classList.contains("on"));
    play($("#beadslot .goo"), { opacity: [0, 1] }, { duration: 260, easing: SOFT });
    beads.forEach((b, i) => play(b, { scale: [.3, 1.1, 1], opacity: [0, 1, 1], offset: [0, .6, 1] }, { duration: 300, delay: Math.abs(i - fi) * 28, easing: SOFT }));
    const on = beads[fi];
    if (on) play(on, { scale: [.2, 1.12, 1], rotate: ["-30deg", "4deg", "0deg"], opacity: [0, 1, 1], offset: [0, .6, 1] }, { duration: 360, delay: 80, easing: SOFT, pseudoElement: "::before" });
  }

  let belowGen = 0;
  function drawWeapons() {
    const all = level === "all", my = ++belowGen;
    level = null;
    if (all) {
      ui.beadsRebuilt = false;
      renderWeapons.later = true; renderWeapons(); renderWeapons.later = false;
      if (ui.beadsRebuilt) arriveBeads();
      beadsLeaving = false;
      arriveStrip(sortedSwap); sortedSwap = false;
      // the heavy part a frame later: after this frame is painted (rAF), as the next task (setTimeout)
      requestAnimationFrame(() => setTimeout(() => { if (my !== belowGen) return; renderBelow(); arriveBanner(); arriveBuilds(); }, 0));
      return;
    } else renderBelow();
    arriveBanner();
    arriveBuilds();
  }
  // a weapon was picked in the strip
  function pickWeapon() {
    if (level !== "all") level = "below";
    leaveBanner(); leaveBuilds();
    W.run(drawWeapons);
  }
  // a class bead was clicked, or the sort mode changed
  function changeClass(sorted) {
    const fs = filters(), slot = $("#beadslot"), cur = $$(".bead", slot);
    const same = !beadsLeaving && cur.length === fs.length && cur.every((b, i) => b.dataset.f === fs[i].key);
    if (same) {                                                      // the bead row answers at once; the rest follows
      const holder = $(".bead-squid"), from = holder?.getBoundingClientRect(), oldOn = $(".bead.on", slot);
      paintBeads(fs, fs.findIndex(f => f.key === ui.filt));
      const newOn = $(".bead.on", slot);
      swapSplat(oldOn, newOn); beadSquid(newOn); hop(holder, from);
    } else {
      beadsLeaving = true;
      W.leave(cur, (el, i) => ({ translate: ["0px 0px", "0px 12px"], scale: [1, .4], opacity: [1, 0] }), (el, i) => ({ delay: i * 14 }));
      W.leave($$(".goo", slot), () => ({ opacity: [1, 0] }), () => ({ duration: 200 }));
    }
    level = "all"; sortedSwap ||= sorted;
    leaveStrip(sorted); leaveBanner(); leaveBuilds();
    W.run(drawWeapons);
  }

  /* ---------- tabs ---------- */
  const SC = Stage();
  let screenTo = null;
  function screen(id) {
    const target = document.getElementById(id), cur = $(".screen.on");
    const tab = id === "editor" ? (ui.edFrom === "gear" ? "gear" : ui.edFrom === "path" ? "builds" : "weapons") : id === "weapon" ? "weapons" : id === "path" ? "builds" : id;
    $$(".tab").forEach(b => b.classList.toggle("on", b.dataset.s === tab));   // the tab pill answers at once
    if (cur === target && !screenTo) return;
    screenTo = id;
    if (cur && cur !== target) {
      SC.leave([cur], () => ({ translate: ["0px 0px", "0px 10px"], opacity: [1, 0] }), () => ({ duration: 120 }));
      if (cur.id === "weapons") SC.leave([$("#beadslot")], () => ({ opacity: [1, 0] }), () => ({ duration: 120 }));
    }
    SC.run(() => {
      screenTo = null;
      late.showNow(id);
      if (id === "weapons") { applyScroll(); layoutGoo(); }
      if (!target) return;                                       // Gear has no screen in the mockup yet
      play(target, { translate: ["0px 16px", "0px 0px"], opacity: [0, 1] }, { duration: 260, easing: SOFT });
      let kids = [...target.children]; if (kids.length === 1) kids = [...kids[0].children];
      kids.filter(k => !k.inert && shown(k)).slice(0, 6).forEach((k, i) => play(k, { translate: ["0px 18px", "0px 0px"], opacity: [0, 1] }, { duration: 320, delay: 40 + i * 50, easing: SOFT }));
      if (id === "weapons") { play($("#beadslot"), { opacity: [0, 1] }, { duration: 220 }); arriveBeads(); }
    });
  }

  /* ---------- path toggles ---------- */
  const PA = Stage();
  function path(t) {
    PA.leave($$("#path .lanes .track > *"), () => ({ scale: [1, .8], opacity: [1, 0] }), () => ({ duration: 110 }));
    PA.run(() => {
      renderPath();
      const tog = $(`#path .tog[data-t="${t}"]`), knob = tog?.querySelector(".knob"), on = tog?.classList.contains("on");
      if (knob) {
        play(knob, { translate: [on ? "-14px 0px" : "14px 0px", "0px 0px"] }, { duration: 220, easing: SOFT, pseudoElement: "::after" }, null);
        const yellow = getComputedStyle(document.documentElement).getPropertyValue("--yellow").trim();
        play(knob, { backgroundColor: [on ? "#444" : yellow, getComputedStyle(knob).backgroundColor] }, { duration: 180 }, null);
      }
      $$("#path .lanes .track").forEach(tr => [...tr.children].forEach((c, i) =>
        play(c, { translate: ["0px 8px", "0px 0px"], scale: [.8, 1], opacity: [0, 1] }, { duration: 260, delay: Math.min(300, i * 22), easing: SOFT })));
      $$("#path .badge b").forEach(b => play(b, { scale: [.6, 1.15, 1], offset: [0, .6, 1] }, { duration: 260, easing: SOFT }));
    });
  }

  return { pickWeapon, changeClass, screen, path, hop };
})();

// forward references from earlier modules (they were one shared script scope in v52)
Object.assign(late, { MO });
