// Rasterise build/icon.svg to build/icon.png (1024x1024, transparent background) with Electron's renderer,
// then write build/icon-preview.png showing it at Dock sizes on dark and light backgrounds.
// Usage: npx electron scripts/render-icon.js   (exit code 1 if the background is not transparent)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const outPath = path.join(buildDir, 'icon.png');
const previewPath = path.join(buildDir, 'icon-preview.png');

async function load(win, name, html) {
  const tmp = path.join(buildDir, name);
  fs.writeFileSync(tmp, html);
  try {
    await win.loadFile(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
  await new Promise((r) => setTimeout(r, 500));
}

app.whenReady().then(async () => {
  const PAD = 8; // the window's outermost pixels can pick up edge artefacts, so render inside a margin and crop it off
  const win = new BrowserWindow({ width: 1024 + PAD * 2, height: 1024 + PAD * 2, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`did-fail-load ${code} ${desc} ${url}`));

  const svg = fs.readFileSync(svgPath, 'utf8');
  await load(win, '.render-icon.html', `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:transparent}body{padding:${PAD}px}svg{display:block}</style></head><body>${svg}</body></html>`);
  let icon = await win.webContents.capturePage({ x: PAD, y: PAD, width: 1024, height: 1024 });
  if (icon.getSize().width !== 1024) icon = icon.resize({ width: 1024, height: 1024 });
  fs.writeFileSync(outPath, icon.toPNG());
  const bmp = icon.toBitmap();
  const alpha = (x, y) => bmp[(y * 1024 + x) * 4 + 3];
  const edges = [alpha(0, 0), alpha(1023, 0), alpha(0, 1023), alpha(1023, 1023), alpha(1023, 512), alpha(512, 1023), alpha(60, 512)];
  const ok = edges.every((a) => a === 0) && alpha(512, 512) === 255;
  console.log(`icon.png: edge alphas=[${edges.join(',')}] centre alpha=${alpha(512, 512)} -> ${ok ? 'transparent background OK' : 'BACKGROUND NOT TRANSPARENT'}`);

  await load(win, '.render-preview.html', `<!doctype html><html><body style="margin:0;overflow:hidden;background:#2a2a2e;display:flex;align-items:center;gap:40px;padding:0 40px;width:520px;height:220px">
    <img src="icon.png" width="128" height="128"><img src="icon.png" width="64" height="64"><img src="icon.png" width="32" height="32"><img src="icon.png" width="16" height="16">
    <div style="background:#f2f2f2;padding:20px;border-radius:12px;margin-left:auto"><img src="icon.png" width="128" height="128" style="display:block"></div></body></html>`);
  let preview = await win.webContents.capturePage({ x: 0, y: 0, width: 600, height: 220 });
  if (preview.getSize().width !== 600) preview = preview.resize({ width: 600, height: 220 });
  fs.writeFileSync(previewPath, preview.toPNG());
  console.log(`preview: ${previewPath}`);
  app.exit(ok ? 0 : 1);
});
