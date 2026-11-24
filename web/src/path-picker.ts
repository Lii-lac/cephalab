// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "picker"); behaviour must match v52.
import { ui } from "./state";
import { renderEditor } from "./editor";
import { pathBuild, renderPath, setPathBuild } from "./path";
import { show } from "./wiring";

/* v52: the build picker on the path screen. The title opens a list of your builds; picking one swaps the path in
   place (what's there fades down, the new route rises in, lane by lane). Click outside or Esc closes it. */
(() => {
  const host = document.getElementById("path"), RM = matchMedia("(prefers-reduced-motion: reduce)");
  const SOFT = "cubic-bezier(.2,.8,.2,1)", OUT = "cubic-bezier(.4,0,1,1)";
  const SHUT = "inset(0 -20px 100% -20px)", OPEN = "inset(-20px -20px -400px -20px)";   // as the weapons search tape
  // Open or shut is aria-expanded on the title, nothing else: a click mid-close reopens from where the list is, and a
  // finished close leaves no animation behind (a kept fill-forwards fade used to hide the list on the next open).
  const isOpen = () => host.querySelector(".pbuild")?.getAttribute("aria-expanded") === "true";
  const stop = p => p.getAnimations({ subtree: true }).forEach(a => a.cancel());
  // Type to find: every word must start a word of the build's name or its weapon's (else appear inside it); best first,
  // the rest keep their order. The top match is lit, Enter takes it, arrows move the light.
  function find(q) {
    const p = host.querySelector(".ppick"), list = p.querySelector(".prows"), words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [...list.querySelectorAll(".pbrow")].sort((a, b) => +a.dataset.i - +b.dataset.i);
    const score = r => { let t = 0; for (const w of words) { const k = r.dataset.q.split(/\s+/).findIndex(x => x.startsWith(w)); if (k >= 0) t += k; else if (r.dataset.q.includes(w)) t += 10; else return null; } return t; };
    const hit = rows.map(r => [score(r), r]).filter(([v]) => v !== null).sort((a, b) => a[0] - b[0] || +a[1].dataset.i - +b[1].dataset.i);
    rows.forEach(r => { r.hidden = true; r.classList.remove("hi"); });
    hit.forEach(([, r]) => { r.hidden = false; list.append(r); });
    if (words.length) hit[0]?.[1].classList.add("hi");
    p.classList.toggle("nohit", !hit.length);
  }
  function light(d) {
    const rows = [...host.querySelectorAll(".ppick .pbrow:not([hidden])")]; if (!rows.length) return;
    const i = rows.findIndex(r => r.classList.contains("hi")), n = rows[(i + d + rows.length) % rows.length];
    rows.forEach(r => r.classList.toggle("hi", r === n)); n.scrollIntoView({ block: "nearest" });
  }
  function open(q = "") {
    const p = host.querySelector(".ppick"), btn = host.querySelector(".pbuild"); if (!p || isOpen()) return;
    const from = p.hidden ? 0 : +getComputedStyle(p).opacity;   // mid-close: carry on from what's on screen
    stop(p); p.style.opacity = ""; p.style.translate = ""; p.hidden = false; btn.setAttribute("aria-expanded", "true");
    p.animate(RM.matches ? { opacity: [from, 1] } : { clipPath: [from ? OPEN : SHUT, OPEN], translate: [`0px ${(-10 * (1 - from)).toFixed(1)}px`, "0px 0px"], opacity: [Math.max(from, .4), 1] }, { duration: RM.matches ? 120 : 220, easing: SOFT });
    p.querySelectorAll(".pbrow").forEach((r, i) => r.dataset.i ??= i);
    const input = p.querySelector(".pq"); input.value = q; find(q); input.focus({ preventScroll: true });
    if (!q) p.querySelector(".pbrow.on")?.classList.add("hi");
  }
  function close() {
    const p = host.querySelector(".ppick"), btn = host.querySelector(".pbuild"); if (!p || !isOpen()) return;
    btn.setAttribute("aria-expanded", "false");
    const from = +getComputedStyle(p).opacity; stop(p); p.style.opacity = ""; p.style.translate = "";
    const a = p.animate(RM.matches ? { opacity: [from, 0] } : { clipPath: [OPEN, SHUT], translate: ["0px 0px", "0px -10px"], opacity: [from, .4] }, { duration: RM.matches ? 120 : 180, easing: OUT, fill: "forwards" });
    a.finished.then(() => { if (!isOpen()) { p.hidden = true; a.cancel(); } }, () => {});
  }
  function swap(id) {
    setPathBuild(id);
    const parts = [...host.querySelectorAll(".ptop .pbuild, .next, .lanes .lane")];
    close();
    Promise.all(parts.map(el => el.animate({ opacity: [1, 0], translate: ["0px 0px", "0px 6px"] }, { duration: 130, easing: OUT, fill: "forwards" }).finished)).then(() => {
      renderPath();
      host.querySelectorAll(".ptop .pbuild, .next, .lanes .lane").forEach((el, i) =>
        el.animate(RM.matches ? { opacity: [0, 1] } : { opacity: [0, 1], translate: ["0px 10px", "0px 0px"] }, { duration: 260, delay: RM.matches ? 0 : i * 45, easing: SOFT, fill: "backwards" }));
    });
  }
  // Up next pages: forward slides up (the old page leaves upward, the new one rises in), back slides down
  function upTo(card, k, dir) {
    const cur = +card.dataset.cur, n = card.querySelectorAll(".udot").length; if (!n || k === cur) return;
    dir ??= k > cur ? 1 : -1;                                  // the dots run top to bottom; the timer always goes forward
    card.dataset.cur = k;
    card.querySelectorAll(".udot").forEach((d, i) => d.classList.toggle("on", i === k));
    card.querySelectorAll(".ustack").forEach(st => {
      const a = st.children[cur], b = st.children[k]; if (!a || !b) return;
      [a, b].forEach(x => x.getAnimations().forEach(an => an.cancel()));
      const fromT = a.style.translate || "0px 0px", fromO = a.style.opacity || "1", dy = parseFloat(fromT.split(" ")[1]) || 0;
      a.style.translate = a.style.opacity = "";                  // a drag may have left it mid-way; leave from there
      a.classList.remove("on"); b.classList.add("on");
      if (RM.matches) { b.animate({ opacity: [0, 1] }, { duration: 160 }); return; }
      a.animate({ opacity: [fromO, 0], translate: [fromT, `0px ${dy - 16 * dir}px`], visibility: ["visible", "visible"] }, { duration: 180, easing: OUT });
      b.animate({ opacity: [0, 1], translate: [`0px ${16 * dir}px`, "0px 0px"] }, { duration: 300, delay: 70, easing: SOFT, fill: "backwards" });
    });
  }
  // Turn the page every 3.6s. Pointer over the card (or keyboard focus in it) holds the page; the wait starts over from
  // a flip, a dot click or the end of a hold, so a page always gets its full time.
  let last = performance.now();
  setInterval(() => {
    const card = host.querySelector(".next"), now = performance.now();
    if (!card || !host.classList.contains("on") || document.hidden || card.matches(":hover") || card.querySelector(":focus-visible") || isOpen()) { last = now; return; }
    const n = card.querySelectorAll(".udot").length;
    if (n > 1 && now - last >= 3600) { upTo(card, (+card.dataset.cur + 1) % n, 1); last = now; }
  }, 200);
  // Drag the card up for the next piece, down for the one before: the page follows the pointer (a little stiff), and
  // past 28px or on a flick it turns; anything less springs back.
  let drag = null;
  host.addEventListener("pointerdown", e => {
    const card = e.target.closest(".next");
    if (!card || e.button !== 0 || e.target.closest("button, a, input") || card.querySelectorAll(".udot").length < 2) return;
    drag = { card, id: e.pointerId, y0: e.clientY, dy: 0, hist: [[performance.now(), e.clientY]], moved: false,
             z: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--zpl")) || 1 };
    card.setPointerCapture(e.pointerId);
  });
  host.addEventListener("pointermove", e => {
    if (!drag || e.pointerId !== drag.id) return;
    const raw = e.clientY - drag.y0; drag.hist.push([performance.now(), e.clientY]); if (drag.hist.length > 6) drag.hist.shift();
    if (!drag.moved && Math.abs(raw) < 4) return;
    if (!drag.moved) { drag.moved = true; drag.card.classList.add("dragging"); }
    const d = raw / drag.z, eased = Math.sign(d) * Math.min(Math.abs(d), 40 + Math.max(0, Math.abs(d) - 40) * .3);   // stiffer past 40px
    drag.dy = d;
    drag.card.querySelectorAll(".ustack > .upg.on").forEach(el => { el.getAnimations().forEach(a => a.cancel()); el.style.translate = `0px ${eased.toFixed(1)}px`; el.style.opacity = (1 - Math.min(.7, Math.abs(eased) / 70)).toFixed(3); });
  });
  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { card, dy, hist, moved } = drag; drag = null; card.classList.remove("dragging"); last = performance.now();
    if (!moved) return;
    const [t0, y0] = hist[0], [t1, y1] = hist[hist.length - 1], v = (y1 - y0) / Math.max(1, t1 - t0);   // px per ms
    const n = card.querySelectorAll(".udot").length, cur = +card.dataset.cur;
    if (e.type !== "pointercancel" && (dy < -28 || v < -.45)) upTo(card, (cur + 1) % n, 1);
    else if (e.type !== "pointercancel" && (dy > 28 || v > .45)) upTo(card, (cur - 1 + n) % n, -1);
    else card.querySelectorAll(".ustack > .upg.on").forEach(el => {
      const ft = el.style.translate || "0px 0px", fo = el.style.opacity || "1"; el.style.translate = el.style.opacity = "";
      el.animate({ translate: [ft, "0px 0px"], opacity: [fo, 1] }, { duration: 260, easing: SOFT });
    });
  }
  host.addEventListener("pointerup", endDrag);
  host.addEventListener("pointercancel", endDrag);
  host.addEventListener("click", e => {
    const dot = e.target.closest("[data-up]");
    if (dot) { upTo(dot.closest(".next"), +dot.dataset.up); last = performance.now(); return; }
    if (e.target.closest("[data-pnew]")) {                     // empty path screen: start a build
      ui.ed = { title: "", modes: [], notes: "", weapon: ui.pick, set: ["Hed_FST000", "Clt_FST001", "Shs_FST000"].map(row => [row, "", ["", "", ""]]) };
      ui.edIdx = -1; ui.edKey = null; ui.edFrom = "path"; ui.sel = [0, -1]; renderEditor(); show("editor"); return;
    }
    const row = e.target.closest("[data-pb]");
    if (row) { if (+row.dataset.pb === pathBuild()?.id) close(); else swap(+row.dataset.pb); return; }
    if (e.target.closest(".pbuild")) { isOpen() ? close() : open(); return; }
  });
  document.addEventListener("pointerdown", e => { if (!e.target.closest(".ppick, .pbuild")) close(); });
  host.addEventListener("input", e => { if (e.target.matches(".pq")) find(e.target.value); });
  document.addEventListener("keydown", e => {
    if (!document.getElementById("path").classList.contains("on") || !host.querySelector(".ppick")) return;
    if (!isOpen()) {                                           // a letter anywhere on the path screen opens the list and searches
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || !/[\p{L}\p{N}]/u.test(e.key) || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault(); open(e.key); return;
    }
    if (e.key === "Escape") { close(); host.querySelector(".pbuild")?.focus(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); light(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "Enter") {
      const r = host.querySelector(".ppick .pbrow.hi:not([hidden])") || host.querySelector(".ppick .pbrow:not([hidden])");
      if (r) { e.preventDefault(); r.click(); }
    }
  });
})();
