// One shared themed tooltip for every [data-tip] element across the app (replaces native title).
const DELAY = 300, WARM = 300, PAD = 8, GAP = 8;
let el: HTMLDivElement | null = null;
let cur: HTMLElement | null = null;
let hoverCur: HTMLElement | null = null;
let focusCur: HTMLElement | null = null;
let timer = 0, warmUntil = 0, downAt = -1e9;
let overTip = false;

function tipEl(): HTMLDivElement {
  if (el) return el;
  el = document.createElement("div");
  el.className = "tip";
  el.setAttribute("role", "tooltip");
  el.setAttribute("aria-hidden", "true");
  document.body.append(el);
  return el;
}

const mo = new MutationObserver(() => {
  if (hoverCur && !hoverCur.isConnected) hoverCur = null;
  if (focusCur && !focusCur.isConnected) focusCur = null;
  if (!cur) return;
  if (!cur.isConnected) return hide(false);
  const text = cur.getAttribute("data-tip") || "";
  if (!text) return hide(false);
  const t = tipEl();
  if (t.classList.contains("on") && t.textContent !== text) { t.textContent = text; place(cur); }
});

function place(target: HTMLElement) {
  const t = tipEl(), r = target.getBoundingClientRect();
  if (!r.width && !r.height) return;
  const w = t.offsetWidth, h = t.offsetHeight;
  const x = Math.round(Math.max(PAD, Math.min(innerWidth - w - PAD, (r.left + r.right - w) / 2)));
  const aboveY = r.top - h - GAP, belowY = r.bottom + GAP;
  const below = aboveY < PAD && (belowY + h <= innerHeight - PAD || innerHeight - r.bottom > r.top);
  const y = Math.round(below ? Math.min(innerHeight - h - PAD, belowY) : Math.max(PAD, aboveY));
  t.style.setProperty("--tx", `${x}px`);
  t.style.setProperty("--ty", `${y}px`);
}

function show(target: HTMLElement) {
  clearTimeout(timer); timer = 0;
  const text = target.getAttribute("data-tip") || "";
  if (!text || !target.isConnected) return hide(false);
  const t = tipEl();
  const was = t.classList.contains("on") || performance.now() <= warmUntil;
  cur = target;
  mo.disconnect();
  mo.observe(document.body, { childList: true, subtree: true });
  mo.observe(target, { attributes: true, attributeFilter: ["data-tip"] });
  if (!was) t.style.transition = "none";
  t.textContent = text;
  place(target);
  void t.offsetWidth;
  if (!was) t.style.transition = "";
  t.classList.add("on");
  t.setAttribute("aria-hidden", "false");
}

function hide(warm = true) {
  clearTimeout(timer); timer = 0;
  mo.disconnect();
  const t = el;
  if (t?.classList.contains("on") && warm) warmUntil = performance.now() + WARM;
  else if (!warm) warmUntil = 0;
  cur = null;
  overTip = false;
  if (!t) return;
  t.classList.remove("on");
  t.setAttribute("aria-hidden", "true");
}

function inRect(r: DOMRect, x: number, y: number, pad = 2): boolean {
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

// Keep a visible tooltip open while the pointer rests on the tooltip itself or crosses the trapezoid gap between target and tooltip.
function inTipZone(x: number, y: number): boolean {
  if (!el || !cur || !el.classList.contains("on")) return false;
  const T = el.getBoundingClientRect();
  if (!T.width && !T.height) return false;
  if (inRect(T, x, y, 2)) return true;
  const R = cur.getBoundingClientRect();
  if (!R.width && !R.height) return false;
  if (T.bottom <= R.top + 2 && y >= T.bottom - 2 && y <= R.top + 2) {
    const t = Math.max(0, Math.min(1, (R.top - y) / Math.max(1, R.top - T.bottom)));
    const left = R.left + (T.left - R.left) * t - 4;
    const right = R.right + (T.right - R.right) * t + 4;
    return x >= left && x <= right;
  }
  if (T.top >= R.bottom - 2 && y >= R.bottom - 2 && y <= T.top + 2) {
    const t = Math.max(0, Math.min(1, (y - R.bottom) / Math.max(1, T.top - R.bottom)));
    const left = R.left + (T.left - R.left) * t - 4;
    const right = R.right + (T.right - R.right) * t + 4;
    return x >= left && x <= right;
  }
  return false;
}

const tipped = (n: EventTarget | null): HTMLElement | null => {
  const node = n instanceof Element ? n : null;
  const hit = node?.closest?.("[data-tip]") as HTMLElement | null;
  return hit && hit.getAttribute("data-tip") ? hit : null;
};

// Disabled controls swallow pointer events onto their parent; check their rects directly.
function disabledTip(e: PointerEvent): HTMLElement | null {
  const node = e.target instanceof Element ? e.target : null;
  const list = node?.querySelectorAll?.("[disabled][data-tip]");
  if (!list?.length) return null;
  for (const d of list) {
    const t = d.getAttribute("data-tip");
    if (!t) continue;
    const r = d.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return d as HTMLElement;
  }
  return null;
}

function delayFor(hit: HTMLElement): number {
  const raw = hit.getAttribute("data-tip-delay");
  if (raw == null || raw === "") return DELAY;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DELAY;
}

function enter(hit: HTMLElement | null) {
  if (hit === hoverCur) return;
  hoverCur = hit;
  clearTimeout(timer); timer = 0;
  if (!hit) { if (!focusCur) hide(true); return; }
  const d = delayFor(hit);
  if (d <= DELAY && (el?.classList.contains("on") || performance.now() <= warmUntil)) show(hit);
  else {
    if (d > DELAY && el?.classList.contains("on")) hide(false);
    timer = window.setTimeout(() => { if (hoverCur === hit) show(hit); }, d);
  }
}

document.addEventListener("pointerover", e => {
  if (e.pointerType === "touch") return;
  const hit = tipped(e.target) || disabledTip(e);
  if (cur && el?.classList.contains("on") && (overTip || !hit) && inTipZone(e.clientX, e.clientY)) {
    overTip = true;
    return;
  }
  overTip = false;
  enter(hit);
});

document.addEventListener("pointermove", e => {
  if (e.pointerType === "touch") return;
  if (overTip) {
    if (cur && el?.classList.contains("on")) {
      if (inRect(cur.getBoundingClientRect(), e.clientX, e.clientY, 0)) { overTip = false; hoverCur = cur; return; }
      if (inTipZone(e.clientX, e.clientY)) return;
    }
    overTip = false;
    const hit = tipped(e.target) || disabledTip(e);
    if (hit && hit !== cur) enter(hit);
    else { hoverCur = null; if (!focusCur) hide(true); }
    return;
  }
  const node = e.target instanceof Element ? e.target : null;
  if (!node?.querySelector?.("[disabled][data-tip]")) return;
  const hit = tipped(e.target) || disabledTip(e);
  if (!hit && cur && el?.classList.contains("on") && inTipZone(e.clientX, e.clientY)) { overTip = true; return; }
  enter(hit);
});

document.addEventListener("pointerout", e => {
  if (!hoverCur) return;
  const next = tipped(e.relatedTarget);
  if (next === hoverCur) return;
  if (cur && el?.classList.contains("on") && inTipZone(e.clientX, e.clientY)) { overTip = true; return; }
  if (next) return;            // pointerover on next swaps directly without hiding
  hoverCur = null;
  if (!focusCur) hide(true);
});

document.addEventListener("pointerleave", () => {
  if (!overTip) return;
  overTip = false;
  hoverCur = null;
  if (!focusCur) hide(true);
});

document.addEventListener("pointerdown", () => { downAt = performance.now(); if (cur || timer) hide(false); }, true);

document.addEventListener("focusin", e => {
  const hit = tipped(e.target);
  if (!hit || performance.now() - downAt < 300) return;
  focusCur = hit;
  show(hit);
});

document.addEventListener("focusout", e => {
  if (!focusCur) return;
  const next = tipped(e.relatedTarget);
  if (next === focusCur) return;
  focusCur = null;
  if (hoverCur) show(hoverCur);
  else hide(false);
});

addEventListener("scroll", () => { if (cur || timer) hide(false); }, true);
addEventListener("resize", () => { if (cur && el?.classList.contains("on")) place(cur); });
addEventListener("keydown", e => { if (e.key === "Escape" && (cur || timer)) hide(false); }, true);
