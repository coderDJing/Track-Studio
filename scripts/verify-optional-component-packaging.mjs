import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const asar = appBuilderRequire('@electron/asar')

const isOptionalPayload = (entry) => {
  const normalized = entry.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase()
  return (
    /(^|\/)(rekordboxdesktopruntime|rekordbox-desktop-runtime)(\/|$)/.test(normalized) ||
    /(^|\/)demucs\/models(\/|$)/.test(normalized)
  )
}

export function verifyOptionalComponentPackaging(resourcesRoot) {
  if (!fs.statSync(resourcesRoot).isDirectory()) throw new Error('Invalid resources directory')
  const forbidden = []
  const visit = (directory, relativeRoot = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(relativeRoot, entry.name)
      if (isOptionalPayload(relative)) {
        forbidden.push(relative)
      } else if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), relative)
      } else if (entry.isFile() && entry.name.endsWith('.asar')) {
        for (const archived of asar.listPackage(path.join(directory, entry.name))) {
          if (isOptionalPayload(archived)) forbidden.push(`${relative}:${archived}`)
        }
      }
    }
  }
  visit(resourcesRoot)
  if (forbidden.length) {
    throw new Error(`Optional payloads were bundled:\n${forbidden.slice(0, 20).join('\n')}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--resources-root')
    if (index < 0 || !process.argv[index + 1]) throw new Error('--resources-root is required')
    verifyOptionalComponentPackaging(path.resolve(process.argv[index + 1]))
    console.log('Verified: base Stem weights and rekordbox Python are excluded')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
