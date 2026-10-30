// electron-builder afterPack hook: ad-hoc signs the packaged app.
// Packaging skips real signing (no Developer ID), which leaves the bundle with a broken signature: Electron's binary
// is linker-signed, but the renamed bundle's resources are not sealed. A browser-downloaded copy is then rejected
// by Gatekeeper as "damaged". An ad-hoc signature over the whole bundle makes it valid, so macOS only reports that
// the app is not notarized, which the user can allow in System Settings → Privacy & Security → Open Anyway.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed  ${path.basename(app)}`);
};
