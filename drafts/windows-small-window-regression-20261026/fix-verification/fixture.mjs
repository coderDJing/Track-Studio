import {createApp,createVNode,render,reactive} from 'vue'
import {createPinia} from 'pinia'
import {i18n} from '/src/renderer/src/i18n/index.ts'
import dialogDrag from '/src/renderer/src/directives/dialogDrag.ts'
import '/src/renderer/src/styles/main.scss'
import 'overlayscrollbars/overlayscrollbars.css'
import Menu from '/src/renderer/src/components/rightClickMenu.vue'
import ImportSummary from '/src/renderer/src/components/importFinishedSummaryDialog.vue'
import FingerprintSummary from '/src/renderer/src/components/addSongFingerprintFinishedDialog.vue'
import ConversionSummary from '/src/renderer/src/components/conversionFinishedSummaryDialog.vue'
import CloudSummary from '/src/renderer/src/components/cloudSyncSummaryDialog.vue'
import RenameResult from '/src/renderer/src/components/playlistBatchRename/ResultDialog.vue'

// No production main/preload entry is loaded. There are no library, analysis or sync handlers.
window.electron={ipcRenderer:{on(){return()=>{}},removeListener(){},send(){throw Error('Fixture IPC send blocked')},invoke(){return Promise.reject(Error('Fixture IPC invoke blocked'))}}}
const app=createApp({render:()=>null})
app.use(createPinia()).use(i18n).directive('dialog-drag',dialogDrag).mount('#app')
const panel=document.createElement('div')
panel.style.cssText='height:35px;display:flex;gap:8px;align-items:center;background:var(--bg-elev);color:var(--text);padding:0 8px'
document.body.prepend(panel)
document.body.style.cssText='margin:0;background:var(--bg);color:var(--text)'
const status=document.createElement('span')
status.textContent='ISOLATED FIXTURE · F6 theme · Esc clear'
panel.append(status)
const host=document.createElement('div')
document.body.append(host)
const clear=()=>render(null,host)
const show=(component,props)=>{
  clear()
  const vnode=createVNode(component,{...props,onClose:clear,confirmCallback:result=>{status.textContent='Selected: '+result.menuName;clear()},cancelCallback:clear})
  vnode.appContext=app._context
  render(vnode,host)
}
const overview={startAt:'2026-10-26T09:00:00Z',endAt:'2026-10-26T09:30:00Z',durationMs:1800000,scannedCount:100000,analyzeFailedCount:999,importedToPlaylistCount:90000,duplicatesRemovedCount:9001,fingerprintAddedCount:80000,fingerprintAlreadyExistingCount:10000,fingerprintTotalBefore:1000000,fingerprintTotalAfter:1080000,isComparisonSongFingerprint:true,isPushSongFingerprintLibrary:true}
const fixtures=[
 ['Import',()=>show(ImportSummary,{summary:overview})],
 ['Fingerprint',()=>show(FingerprintSummary,{summary:overview})],
 ['Conversion',()=>show(ConversionSummary,{summary:{total:105,success:20,failed:75,skipped:5,cancelled:true,cancelledCount:5,overwritten:0,renamed:20,backupCount:0,fingerprintAddedCount:20},errors:[{filePath:'FIXTURE/long original name.mp3',message:'Fixture failure detail — no conversion performed'}]})],
 ['Cloud',()=>show(CloudSummary,{summary:{addedToServerCount:100000,pulledToClientCount:200000,curatedArtistClientInitialCount:300000,curatedArtistClientCountAfter:400000,curatedArtistServerInitialCount:500000,curatedArtistServerCountAfter:600000,clientInitialCount:1000000,totalClientCountAfter:1200000,serverInitialCount:3000000,totalServerCountAfter:3100000}})],
 ['Rename',()=>show(RenameResult,{result:{summary:{total:100,success:20,failed:80,skipped:0,cancelled:0},items:Array.from({length:80},(_,i)=>({id:'fixture-'+i,order:i,filePath:'FIXTURE/'+i+'.mp3',originalFileName:'Long original name '+i+'.mp3',targetFileName:'Long target name '.repeat(6)+i+'.mp3',status:'file_in_use'})),updates:[]}})]
]
for(const reactiveItems of [false,true]) fixtures.push([reactiveItems?'Reactive menu':'Raw menu',()=>{
 const items=[[{menuName:'Parent — 40 children',children:Array.from({length:40},(_,i)=>({menuName:'Child '+(i+1)+' — long English text'}))},...Array.from({length:60},(_,i)=>({menuName:'Main '+(i+1)}))]]
 show(Menu,{menuArr:reactiveItems?reactive(items):items,clickEvent:{clientX:innerWidth-1,clientY:innerHeight-1}})
}])
for(const [label,click] of fixtures){const button=document.createElement('button');button.textContent=label;button.onclick=click;panel.append(button)}
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'){clear();event.preventDefault()}
 if(event.key==='F6'){
  const theme=document.documentElement.classList.contains('theme-light')?'theme-dark':'theme-light'
  for(const element of [document.documentElement,document.body,document.getElementById('app')]) element.className=theme
  event.preventDefault()
 }
},true)
