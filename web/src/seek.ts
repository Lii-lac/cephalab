// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "seek"); behaviour must match v52.
import { ui } from "./state";
import { WEAPONS, wimg } from "./data";
import { CLASSNAME, S, animState, animTo, modn } from "./weapons";
import { MO } from "./motion";
import { parseLink } from "./sendou-link";

/* v52 type-to-search (Alex): start typing anywhere on the weapons screen and a search tape slides down from under the
   logo, already holding what you typed. It ranks the weapons as you go (word starts first, then anywhere in the name,
   then the class name). When every match falls in one category ("stamper", "charger", "nzap") the screen follows at
   once: the category's bead and the best weapon are picked. When the matches span categories nothing moves until you
   arrow through them. Enter takes the highlighted one and closes; Esc, Backspace on empty, or a click elsewhere closes. */
(() => {
  const RM = matchMedia("(prefers-reduced-motion: reduce)");
  const box = document.getElementById("seek"), input = document.getElementById("seekin"), list = box.querySelector(".seekres");
  const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const words = s => norm(s).split(/[^a-z0-9]+/).filter(Boolean);
  const INDEX = WEAPONS.map(w => ({ w, words: words(w.name), joined: norm(w.name).replace(/[^a-z0-9]/g, ""), cls: words(CLASSNAME[w.cls] || w.cls) }));
  const catOf = w => ui.sortMode === "Main" ? w.cls : ui.sortMode === "Sub" ? w.sub : w.sp;
  let results = [], hi = 0, steered = false, applyT = 0, open = false;

  function search(q) {
    const qw = words(q), qj = qw.join("");
    if (!qw.length) return [];
    const out = [];
    for (const it of INDEX) {
      let score = 0, ok = true;
      for (const t of qw) {
        const i = it.words.findIndex(x => x.startsWith(t));
        if (i >= 0) { score += i; continue; }
        if (t.length >= 2 && it.joined.includes(t)) { score += 10; continue; }
        if (it.cls.some(x => x.startsWith(t))) { score += 20; continue; }
        ok = false; break;
      }
      if (!ok) {                                                 // "nzap", "trislosher": spaces and dashes don't matter
        if (qj.length >= 2 && it.joined.includes(qj)) score = 10; else continue;
      }
      if (it.joined === qj) score -= 100;
      else if (it.joined.startsWith(qj)) score -= 5;
      out.push([score + it.w.name.length / 100, it.w]);
    }
    return out.sort((a, b) => a[0] - b[0]).map(x => x[1]);
  }

  function goTo(w) {                                            // pick weapon w, switching category first if needed
    const cat = catOf(w);
    if (cat !== ui.filt) { ui.filt = cat; ui.pick = w.row; MO.changeClass(false); return; }
    if (S.hold) { ui.pick = w.row; return; }                       // a redraw is on its way and will read `pick`
    const n = S.list.length, j = S.list.findIndex(x => x.row === w.row);
    if (j < 0) return;
    const base = S.anim ? S.anim.T : Math.round(S.pos);
    let d = modn(j - modn(base, n), n); if (d > n / 2) d -= n;
    if (!d && w.row === ui.pick) return;
    animTo(base + d, S.anim ? animState(performance.now()).v : 0);
  }
  function applySoon(now) {
    clearTimeout(applyT);
    const w = results[hi];
    if (!w) return;
    const decisive = steered || results.every(x => catOf(x) === catOf(results[0]));
    if (!decisive) return;
    if (now) goTo(w); else applyT = setTimeout(() => goTo(w), 200);   // typing fast doesn't set off a redraw per key
  }

  function paint() {
    input.classList.toggle("none", !!input.value.trim() && !results.length);
    list.innerHTML = results.slice(0, 6).map((w, i) =>
      `<li class="${i === hi ? "hi" : ""}" data-row="${w.row}"><img src="${wimg(w.row)}" alt=""><span>${w.name}</span></li>`).join("");
  }
  function update() {
    results = search(input.value); hi = 0; steered = false;
    paint(); applySoon(false);
  }

  const SHUT = "inset(0 -20px 100% -20px)", OPEN = "inset(0 -20px -400px -20px)";
  function show(first) {
    if (!open) {
      open = true; box.hidden = false;
      const logo = document.querySelector("header .logo");
      box.style.left = logo.offsetLeft - 4 + "px"; box.style.top = logo.offsetTop + logo.offsetHeight + 8 + "px";
      for (const a of box.getAnimations()) a.cancel();
      box.animate(RM.matches ? { opacity: [0, 1] } : { clipPath: [SHUT, OPEN], translate: ["0px -10px", "0px 0px"] },
        { duration: RM.matches ? 120 : 220, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    input.value = first; input.focus(); update();
  }
  function hide() {
    if (!open) return;
    open = false; clearTimeout(applyT); input.blur();
    const a = box.animate(RM.matches ? { opacity: [1, 0] } : { clipPath: [OPEN, SHUT], translate: ["0px 0px", "0px -10px"], opacity: [1, .4] },
      { duration: RM.matches ? 120 : 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
    a.finished.then(() => { if (!open) { box.hidden = true; input.value = ""; results = []; list.innerHTML = ""; } a.cancel(); }, () => {});
  }

  document.addEventListener("keydown", e => {
    if (open || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || !/[\p{L}\p{N}]/u.test(e.key)) return;
    if (!document.getElementById("weapons").classList.contains("on") || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    e.preventDefault(); show(e.key);
  });
  input.addEventListener("input", update);
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); hide(); }
    else if (e.key === "Backspace" && !input.value) { e.preventDefault(); hide(); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[hi]) { steered = true; applySoon(true); } hide(); }
    else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length) {
      e.preventDefault();
      const n = Math.min(6, results.length);
      hi = (hi + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      steered = true; paint(); applySoon(false);
    }
  });
  list.addEventListener("pointerdown", e => {
    const li = e.target.closest("li"); if (!li) return;
    e.preventDefault();
    hi = results.findIndex(w => w.row === li.dataset.row); steered = true; applySoon(true); hide();
  });
  document.addEventListener("pointerdown", e => { if (open && !box.contains(e.target)) hide(); });
  // a sendou build link pasted anywhere but another field (the search tape included): its weapon, and the build in the editor
  document.addEventListener("paste", e => {
    if (e.target.closest?.("input, textarea, select, [contenteditable]") && e.target !== input) return;
    if (document.getElementById("editor").classList.contains("on")) return;
    const b = parseLink(e.clipboardData?.getData("text") || "");
    if (!b) return;
    e.preventDefault(); hide();
    const w = WEAPONS.find(x => x.row === b.row);
    if (w && document.getElementById("weapons").classList.contains("on")) goTo(w);
    document.dispatchEvent(new CustomEvent("sendoulink", { detail: b }));
  });
  document.querySelector(".tabs").addEventListener("click", () => hide());
})();
