// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "gear"); behaviour must match v52.
import { ui } from "./state";
import { late } from "./late";
import { BUILDS, GEAR, MODES, NAMES, WEAPONS, byKey, storeMine, syncSaved, wimg } from "./data";
import { buildCard } from "./weapons";
import { renderEditor } from "./editor";
import { renderPath, setPathBuild } from "./path";
import { show } from "./wiring";

/* v52 Gear tab = your builds (Alex: "gear is for builds, not individual pieces"). Every build you saved or made, as
   the same cards the weapons screen uses, newest first, then a New build tile that starts one from scratch (starter
   gear, empty slots, the weapon you're on). Edit opens the editor; Remove fades the card out.
   Type anywhere on the tab to search (the weapons screen's tape, beside the heading): every word has to match the
   build's title, a mode, a gear piece, an ability or its weapon. Esc, or emptying it, brings every build back. */
const MODEWORDS = { TW: "turf war", SZ: "splat zones", TC: "tower control", RM: "rainmaker", CB: "clam blitz" };
let gearQ = "";
function buildText(b) {
  const w = (WEAPONS.find(x => x.row === b.weapon) || {}).name || "";
  return [b.title, ...b.modes.map(m => `${MODES[m] || ""} ${MODEWORDS[m] || ""}`), w,
    ...b.set.flatMap(([row, main, subs]) => [(GEAR[row] || [""])[0], NAMES[main] || "", ...subs.map(s => NAMES[s] || "")])]
    .join(" ").toLowerCase();
}
function renderGearTab() {
  const host = document.getElementById("gear");
  const mine = BUILDS.map((b, i) => [b, i]).filter(([b]) => b.mine).reverse();
  host.innerHTML = `<div class="gl">
    <div class="ghead"><h1>Your builds</h1>
      <div class="gseek" ${gearQ ? "" : "hidden"}><div class="seekbar"><input class="gq" aria-label="Search your builds" autocomplete="off" spellcheck="false" value="${gearQ.replace(/"/g, "&quot;")}"></div></div>
    </div>
    <div class="pins mypins">
      ${mine.map(([b, i], r) => buildCard(b, i, r).replace(/<button class="btn[^"]*" data-save="[^"]+">[^<]*<\/button>/, `<button class="btn" data-del="${b.id}">Remove</button>`)
        .replace(/<span class="sticker rank">[^<]*<\/span>/, b.weapon ? `<img class="bweap" src="${wimg(b.weapon)}" alt="">` : "")
        .replace('<article class="tag bcard bcard2', `<article data-q="${buildText(b).replace(/"/g, "&quot;")}" class="tag bcard bcard2`)).join("")}
      <button class="newb" aria-label="New build"><span class="plus">+</span><span>New build</span></button>
    </div>
  </div>`;
  filterGear(false);
  fitMyPins();
}
// show the builds that match gearQ; cards that change fade (out, then gone; or back in), never just vanish
function filterGear(animate = true) {
  const host = document.getElementById("gear"), words = gearQ.toLowerCase().split(/\s+/).filter(Boolean);
  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hits = el => words.every(w => el.dataset.q.includes(w));
  const items = [...host.querySelectorAll(".mypins .bcard2"), host.querySelector(".mypins .newb")].filter(Boolean);
  let any = false;
  for (const el of items) {
    const want = el.classList.contains("newb") ? !words.length : !words.length || hits(el);
    if (want && el.classList.contains("bcard2")) any = true;
    const shown = !el.hidden && !el.dataset.going;
    if (want === shown) continue;
    if (!animate) { el.hidden = !want; delete el.dataset.going; continue; }
    el.getAnimations().forEach(a => a.cancel());
    if (want) {
      el.hidden = false; delete el.dataset.going;
      el.animate(RM ? { opacity: [0, 1] } : { opacity: [0, 1], scale: [.94, 1] }, { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
    } else {
      el.dataset.going = "1";
      el.animate(RM ? { opacity: [1, 0] } : { opacity: [1, 0], scale: [1, .94] }, { duration: 140, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" })
        .finished.then(a => { if (el.dataset.going) { el.hidden = true; delete el.dataset.going; } a.cancel(); }, () => {});
    }
  }
  host.querySelector(".gq")?.classList.toggle("none", !!words.length && !any);
}
function fitMyPins() {                                         // the cards are drawn at 252px and zoomed to their column
  const p = document.querySelector("#gear .mypins"); if (!p || !p.clientWidth) return;
  const gap = parseFloat(getComputedStyle(p).columnGap) || 26;
  p.style.setProperty("--z", ((p.clientWidth - 3 * gap) / 4 / 252).toFixed(4));
  const c = p.querySelector(".bcard2:not([hidden])");
  p.style.setProperty("--bh", (c ? c.getBoundingClientRect().height / (parseFloat(getComputedStyle(document.querySelector("#gear .gl")).zoom) || 1) : 300) + "px");
}
function popGearCard(id) {
  const c = document.querySelector(`#gear .bcard2[data-id="${id}"]`);
  c?.animate({ scale: [.94, 1.04, 1], offset: [0, .6, 1] }, { duration: 340, easing: "cubic-bezier(.2,.8,.2,1)" });
}
(() => {
  const host = document.getElementById("gear"), RM = matchMedia("(prefers-reduced-motion: reduce)");
  const STARTER = ["Hed_FST000", "Clt_FST001", "Shs_FST000"];   // White Headband, Basic Tee, Cream Basics
  const SHUT = "inset(0 -20px 100% -20px)", OPEN = "inset(-20px -20px -400px -20px)";   // as the weapons search tape
  renderGearTab();
  new MutationObserver(() => { if (host.classList.contains("on")) requestAnimationFrame(fitMyPins); }).observe(host, { attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", () => requestAnimationFrame(fitMyPins));
  function seekOpen(first) {
    const box = host.querySelector(".gseek"), input = host.querySelector(".gq"); if (!box) return;
    if (box.hidden || box.dataset.going) {
      delete box.dataset.going; box.hidden = false; box.getAnimations().forEach(a => a.cancel());
      box.animate(RM.matches ? { opacity: [0, 1] } : { clipPath: [SHUT, OPEN], translate: ["0px -10px", "0px 0px"] }, { duration: RM.matches ? 120 : 220, easing: "cubic-bezier(.2,.8,.2,1)" });
      input.value = "";
    }
    input.value += first; input.focus(); gearQ = input.value; filterGear();
  }
  function seekClose() {
    const box = host.querySelector(".gseek"), input = host.querySelector(".gq"); if (!box || box.hidden || box.dataset.going) return;
    box.dataset.going = "1"; input.blur(); gearQ = ""; filterGear();
    box.animate(RM.matches ? { opacity: [1, 0] } : { clipPath: [OPEN, SHUT], translate: ["0px 0px", "0px -10px"], opacity: [1, .4] }, { duration: RM.matches ? 120 : 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" })
      .finished.then(a => { if (box.dataset.going) { box.hidden = true; delete box.dataset.going; input.value = ""; } a.cancel(); }, () => {});
  }
  host.addEventListener("input", e => { if (!e.target.matches(".gq")) return; gearQ = e.target.value; if (!gearQ.trim()) seekClose(); else filterGear(); });
  host.addEventListener("focusout", e => { if (e.target.matches(".gq") && !e.target.value.trim()) seekClose(); });
  document.addEventListener("keydown", e => {
    if (!host.classList.contains("on")) return;
    if (e.key === "Escape" && !host.querySelector(".gseek")?.hidden) { e.preventDefault(); seekClose(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || !/[\p{L}\p{N}]/u.test(e.key) || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    e.preventDefault(); seekOpen(e.key);
  });
  host.addEventListener("click", e => {
    if (e.target.closest(".newb")) {
      ui.ed = { title: "", modes: [], notes: "", weapon: ui.pick, set: STARTER.map(row => [row, "", ["", "", ""]]) };
      ui.edIdx = -1; ui.edKey = null; ui.edFrom = "gear"; ui.sel = [0, -1];
      renderEditor(); show("editor");
      return;
    }
    const x = e.target.closest("[data-edit]");
    if (x) { const k = byKey(x.dataset.edit); if (k < 0) return; ui.edIdx = k; ui.edKey = x.dataset.edit; ui.edFrom = "gear"; ui.ed = JSON.parse(JSON.stringify(BUILDS[k])); renderEditor(); show("editor"); return; }
    const d = e.target.closest("[data-del]");
    const card = !d && e.target.closest(".bcard2");
    if (card) { setPathBuild(+card.dataset.id); renderPath(); show("path"); return; }   // the card itself: its path
    if (d) {                                                    // fade it out, then let the grid close up
      const id = +d.dataset.del, card = d.closest(".bcard2");
      const a = card.animate({ opacity: [1, 0], scale: [1, .92] }, { duration: 200, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
      a.finished.then(() => {
        const k = BUILDS.findIndex(b => b.mine && b.id === id); if (k >= 0) BUILDS.splice(k, 1);
        storeMine(); syncSaved(); renderGearTab();
        document.querySelectorAll("#below [data-save]").forEach(b => { const x = BUILDS[byKey(b.dataset.save)]; if (x) { b.classList.toggle("on", !!x.saved); b.textContent = x.saved ? "Saved" : "Save"; } });
      });
    }
  });
})();

// forward references from earlier modules (they were one shared script scope in v52)
Object.assign(late, { popGearCard, renderGearTab });
