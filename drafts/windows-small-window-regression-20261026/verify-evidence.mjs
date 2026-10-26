import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
const dir=path.dirname(fileURLToPath(import.meta.url))
const docs=['Windows小窗口适配回归报告.md','覆盖清单.md','截图索引.md']
const missing=[]
let links=0
for(const doc of docs){
 const content=fs.readFileSync(path.join(dir,doc),'utf8')
 for(const m of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)){
  if(/^https?:/.test(m[1]))continue
  links++
  const target=path.resolve(dir,decodeURIComponent(m[1].split('#')[0]))
  if(!fs.existsSync(target))missing.push({doc,link:m[1]})
 }
}
const files=fs.readdirSync(path.join(dir,'screenshots')).filter(f=>f.endsWith('.png')).sort()
fs.writeFileSync(path.join(dir,'screenshots.sha256'),files.map(f=>`${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'screenshots',f))).digest('hex')}  screenshots/${f}`).join('\n')+'\n')
const result={time:new Date().toISOString(),documents:docs,localLinks:links,missing,screenshotFiles:files.length}
fs.writeFileSync(path.join(dir,'evidence-verification.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
if(missing.length)process.exitCode=1
