import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const folder = path.dirname(fileURLToPath(import.meta.url))
async function connect(port, type) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find((t) => t.type === type && (type !== 'page' || t.url.startsWith('http://localhost:5173/')))
  if (!target) throw Error(JSON.stringify(targets))
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const result = JSON.parse(event.data)
    if (result.id) { pending.get(result.id)?.(result); pending.delete(result.id) }
  }
  return {
    ws,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, (r) => r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result))
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  }
}
const main = await connect(9229, 'node')
const page = await connect(9222, 'page')
async function ev(expression, client = page) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
try {
  await ev(`globalThis.auditElectron=process.mainModule.require('electron');globalThis.auditWindow=auditElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http://localhost:5173/'))`, main)
  const [command, label = command] = process.argv.slice(2)
  if (command === 'minimum') await ev(`auditWindow.unmaximize();auditWindow.setBounds({x:0,y:0,width:1260,height:650})`, main)
  if (command === 'minimum-content') await ev(`auditWindow.unmaximize();auditWindow.setContentSize(1260,650);auditWindow.setPosition(0,0)`, main)
  if (command === 'large') await ev(`auditWindow.unmaximize();auditWindow.setBounds({x:0,y:0,width:1500,height:950})`, main)
  if (command === 'maximize') await ev(`auditWindow.maximize()`, main)
  if (command === 'restore') await ev(`auditWindow.unmaximize();auditWindow.setBounds({width:1260,height:780})`, main)
  if (command === 'eval') {
    console.log(JSON.stringify(await ev(await fs.readFile(path.resolve(label), 'utf8')), null, 2))
  } else {
    await new Promise((r) => setTimeout(r, 600))
    const data = {
      label, time: new Date().toISOString(),
      main: await ev(`({cwd:process.cwd(),pid:process.pid,appPath:auditElectron.app.getAppPath(),version:auditElectron.app.getVersion(),electron:process.versions.electron,bounds:auditWindow.getBounds(),content:auditWindow.getContentBounds(),minimum:auditWindow.getMinimumSize(),zoom:auditWindow.webContents.getZoomFactor(),maximized:auditWindow.isMaximized(),displays:auditElectron.screen.getAllDisplays().map(d=>({id:d.id,bounds:d.bounds,workArea:d.workArea,scaleFactor:d.scaleFactor,size:d.size}))})`, main),
      renderer: await ev(`({url:location.href,inner:[innerWidth,innerHeight],client:[document.documentElement.clientWidth,document.documentElement.clientHeight],outer:[outerWidth,outerHeight],dpr:devicePixelRatio,classes:[document.documentElement.className,document.body.className,document.querySelector('#app')?.className],language:document.documentElement.lang,dialogs:[...document.querySelectorAll('.dialog-visible .inner')].map(e=>({class:e.className,rect:e.getBoundingClientRect().toJSON(),scroll:e.scrollHeight,client:e.clientHeight,buttons:[...e.querySelectorAll('button')].slice(-8).map(b=>({text:b.innerText,rect:b.getBoundingClientRect().toJSON()}))}))})`)
    }
    await fs.appendFile(path.join(folder, 'measurements.jsonl'), JSON.stringify(data) + '\n')
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await fs.writeFile(path.join(folder, 'screenshots', `${label}.png`), Buffer.from(shot.data, 'base64'))
    console.log(JSON.stringify(data, null, 2))
  }
} finally { main.ws.close(); page.ws.close() }
