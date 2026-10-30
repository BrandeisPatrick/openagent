// Globals set by the vendored xterm.js UMD builds that index.html loads before renderer.js
// (vendor/xterm.js, vendor/addon-fit.js, vendor/addon-web-links.js, copied from node_modules by `npm run build`).
// Types only: nothing is imported at runtime. Optional because a build without the vendor folder has none of them.

declare global {
  interface Window {
    Terminal?: typeof import('@xterm/xterm').Terminal;
    FitAddon?: { FitAddon: typeof import('@xterm/addon-fit').FitAddon };
    WebLinksAddon?: { WebLinksAddon: typeof import('@xterm/addon-web-links').WebLinksAddon };
  }
}

export {};
