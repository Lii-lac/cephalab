// True in the static build (npm run build:static): vite's `define` sets __STATIC__. There is no companion then, so nothing asks /api.
declare const __STATIC__: boolean | undefined;
export const STATIC = typeof __STATIC__ !== "undefined" && __STATIC__;
