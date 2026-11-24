// The editor's "Copy outfit": what the Splatoon avatar wears now, read off the Switch by the companion (GET /api/wearing),
// put into the build's three gear rows only: the build's abilities (mains, subs) and weapon stay as they are (Alex, 2026-11-21). Disabled, with the reason as its title, while
// there is no Switch to ask or the companion can't tell what's worn (no toast: the button itself says so).
import { live, subscribe } from "./live";
import { ui } from "./state";

const SLOTS = ["head", "clothes", "shoes"];
let busy = false;
let blocked = "";                 // why the last try failed, until the Switch's status changes (or a moment, when it was only busy)
let dotT = 0, dotN = 0, failT = 0, clearT = 0;

export function copyState(): { disabled: boolean; title: string; busy?: boolean } {
  if (busy) return { disabled: true, busy: true, title: "Reading the Switch" };
  if (live.reachable === false) return { disabled: true, title: "The companion isn't running" };
  const st = live.status.botbase;
  if (!st || st.state !== "ok") return { disabled: true, title: "Needs the Switch connected" + (st?.message ? " (" + st.message + ")" : "") };
  if (blocked) return { disabled: true, title: blocked };
  return { disabled: false, title: "Use the gear your Splatoon avatar is wearing now (the abilities stay)" };
}
export function resetCopyFailure() {
  clearTimeout(failT); clearTimeout(clearT); failT = clearT = 0;
  const b = document.querySelector<HTMLButtonElement>("#editor #copyfit"), line = document.querySelector<HTMLElement>("#editor .cfw .why");
  b?.classList.remove("fail");
  if (line) line.textContent = "";
}
export function paintCopy() {
  const b = document.querySelector<HTMLButtonElement>("#editor #copyfit");
  if (!b) return;
  const s = copyState();
  b.disabled = s.disabled;
  if (s.title) b.dataset.tip = s.title; else delete b.dataset.tip;
  b.classList.toggle("busy", !!s.busy); b.setAttribute("aria-busy", s.busy ? "true" : "false");
  const dots = document.querySelector<HTMLElement>("#editor #cfdots");
  if (s.busy) {
    if (dots && !dotT) {
      if (still()) dots.textContent = "...";
      else { dotN = 0; dots.textContent = "."; dotT = window.setInterval(() => { dots.textContent = ".".repeat(++dotN % 3 + 1); }, 350); }
    }
  } else if (dotT) {
    clearInterval(dotT); dotT = 0;
  }
}
subscribe(ev => { if (ev === "state" || ev === "status" || ev === "reachable") { blocked = ""; paintCopy(); } });

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("st-still");
const STEP = 60, POP = 130;   // gear slots swap head, clothes, shoes 60 ms apart, each 130 ms: ~250 ms in all

/** After the redraw: a slot that changed pops in (fades only with reduced motion); one that already had that gear gets a brief yellow ring. */
function showResult(changed: boolean[]) {
  const RM = still();
  document.querySelectorAll<HTMLElement>("#editor .piece .gp").forEach((el, i) => {
    const delay = i * STEP;
    if (changed[i]) el.animate(RM ? { opacity: [0, 1] } : { opacity: [0, 1], scale: [.8, 1] }, { duration: RM ? 160 : POP, delay: RM ? 0 : delay, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    else {
      const ring = (a: number) => `0 0 0 4px rgba(234,255,61,${a}), 0 0 0 7px rgba(17,17,17,${a})`;
      el.animate({ boxShadow: [ring(0), ring(1), ring(0)], offset: [0, .3, 1] }, { duration: RM ? 400 : 420, delay: RM ? 0 : delay, easing: "ease-out", fill: "backwards" });
    }
  });
}

/** The reason beside Copy outfit (gear14 .why): fades in, stays ~3 s, fades out; the button shakes (no shake with reduced motion). */
function showFailure(msg: string) {
  const b = document.querySelector<HTMLButtonElement>("#editor #copyfit"), line = document.querySelector<HTMLElement>("#editor .cfw .why");
  clearTimeout(failT); clearTimeout(clearT); failT = clearT = 0;
  if (line) line.textContent = msg;
  if (b) {
    b.classList.remove("fail");
    void b.offsetWidth;
    b.classList.add("fail");
    failT = window.setTimeout(() => {
      failT = 0;
      b.classList.remove("fail");
      clearT = window.setTimeout(() => { clearT = 0; if (line && line.textContent === msg) line.textContent = ""; }, 200);
    }, 3000);
  }
}

/** Fetch what's worn and put it in ui.ed.set; redraw() repaints the editor. */
export async function copyOutfit(redraw: () => void) {
  if (busy) return;
  const ed = ui.ed;
  resetCopyFailure();
  busy = true; paintCopy();
  let changed: boolean[] | null = null, said = "";
  try {
    const r = await fetch("/api/wearing", { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { blocked = said = d?.error || "Couldn't read what you're wearing"; if (r.status === 503) setTimeout(() => { blocked = ""; paintCopy(); }, 3000); return; }
    const worn = SLOTS.map(k => d?.[k]);
    if (worn.some(p => !p || typeof p.row !== "string")) { blocked = said = "The companion sent no outfit"; return; }
    if (ui.ed !== ed) return;                                  // another build was opened meanwhile: leave it alone
    changed = worn.map((p, i) => ed.set?.[i]?.[0] !== p.row);
    ed.set = worn.map((p, i) => { const [, main, subs] = ed.set?.[i] || []; return [p.row, main || "", [0, 1, 2].map(k => (subs || [])[k] || "")]; });
    redraw();
  } catch {
    blocked = said = "The companion didn't answer";
  } finally {
    busy = false; paintCopy();
    if (ui.ed === ed) { if (changed) showResult(changed); else if (said) showFailure(said); }   // (in finally: the early returns above come through here too)
  }
}
