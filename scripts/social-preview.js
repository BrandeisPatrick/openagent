// Renders docs/social-preview.png (1280×640), the card GitHub shows when the repository link is shared.
// Upload it under Settings → General → Social preview. Run: npx electron scripts/social-preview.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const b64 = (p) => fs.readFileSync(path.join(root, p)).toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: 1280px; height: 640px; overflow: hidden; background: #262624; color: #faf9f5;
  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif; }
.text { position: absolute; left: 72px; top: 96px; width: 540px; }
.brand { display: flex; align-items: center; gap: 20px; }
.brand img { width: 76px; height: 76px; border-radius: 19px; }
h1 { font-size: 60px; margin: 0; font-weight: 700; letter-spacing: -0.02em; }
p { font-size: 25px; line-height: 1.35; margin: 30px 0 0; color: #c9c7bd; }
.tags { margin-top: 30px; display: flex; flex-wrap: wrap; gap: 10px; }
.tag { font-size: 17px; padding: 7px 13px; border: 1px solid #4a4845; border-radius: 999px; color: #ebe9df; }
.shot { position: absolute; left: 660px; top: 84px; width: 920px; border-radius: 14px; border: 1px solid #3a3835;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55); }
</style></head><body>
<div class="text">
  <div class="brand"><img src="data:image/png;base64,${b64('build/icon.png')}"><h1>OpenAgent</h1></div>
  <p>An open-source, Claude Code–style coding agent for macOS. Local models through Ollama, any provider through Portkey.</p>
  <div class="tags"><span class="tag">Built-in browser</span><span class="tag">MCP</span><span class="tag">Plan mode</span><span class="tag">Rewind</span><span class="tag">Terminal</span><span class="tag">Diff</span></div>
</div>
<img class="shot" src="data:image/png;base64,${b64('docs/screenshots/hero.png')}">
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 640, show: false, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 1000));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 640 });
  const out = path.join(root, 'docs', 'social-preview.png');
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out, JSON.stringify(img.getSize()));
  app.quit();
});
