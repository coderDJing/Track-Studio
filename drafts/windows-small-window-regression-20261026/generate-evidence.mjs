import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dir, '../..')
const read = p => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
const records = read(path.join(dir, 'measurements.jsonl')).trim().split(/\r?\n/).map(JSON.parse)
const byLabel = new Map(records.map(r => [r.label, r]))
const shots = fs.readdirSync(path.join(dir, 'screenshots')).filter(f => f.endsWith('.png')).sort()
const superseded = {
  '03-welcome-end-dark-zh': '滚动尚未稳定，以 03b 为准',
  '35-two-pane-browser-light-en': '尚未呈现双栏，以 48/49 为准',
  '47-two-pane-light-zh': '尚未呈现双栏，以 48/49 为准',
  'fixture-config-8-light-zh': '夹具 actionKey 无效，已由 8-corrected 替代，不计产品问题',
  'fixture-submenu-right-light-zh': '普通数组夹具未实际出现子菜单，见 F01；有效右展开见 right-reactive'
}
const shotRows = shots.map(file => {
  const label = file.slice(0, -4), record = byLabel.get(label)
  if (!record) throw Error(`Missing metrics for ${file}`)
  const png = fs.readFileSync(path.join(dir, 'screenshots', file))
  const fixture = label.includes('fixture')
  const theme = record.renderer.classes.join(' ').includes('theme-light') ? '亮' : '暗'
  const language = label.endsWith('-en') ? 'English' : '简体中文'
  return {file, label, time:record.time, fixture, theme, language, png:[png.readUInt32BE(16),png.readUInt32BE(20)],
    outer:record.main.bounds, content:record.main.content, renderer:record.renderer.inner,
    client:record.renderer.client, domOuter:record.renderer.outer, zoom:record.main.zoom, dpr:record.renderer.dpr,
    maximized:record.main.maximized, note:superseded[label] || ''}
})
fs.writeFileSync(path.join(dir,'screenshot-index.json'),JSON.stringify(shotRows,null,2)+'\n')
const wh = v => Array.isArray(v) ? v.join('×') : `${v.width}×${v.height}`
let index = '# 原始截图及逐帧尺寸索引\n\n所有 PNG 来自当前工作区 Electron renderer 的 CDP 原始捕获；不含 Windows 外框。窗口外框/客户端通过 Electron API 单独测量。未裁剪、缩放或标注原图。DIP、CSS px 与 PNG px 分列。35 CSS px 自定义标题栏已计入 renderer，未重复扣除。语言取自实际 UI 操作及记录名，document.lang 为空。\n\n'
index += '|截图|证据类型|主题/语言|外框 DIP|客户端 DIP|inner / client CSS px|DOM outer CSS px|zoom / DPR|PNG px|真最大化|说明|\n|---|---|---|---|---|---|---|---|---|---|---|\n'
for (const s of shotRows) index += `|[${s.label}](screenshots/${s.file})|${s.fixture?'夹具':'实际 UI'}|${s.theme}/${s.language}|${wh(s.outer)}|${wh(s.content)}|${wh(s.renderer)} / ${wh(s.client)}|${wh(s.domOuter)}|${s.zoom} / ${s.dpr}|${wh(s.png)}|${s.maximized?'是':'否'}|${s.note}|\n`
fs.writeFileSync(path.join(dir,'截图索引.md'), index)

const walk = d => fs.readdirSync(d,{withFileTypes:true}).flatMap(e => e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)])
const sourceFiles = walk(path.join(root,'src/renderer/src')).filter(f => /\.(vue|ts)$/.test(f) && !f.endsWith('.spec.ts'))
const vueFiles = sourceFiles.filter(f=>f.endsWith('.vue'))
const candidates = vueFiles.filter(f => /dialog|overlay|menu|picker|select|welcome|guide|migration|relocat|update/i.test(path.basename(f)) || /v-dialog-drag|<teleport|position\s*:\s*fixed|dialog-visible/i.test(read(f)))
const known = new Map()
const add = (names,status,detail) => names.split('|').forEach(n=>known.set(n,{status,detail}))
add('settingDialog.vue|SettingDialogBody.vue|CuratedLibrarySyncSettings.vue','V/P','实际设置入口；正文到底/颜色/下拉；四组合×最小/真最大化；拖边、缩窗与重复循环。同步操作未执行。04–12、34、37–45。')
add('ColorPicker.vue','V/P','设置真实入口，初开色条/HEX 可见，右下拖动跟随，锚点滚出后收起，缩窗收起；未改颜色；四边全部独立组合未穷尽。04/05/09/10。')
add('BaseSelect.vue','V/P','真实短列表、9 项范围、格式7项向上展开；Down/Enter选择，Tab/Esc收起；尚未完整覆盖长英文嵌套列表。09–13/32。')
add('welcomePage.vue|WelcomeCreatePlaylistActions.vue','V/P','欢迎页实际顶部/末尾可滚达；未创建或导入。双轨02/03b，浏览器58/59。')
add('ImportTracksDialogBase.vue','V/P','真实导入配置26及嵌套文件/歌单选择27/28，全部取消；dropInto/扫描新增等复用分支未独立测试。')
add('exportDialog.vue','V/P','真实歌单导出配置25，未开始导出；不同删除/文件冲突分支未覆盖。')
add('EditMetadataDialog.vue','V/P','真实标签编辑滚至封面/底部20，保存取消可见，只取消。')
add('MusicBrainzDialog.vue','V/P','真实嵌套21，查询无匹配；候选长列表、匹配后应用未覆盖。')
add('filterDialog.vue','V/P+F','真实 BPM 数值筛选24，只取消；日期 between 用展示夹具29验证向上浮层；其余类型未逐项。')
add('DateTimePicker.vue','F/P','日期范围夹具29，第二日期向上展开，日历/时间列及底部可见；未实测拖父窗跟随。')
add('globalSongSearchDialog.vue','V/P','真实搜索House，多条长路径53，未进入/播放/更改。')
add('customFileSelector.vue|dialogLibraryItem/index.vue','V/P','真实导入嵌套27，仅查看系统盘/桌面后取消；深层长目录、权限错误未覆盖。')
add('selectSongListDialog.vue','V/P','真实导入嵌套28，三个既有歌单，只查看取消；超长树未覆盖。')
add('PlaylistBatchRenameDialog.vue','V/P','真实配置16，底部可见，未执行重命名。')
add('PresetManagerDialog.vue','V/P','真实嵌套预设17，只查看，未改/保存/删除预设。')
add('PreviewDialog.vue','V/P','真实只读预览2821条18，44问题提示、列表与底部可见；未执行。')
add('ResultDialog.vue','F/P','100条失败长文件名夹具，滚到第100条；结果5及rename-result-end；亮色计数过浅F02。真实结果未生成。')
add('audioConvertDialog.vue','V/P','真实配置32/33，7格式向上展开，Esc关下拉后保留弹窗，正文到底；未转换。')
add('batchSimilarTracksDialog.vue','F/P','空种子、长错误夹具config11，配置/错误正文和底部；真实推荐列表/播放/写入未覆盖。')
add('analysisBpmRangeDialog.vue','F/P','config9，100000首计数、范围配置展示；未开始分析。')
add('trackReanalysisDialog.vue','V/P+F','真实打开歌单时缺失分析配置13，查看范围Tab关闭后取消；大量数量夹具config10。未执行分析按钮。')
add('AnalysisRuntimeDownloadOverlay.vue','F/P','config12，75%与长提示展示；未运行实际下载、完成或失败。')
add('libraryStemSeparationDialog.vue','V/P','真实Stem配置56，灰色波形区、页签和按钮；未开始分离/载入波形。')
add('demucsUltraModelDownloadDialog.vue','V/P','真实超高质量模型提示57（约297MB），未下载。')
add('cloudSyncSettingsDialog.vue','V/P','真实配置34滚到底，测试/保存/取消可见；仅取消。启动既有自动同步另见报告。')
add('cloudSyncSummaryDialog.vue','F/P','大计数展示夹具result4；几何完整，亮色正文过浅F02；无真实成功同步。')
add('curatedLibrarySyncJoinDialog.vue','F/P','长提示大计数夹具config13；正文有滚动区域，初始标题/底部可见，未滚到底/首次对齐。')
add('BpmFixDialog.vue','F/P','真实入口先分析故未点击；80条长路径ready快照、双滚动/底部，亮英和暗中最小/最大/缩回夹具。30/31及fixture-bpm-*；无真实执行。')
add('BpmFixTaskButton.vue','U','真实校正任务未创建，任务按钮/恢复入口未覆盖。')
add('globalCallShortcutDialog.vue','V/P','真实设置内嵌套46，仅查看取消。')
add('playerGlobalShortcutDialog.vue','F/P','config8-corrected为togglePlayPause有效展示；旧config8错键已废弃。未改快捷键。')
add('setDurationDialog.vue','V/P','实际2821条SET时长统计36，两个cue下拉及关闭可见；没改曲目。')
add('LibraryMergeDialog.vue','V/P','实际迁移/合并介绍54及开始设置55，未选源、未合并；迁移运行中/结果未覆盖。')
add('rightClickMenu.vue','V/P+F','实际歌单/曲目长菜单14/15/19及夹具四角/双向子菜单/跨层/键盘W-S/父滚动/子末项/缩窗；普通数组子菜单失败F01。子菜单开着缩窗未专测。')
add('bubbleBox.vue','V/P','实测过程中见曲目长名称/控件气泡；未系统覆盖禁用锚点、四角长气泡与嵌套竞争。')
add('menu.vue','V/P','实际使用文件/迁移等顶栏入口；全部长主菜单四角测试由rightClickMenu夹具补充，不能代替顶栏菜单每一项。')
add('importFinishedSummaryDialog.vue','F/P','result1 大计数展示，底部可见；亮色计数F02；无真实导入。')
add('addSongFingerprintFinishedDialog.vue','F/P','result2 大计数展示，底部可见；亮色计数F02；无真实处理。')
add('conversionFinishedSummaryDialog.vue','F/P','result3 80条超长错误，正文及嵌套滚动区域存在、底部可见，未逐个滚至末尾；无真实转换。')
add('importSongFingerprintDialog.vue','F/P','config1，空选择配置展示；未导入。')
add('exportSongFingerprintDialog.vue','F/P','config2，配置展示；未导出。')
add('manualAddSongFingerprintDialog.vue','F/P','config3，配置展示；未写指纹。')
add('rekordboxXmlExportDialog.vue','F/P','config4，长歌单名展示；未导出XML。')
add('mixtapeOutputDialog.vue','F/P','config5，长输出名称展示；未输出。')
add('HorizontalBrowseAudioEditSaveDialog.vue','F/P','config6，长文件名/版本名与MP3提示展示；未编辑或保存音频。')
add('HorizontalBrowseAudioEditLeaveDialog.vue','F/P','config7，仅离开提示展示；无真实未保存音频。')
add('HorizontalBrowseDeckMoveDialog.vue','U','涉及已载入曲目/移动，本轮未触发。')
add('cloudSyncSyncDialog.vue|curatedLibrarySyncDialog.vue','U','未手动启动同步；进度、取消、长错误和完成状态未覆盖。既有自动尝试不计人工进度验收。')
add('autoMetadataSummaryDialog.vue','U','需要补全标签结果；未写标签，未构造该夹具。')
add('curatedArtistLibraryDialog.vue','U','真实收藏/网络列表与长数据未覆盖。')
add('fileOpInterruptedDialog.vue','U','需要中断/异常文件操作；未制造。')
add('choiceDialog.vue|InputDialog.vue|confirmDialog.vue|dangerConfirmWithInputDialog.vue','U','通用分支调用点已索引；未逐一弹出确认/输入/危险输入。不能由其他弹窗通过推定正常。')
add('externalLibraryTargetDialog.vue|rekordboxDesktopTargetDialog.vue|rekordboxDesktopStorageDirDialog.vue|rekordboxDesktopCreateNodeDialog.vue|RekordboxDesktopWritingOverlay.vue','U','需外部DJ资料库/目标与写入状态；未连接目标或制造写入。')
add('LibrarySetupOverlay.vue|UserGuideIdentityOverlay.vue|UserGuideCard.vue','U','已有资料库，按边界不重置制造首次引导；引导定位/长文/完成状态未覆盖。')
add('MixtapeBeatAlignDialog.vue|MixtapeDialogsLayer.vue|MixtapeTrackLoopOverlay.vue','U','需要已有时间线/片段/自动增益或节拍对齐状态；未新建编辑任务。')
add('ColumnHeaderContextMenu.vue|songAreaColRightClickMenu.vue','U','独立列头菜单未逐项验证；通用右键菜单证据不替代它们。')
add('CoverPreviewOverlay.vue','U','封面大图浮层未专门打开验证四角/缩窗。')
add('librarySelectArea.vue','V/P','实际三歌单侧栏、拖宽后双栏49并还原；其他DJ/设备分支未覆盖。')
add('songPlayer.vue','V/P','实际双轨空载播放器、Memory/HotCue/工具条初始布局；未载入播放，真实波形与录音状态未覆盖。')
add('SongListRows.vue|SongListHeader.vue|songsArea.vue','V/P','实际2821曲目、封面/预览波形/长名/横向滚动及搜索；嵌入独立浮层未全覆盖。22/24/48/49。')
add('pioneerSongsArea.vue|pioneerDeviceLibraryArea.vue','U','外部DJ资料库与设备数据入口未覆盖。')
add('MiniPlayerOverlay.vue|MiniPlayerMoreMenu.vue','U','独立迷你播放器/菜单未打开。')
add('Update.vue|LibraryRelocate.vue','U','独立更新/迁移窗口未运行；LibraryMerge配置不等同此处。')
add('Mixtape.vue','U','独立Mixtape窗口及时间线未打开；输出配置夹具不能代替整个窗口。')
const sourceTexts = sourceFiles.map(f=>({file:f,text:read(f)}))
const inventory = candidates.map(file=>{
 const relative=path.relative(root,file).replaceAll('\\','/')
 const base=path.basename(file)
 const key=relative.endsWith('dialogLibraryItem/index.vue')?'dialogLibraryItem/index.vue':base
 const found=known.get(key)||{status:'U',detail:'代码扫描发现的独立界面/浮层或其宿主；未逐项实测，不能判定正常。'}
 const refs=sourceTexts.filter(s=>s.file!==file && (s.text.includes(base.replace('.vue','')) || s.text.includes(base))).slice(0,5).map(s=>path.relative(root,s.file).replaceAll('\\','/'))
 return {file:relative,...found,callers:refs}
})
fs.writeFileSync(path.join(dir,'surface-inventory.json'),JSON.stringify(inventory,null,2)+'\n')
let inv='# 弹窗、浮层与宿主覆盖清单\n\n扫描提交 14aefd5a 的全部 renderer Vue 文件，合并组件命名与 `v-dialog-drag / Teleport / position:fixed / dialog-visible` 内容命中，不仅查找 Dialog 文件名。原始全文定位见 [overlay-source-index.txt](overlay-source-index.txt)、[entry-source-index.txt](entry-source-index.txt)。宿主也列入，避免把其内部浮层静默漏掉；本清单并非声称全部已通过。\n\nV/P：真实入口已检查列明部分；F/P：隔离展示夹具已检查列明部分；U：未覆盖。V、F均不代表所有数据/主题/语言/动态组合通过。调用点是静态引用样例，需以源码控制器确认实际入口。主界面行为及完整限制另见主报告。\n\n'
inv+='|源码（相对已确认根目录）|状态|实际范围/未覆盖原因|静态入口或宿主样例|\n|---|---|---|---|\n'
for(const x of inventory) inv+=`|[${x.file}](../../${x.file})|${x.status}|${x.detail}|${x.callers.map(f=>`[${f}](../../${f})`).join('<br>')}|\n`
const windows=walk(path.join(root,'src/main/window')).filter(f=>f.endsWith('.ts') && !/\.spec\./.test(f)).map(f=>path.relative(root,f).replaceAll('\\','/'))
inv+='\n## 独立 Electron 窗口边界\n\n主窗口实际测量；startup 只观察到启动过程，未做专门尺寸矩阵；下列其他窗口均不能由主窗口结果代替。该表包含窗口辅助文件，是发现索引。\n\n'+windows.map(f=>`- [${f}](../../${f})：${f==='src/main/window/mainWindow/index.ts'?'主窗口已测，详主报告':'未单独验收（窗口/辅助模块索引）'}`).join('\n')+'\n'
fs.writeFileSync(path.join(dir,'覆盖清单.md'),inv)

const log=read(path.join(dir,'dev-ui-ready.log'))
const jobs=[...new Set([...log.matchAll(/jobId:\s*(\d+)/g)].map(m=>Number(m[1])))].sort((a,b)=>a-b)
const backgroundEvidence={diagnosticJobIds:jobs,diagnosticJobIdCount:jobs.length,note:'仅诊断中出现的jobId，不等于全部任务数、成功数或写入数；未保存运行前资料库快照，无法核对数据库变更数量。',cloudConnectionRefused:log.includes('ECONNREFUSED'),appStopped:true}
fs.writeFileSync(path.join(dir,'automatic-work-evidence.json'),JSON.stringify(backgroundEvidence,null,2)+'\n')
console.log(JSON.stringify({screenshots:shotRows.length,surfaces:inventory.length,statusCounts:inventory.reduce((o,x)=>(o[x.status]=(o[x.status]||0)+1,o),{}),unmapped:inventory.filter(x=>x.detail.startsWith('代码扫描')).map(x=>x.file),automaticWork:backgroundEvidence},null,2))
