import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
const dir=path.dirname(fileURLToPath(import.meta.url))
const targets=await(await fetch('http://127.0.0.1:9224/json/list')).json()
const target=targets.find(t=>t.type==='page'&&t.url.includes('/fix-verification/index.html'))
if(!target)throw Error('Fixture target missing')
const ws=new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
let id=0
const callbacks=new Map()
ws.onmessage=event=>{const r=JSON.parse(event.data);if(r.id){callbacks.get(r.id)(r);callbacks.delete(r.id)}}
const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;callbacks.set(n,r=>r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result));ws.send(JSON.stringify({id:n,method,params}))})
try{
 await new Promise(resolve=>setTimeout(resolve,600))
 const evaluation=await send('Runtime.evaluate',{expression:`JSON.stringify({url:location.href,theme:document.documentElement.className,inner:[innerWidth,innerHeight],client:[document.documentElement.clientWidth,document.documentElement.clientHeight],outer:[outerWidth,outerHeight],dpr:devicePixelRatio,menu:[...document.querySelectorAll('.menuButtonOver')].map(e=>e.textContent.trim()),submenus:document.querySelectorAll('.submenu').length,colors:[...document.querySelectorAll('.section-title,.chip .num,.chip.warn .cap,.error-msg')].map(e=>({text:e.textContent.trim(),color:getComputedStyle(e).color,background:getComputedStyle(e.closest('.chip')||e.closest('.inner')||e).backgroundColor})),dialogs:[...document.querySelectorAll('.dialog-visible .inner')].map(e=>({title:e.querySelector('.dialog-header')?.textContent.trim(),rect:e.getBoundingClientRect().toJSON()}))})`,returnByValue:true})
 if(evaluation.exceptionDetails)throw Error(JSON.stringify(evaluation.exceptionDetails))
 const data={label:process.argv[2],time:new Date().toISOString(),...JSON.parse(evaluation.result.value)}
 const luminance=rgb=>rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0)
 for(const c of data.colors){
  const fg=luminance(c.color),bg=luminance(c.background)
  c.contrast=Number(((Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)).toFixed(2))
 }
 const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
 fs.mkdirSync(path.join(dir,'screenshots'),{recursive:true})
 const png=Buffer.from(shot.data,'base64')
 data.png=[png.readUInt32BE(16),png.readUInt32BE(20)]
 fs.writeFileSync(path.join(dir,'screenshots',data.label+'.png'),png)
 fs.appendFileSync(path.join(dir,'measurements.jsonl'),JSON.stringify(data)+'\n')
 console.log(JSON.stringify(data,null,2))
}finally{ws.close()}
