// The Settings screen: the approved board design (web/mockups/settings.html) wired to the companion. This file mounts the markup and
// the category stickers; each category's behaviour lives in settings/ (connections, nintendo, builds, display, data).
// mountSettings(host) builds it once; refreshSettings() re-reads the companion when the screen is shown.
import "./styles/signin.css";
import "./styles/settings.css";
import { SETTINGS_HTML } from "./settings/markup";
import { $$ } from "./settings/dom";
import { loadCfg } from "./settings/cfg";
import { mountSwitch } from "./settings/connections";
import { mountNintendo, refreshNintendo } from "./settings/nintendo";
import { mountBuilds, paintCount } from "./settings/builds";
import { mountDisplay, fitSoon } from "./settings/display";
import { mountData } from "./settings/data";
import { mountUpdates, refreshUpdates } from "./settings/updates";
import { beadSquid } from "./beadsquid";
import { late } from "./late";

const shownNow = () => !!document.getElementById("settings")?.classList.contains("on");
/** Our squid points at the chosen sticker (it lives on the Weapons beads otherwise); it hops when the choice moves. */
function squidTo(cat: HTMLElement | null | undefined, hop: boolean) {
  if (!cat) return;
  const holder = document.querySelector<HTMLElement>(".bead-squid"), from = hop ? holder?.getBoundingClientRect() : undefined;
  beadSquid(cat);
  if (hop) late.MO?.hop(holder, from);
}

let mounted = false;

/** The stickers pick which page the paper shows (the pages crossfade in one grid cell). */
function mountCategories() {
  const cats = $$(".st-cat"), pages = $$(".st-pg");
  const menu = document.querySelector<HTMLElement>("#settings .st-menu")!;
  const pick = (cat: string, focus = false) => {
    const h0 = menu.offsetHeight;
    for (const c of cats) { const on = c.dataset.cat === cat; c.classList.toggle("on", on); c.setAttribute("aria-selected", String(on)); c.tabIndex = on ? 0 : -1; if (on && focus) c.focus(); }
    for (const p of pages) { const on = p.dataset.cat === cat; p.classList.toggle("on", on); p.toggleAttribute("inert", !on); }
    if (shownNow()) {
      squidTo(cats.find(c => c.dataset.cat === cat), true);
      const h1 = menu.offsetHeight;                  // the board grows or shrinks to the new page, never a jump
      if (h0 && h0 !== h1 && !document.documentElement.classList.contains("st-still") && !matchMedia("(prefers-reduced-motion: reduce)").matches)
        menu.animate({ height: [h0 + "px", h1 + "px"] }, { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  };
  cats.forEach((c, i) => {
    (c as HTMLButtonElement).type = "button";
    c.addEventListener("click", () => pick(c.dataset.cat!));
    c.addEventListener("keydown", e => {
      const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key];
      if (step) { e.preventDefault(); pick(cats[(i + step + cats.length) % cats.length].dataset.cat!, true); }
    });
  });
  pick("connections");
}

export function mountSettings(host: HTMLElement) {
  host.innerHTML = SETTINGS_HTML;
  mounted = true;
  mountCategories();
  mountSwitch(); mountNintendo(); mountBuilds(); mountData(); mountUpdates(); mountDisplay();
}

export function refreshSettings() {
  if (!mounted) return;
  squidTo(document.querySelector<HTMLElement>(".st-cat.on"), false);
  fitSoon();
  paintCount();
  loadCfg().then(() => { refreshNintendo(); refreshUpdates(); });
}
