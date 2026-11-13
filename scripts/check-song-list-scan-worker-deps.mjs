import fs from 'node:fs'
import path from 'node:path'

const entries = ['songListScanWorker', 'keyAnalysisWorker']
const visited = new Set()

const inspect = (filePath) => {
  if (visited.has(filePath)) return
  visited.add(filePath)
  const source = fs.readFileSync(filePath, 'utf8')
  // Rollup 的同步依赖位于行首；函数内的 require 来自按需 import，不在 worker 启动时加载。
  const staticRequires = /^(?:(?:const|let|var)\s+[\w$]+\s*=\s*)?require\(['"]([^'"]+)['"]\)/gm
  for (const [, dependency] of source.matchAll(staticRequires)) {
    if (dependency === 'electron') {
      throw new Error(`Worker must not load Electron: ${path.relative(process.cwd(), filePath)}`)
    }
    if (dependency.startsWith('.')) {
      inspect(path.resolve(path.dirname(filePath), dependency))
    }
  }
}

for (const entry of entries) {
  inspect(path.resolve(`out/main/workers/${entry}.js`))
}
console.log(`${entries.join(', ')} dependency check passed (${visited.size} bundled files)`)
