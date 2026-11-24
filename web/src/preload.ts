// Weapon images without pop-in: warms the browser's cache (and the companion's, which fetches each game image once
// from Leanny's CDN) before the strip or the preview needs them. Order: the first weapon of every class (what a
// class switch shows), then the weapons around wherever the strip is heading (as soon as a flick or a chevron
// picks its target), then every other weapon while the page is idle (163 images, ~3 MB).
const seen = new Map<string, HTMLImageElement>();    // kept, so a decoded image stays decoded
const urgent: string[] = [], later: string[] = [];
let active = 0, idleQueued = false;
const MAX = 4;                                         // at once: enough to stay ahead of a flick, light on the companion

function pump(idle = false) {
  while (active < MAX) {
    const isLater = !urgent.length;
    const url = isLater ? (idle ? later.shift() : undefined) : urgent.shift();
    if (url === undefined) break;
    if (seen.has(url)) continue;
    const im = new Image();
    im.decoding = "async";
    im.src = url;
    seen.set(url, im);
    active++;
    const end = () => { active--; pump(isLater); };     // the idle batch keeps going; urgent loads still cut in first
    im.decode().then(end, end);                        // a missing image just ends; the page shows what it can
  }
  if (!idle && !urgent.length && later.length && !idleQueued) {
    idleQueued = true;                                 // the rest only when the page has nothing better to do
    const go = () => { idleQueued = false; pump(true); };
    "requestIdleCallback" in window ? (window as any).requestIdleCallback(go, { timeout: 2000 }) : setTimeout(go, 200);
  }
}

/** Load these soon (urgent: before anything already waiting, nearest first). */
export function warm(urls: string[], now = false) {
  const fresh = urls.filter(u => u && !seen.has(u));
  if (now) {
    for (const u of fresh) { const i = urgent.indexOf(u); if (i >= 0) urgent.splice(i, 1); }
    urgent.unshift(...fresh);
  } else {
    for (const u of fresh) if (!later.includes(u) && !urgent.includes(u)) later.push(u);
  }
  pump();
}
