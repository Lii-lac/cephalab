// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "zoom"); behaviour must match v52.

/* v52 (Alex): the build editor and the builds path scale with the window instead of sitting at a fixed width with dead
   space beside them. Each screen's content is zoomed: the path by the window's width (it scrolls anyway), the editor by
   whichever of width and height runs out first, so it still fits one screen; its grid then stretches across whatever
   width is left. Laid out for 1280 / 1360px of content, i.e. a 1440px-wide window. */
(() => {
  const ED_W = 1800, ED_H = 847, clamp = z => Math.max(.75, Math.min(2.2, z)), clampEd = z => Math.max(.5, Math.min(1, z));
  function fit() {
    // Alex: "too zoomed in, add more padding". Path/Gear are the 1440x900 layout (1344px of content), scaled by
    // whichever of width and height runs out first and centred: the side padding is whatever is left either side.
    // The gear14 build editor is laid out for 1800x847 under the header and scales down cleanly below that.
    const z = clamp(Math.min(innerWidth / 1440, innerHeight / 900)), side = Math.round(Math.max(48, (innerWidth - 1344 * z) / 2));
    const root = document.documentElement.style;
    root.setProperty("--side", side + "px");
    root.setProperty("--zpl", z.toFixed(4));
    const head = document.querySelector("header");
    const top = head ? head.getBoundingClientRect().bottom : 54;
    root.setProperty("--zed", clampEd(Math.min(innerWidth / ED_W, (innerHeight - top) / ED_H)).toFixed(4));
  }
  let q = 0;
  const soon = () => { if (!q) q = requestAnimationFrame(() => { q = 0; fit(); }); };
  addEventListener("resize", soon);
  const mo = new MutationObserver(soon);
  for (const id of ["editor", "path"]) mo.observe(document.getElementById(id), { attributes: true, attributeFilter: ["class"] });
  fit();
})();
