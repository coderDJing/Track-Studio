// Run: node scripts/check-song-list-scroll.mjs
// Exercises the shared virtual rows and their real styles in Electron, with 6810 tracks.
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = process.cwd()
const temp = mkdtempSync(path.join(tmpdir(), 'frkb-song-list-scroll-'))
try {
  await build({
    configFile: false,
    root,
    base: './',
    plugins: [vue()],
    resolve: {
      alias: {
        '@renderer': path.join(root, 'src/renderer/src'),
        '@shared': path.join(root, 'src/shared')
      }
    },
    build: {
      minify: false,
      outDir: temp,
      emptyOutDir: false,
      rollupOptions: {
        input: path.join(root, 'scripts/song-list-scroll-fixture.mjs'),
        output: { entryFileNames: 'fixture.js' }
      }
    }
  })
  const cssLinks = readdirSync(path.join(temp, 'assets'))
    .filter((file) => file.endsWith('.css'))
    .map((file) => '<link rel="stylesheet" href="./assets/' + file + '">')
    .join('')
  writeFileSync(
    path.join(temp, 'fixture.html'),
    `<!doctype html>${cssLinks}<style>
    body { margin: 0 } #app { height: 300px; width: 900px }
    .theme-light { --bg: #eee; --bg-elev: #ddd; --text: #222; --waveform-bg: #d9dee6 }
    .theme-dark { --bg: #222; --bg-elev: #333; --text: #ddd; --waveform-bg: #1e2430 }
  </style><div id="app"></div><script>
    const listeners = new Map();
    window.electron = {ipcRenderer: {
      on(channel, handler) { const set = listeners.get(channel) || new Set(); set.add(handler); listeners.set(channel, set); return () => set.delete(handler) },
      removeListener(channel, handler) { listeners.get(channel)?.delete(handler) },
      async invoke(channel) {
        await new Promise(resolve => setTimeout(resolve, 160));
        if ((channel.endsWith('get-cover-thumb') || channel === 'getSongCoverThumb')) return {dataUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="gray"/></svg>'};
        return {items: []};
      },
      send(channel, payload) {
        if (!channel.endsWith('stream-preview-waveforms')) return;
        payload.analyzePaths.forEach((analyzePath, index) => setTimeout(() => {
          listeners.get('rekordbox-desktop-library:preview-waveform-item')?.forEach(handler => handler(null, {requestId: payload.requestId, analyzePath, data: {style: 'blue', maxHeight: 31, columnCount: 400, columns: Array.from({length: 400}, (_, i) => ({backHeight: 10 + i % 21, frontHeight: 6, color: 3}))}}));
        }, 120 + index * 8));
        setTimeout(() => listeners.get('rekordbox-desktop-library:preview-waveform-done')?.forEach(handler => handler(null, {requestId: payload.requestId})), 700);
      }
    }};
  </script><script type="module" src="./fixture.js"></script>`
  )
  writeFileSync(
    path.join(temp, 'main.cjs'),
    `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(temp)});
    app.whenReady().then(async () => {
      const window = new BrowserWindow({show: false, webPreferences: {backgroundThrottling: false, offscreen: true}});
      try {
        await window.loadFile(${JSON.stringify(path.join(temp, 'fixture.html'))});
        window.webContents.debugger.attach('1.3');
        await window.webContents.debugger.sendCommand('Profiler.enable');
        await window.webContents.debugger.sendCommand('Profiler.start');
        console.log(await window.webContents.executeJavaScript('window.checkScroll()'));
        const {profile} = await window.webContents.debugger.sendCommand('Profiler.stop');
        const counts = new Map();
        const nodes = new Map(profile.nodes.map(node => [node.id, node]));
        for (const id of profile.samples || []) {
          const node = nodes.get(id);
          const name = node?.callFrame.functionName || '(anonymous)';
          counts.set(name, (counts.get(name) || 0) + 1);
        }
        console.log('CPU samples:', [...counts].filter(([name]) => name !== '(idle)').sort((a,b) => b[1] - a[1]).slice(0, 18));
        await window.webContents.executeJavaScript('window.resetScrollTop()');
        await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type: 'mouseMoved', x: 105, y: 150});
        for (let i = 0; i < 35; i++) {
          const before = await window.webContents.executeJavaScript('window.readScrollTop()');
          await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type: 'mouseWheel', x: 105, y: 150, deltaY: 120, deltaX: 0});
          await new Promise(resolve => setTimeout(resolve, 100));
          const after = await window.webContents.executeJavaScript('window.readScrollTop()');
          if (after <= before) throw new Error('Wheel ' + i + ': ' + before + ' -> ' + after);
        }
        console.log('35 real downward wheel events passed');
        const pending = [];
        for (let i = 0; i < 60; i++) {
          pending.push(window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type: 'mouseWheel', x: 700, y: 150, deltaY: 200, deltaX: 0}));
          await new Promise(resolve => setTimeout(resolve, 12));
        }
        await Promise.all(pending);
        await new Promise(resolve => setTimeout(resolve, 1200));
        console.log('Rapid wheel snapshot:', await window.webContents.executeJavaScript('JSON.stringify(window.readListSnapshot())'));
        console.log(await window.webContents.executeJavaScript('window.checkColumnReorder()'));
        app.exit(0);
      } catch (error) { console.error(error.message); app.exit(1); }
    });
  `
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [path.join(temp, 'main.cjs')], {
    cwd: root,
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60000
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  if (
    path.dirname(temp) !== path.resolve(tmpdir()) ||
    !path.basename(temp).startsWith('frkb-song-list-scroll-')
  ) {
    throw new Error('Unexpected scroll fixture directory')
  }
  rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 })
}
