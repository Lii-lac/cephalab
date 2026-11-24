// Dev server: GET /img/<kind>/<name>.<ext> from cache/img/<kind>/<name>.<ext>, fetched once on a miss
// (tmp file then rename, as tracker.py image()). The app never asks any other host for an image.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const LEANNY = "https://leanny.github.io/splat3/images";
// kind -> [upstream base, extension]: <base>/<kind>/<name>.<ext> on Leanny's CDN; sendou's mode icons (the build
// cards' mode stamps) are <base>/<name>.avif.
export const IMG_KINDS: Record<string, [string, string]> = {
  skill: [LEANNY, "png"], gear: [LEANNY, "png"], weapon_flat: [LEANNY, "png"], brand: [LEANNY, "png"],
  subspe: [LEANNY, "png"], weapon_type: [LEANNY, "png"], zakka: [LEANNY, "png"], misc: [LEANNY, "png"],
  modes: ["https://sendou-assets.nyc3.cdn.digitaloceanspaces.com/img/modes", "avif"],
};
const TYPES: Record<string, string> = { png: "image/png", avif: "image/avif" };
const ROUTE = /^\/img\/([a-z_]+)\/([A-Za-z0-9_]{1,80})\.([a-z]+)$/;

export function cachedImage(cacheDir: string, kind: string, name: string, ext: string, pending = new Map<string, Promise<Buffer | null>>()): Promise<Buffer | null> | null {
  const k = IMG_KINDS[kind];
  if (!k || k[1] !== ext || !/^[A-Za-z0-9_]{1,80}$/.test(name)) return null;
  const file = path.join(cacheDir, kind, `${name}.${ext}`);
  if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file));
  const key = `${kind}/${name}`;
  if (missing.has(key)) return Promise.resolve(null);
  if (!pending.has(key)) pending.set(key, (async () => {
    await slot();
    try {
      for (let attempt = 0; ; attempt++) {                    // the CDN answers 503 when asked for many at once
        let status = 0;
        try {
          const r = await fetch(`${k[0]}/${kind === "modes" ? "" : kind + "/"}${name}.${ext}`, { headers: { "User-Agent": "Cephalab" }, signal: AbortSignal.timeout(10000) });
          status = r.status;
          if (r.ok) {
            const data = Buffer.from(await r.arrayBuffer());
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, data);
            fs.renameSync(tmp, file);
            return data;
          }
        } catch {}
        // GitHub Pages also answers a burst with the odd 404, so a 404 is only believed after the retries
        if (attempt >= 3) { console.warn(`[img] ${key}: ${status || "no answer"}`); if (status === 404) missing.add(key); return null; }
        await new Promise(ok => setTimeout(ok, 400 * 2 ** attempt));
      }
    } finally { pending.delete(key); free(); }
  })());
  return pending.get(key)!;
}
const missing = new Set<string>();                           // really not there (until the server restarts)
// at most 4 upstream fetches at a time
let busy = 0;
const waiting: (() => void)[] = [];
const slot = () => new Promise<void>(ok => { if (busy < 4) { busy++; ok(); } else waiting.push(() => { busy++; ok(); }); });
const free = () => { busy--; waiting.shift()?.(); };

export function imgPlugin(cacheDir: string): Plugin {
  const pending = new Map<string, Promise<Buffer | null>>();
  return {
    name: "cephalab-img",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (!url.startsWith("/img/")) return next();
        const m = url.match(ROUTE), got = m && req.method === "GET" ? cachedImage(cacheDir, m[1], m[2], m[3], pending) : null;
        if (!got) { res.statusCode = 404; res.end(); return; }
        got.then(data => {
          if (!data) { res.statusCode = 404; res.end(); return; }
          res.setHeader("Content-Type", TYPES[m![3]]);
          res.setHeader("Cache-Control", "max-age=86400");
          res.end(data);
        });
      });
    },
  };
}
