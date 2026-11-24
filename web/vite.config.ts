import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { imgPlugin } from "./img-plugin.ts";

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, "..");

// the core's tag in a saved plan's key (plan-cache.ts): a rebuilt core.wasm never shows an old route
let coreHash = "nocore";
try { coreHash = crypto.createHash("sha1").update(fs.readFileSync(path.join(repo, "core", "dist", "core.wasm"))).digest("hex").slice(0, 12); } catch {}

// the static build (--mode static): the game images are files beside index.html, so every /img/ path becomes ./img/
function relativeImg(): Plugin {
  return {
    name: "cephalab-relative-img",
    transform(code, id) {
      if (!/[\/]src[\/]data\.ts$/.test(id)) return null;           // L and MODE in data.ts build every image path
      return code.replace('export const L = "/img";', 'export const L = "./img";').replace("`/img/modes/", "`./img/modes/");
    },
  };
}

export default defineConfig(({ mode }) => {
  const stat = mode === "static";
  return {
    base: stat ? "./" : "/",
    define: { __STATIC__: JSON.stringify(stat), __CORE_HASH__: JSON.stringify(coreHash) },
    server: {
      port: 5173,
      strictPort: true,
      fs: { allow: [repo] },                                   // assets/ lives beside web/
      proxy: { "/api": `http://127.0.0.1:${process.env.COMPANION_PORT || 8765}` },   // the companion (COMPANION_PORT if it runs elsewhere)
    },
    // static: flat output (assetsDir ""), because a url() in a CSS custom property resolves against the page, so css and images sit in index.html's folder
    build: { target: "es2022", assetsInlineLimit: 0, ...(stat ? { outDir: "dist-static", emptyOutDir: true, assetsDir: "" } : {}) },
    worker: { format: "es" },                                  // core.mjs is an ES module (import.meta.url) and the core worker is a module worker
    plugins: [imgPlugin(path.join(repo, "cache", "img")), ...(stat ? [relativeImg()] : [])],
  };
});
