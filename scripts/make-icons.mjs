// Renders the app icons from build/icon.svg. Run with Electron (it draws the SVG with
// Chromium), on macOS for the .icns:
//
//   npx electron scripts/make-icons.mjs
//
// Writes build/icon.png (1024 px, full artwork, for Windows; electron-builder makes the
// .ico from it) and build/icon.icns (macOS, the artwork inside Apple's icon grid: 824 px
// on a 1024 px canvas, so it matches the size of the other icons in the Dock).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';

const BUILD = path.join(import.meta.dirname, '..', 'build');
const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');

/** A PNG of the SVG drawn at `artwork` px, centered on a transparent `size` px canvas. */
async function render(win, size, artwork) {
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const dataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = ${size};
        canvas.height = ${size};
        const context = canvas.getContext('2d');
        const offset = (${size} - ${artwork}) / 2;
        context.drawImage(image, offset, offset, ${artwork}, ${artwork});
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => reject(new Error('The SVG could not be drawn'));
      image.src = ${JSON.stringify(source)};
    })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');

  fs.writeFileSync(path.join(BUILD, 'icon.png'), await render(win, 1024, 1024));
  console.log('build/icon.png');

  if (process.platform === 'darwin') {
    const iconset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'icons-')), 'icon.iconset');
    fs.mkdirSync(iconset);
    for (const base of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const size = base * scale;
        const name = scale === 1 ? `icon_${base}x${base}.png` : `icon_${base}x${base}@2x.png`;
        fs.writeFileSync(path.join(iconset, name), await render(win, size, (size * 824) / 1024));
      }
    }
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(BUILD, 'icon.icns')]);
    fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
    console.log('build/icon.icns');
  } else {
    console.log('build/icon.icns is only made on macOS (iconutil)');
  }
  app.quit();
});
