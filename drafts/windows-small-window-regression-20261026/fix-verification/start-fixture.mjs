import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import electron from 'electron'
const dir=path.dirname(fileURLToPath(import.meta.url))
const root=path.resolve(dir,'../../..')
const server=await createServer({
  root,configFile:false,plugins:[vue()],
  optimizeDeps:{entries:[path.join(dir,'index.html')]},
  resolve:{alias:{'@renderer':path.join(root,'src/renderer/src'),'@shared':path.join(root,'src/shared')}},
  server:{host:'127.0.0.1',port:5175,strictPort:true}
})
await server.listen()
console.log('Fixture server: http://127.0.0.1:5175/drafts/windows-small-window-regression-20261026/fix-verification/index.html')
const child=spawn(electron,['--remote-debugging-port=9224',path.join(dir,'fixture-main.cjs')],{cwd:root,stdio:'inherit'})
child.on('exit',async()=>{await server.close();process.exit(0)})
process.on('SIGINT',()=>child.kill())
