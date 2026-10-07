import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { isWindowsProcessRunning, probeWindowsUsbWriteRoot } from './windowsUsbWriteProbe'

async function main() {
  for (const root of ['C:', 'C:/', 'C:\\Windows', '\\\\server\\share\\', '1:\\'])
    await assert.rejects(() => probeWindowsUsbWriteRoot(root), /drive root/)
  const name = path.basename(process.execPath)
  assert.equal(await isWindowsProcessRunning(name), true)
  assert.equal(await isWindowsProcessRunning(name.toUpperCase()), true)
  assert.equal(await isWindowsProcessRunning('frkb-process-that-does-not-exist.exe'), false)
  await assert.rejects(() => isWindowsProcessRunning('C:\\rekordbox.exe'))
  const letter = 'ZYXWVUTSRQPONMLKJIHGFEDCBA'.split('').find((c) => !fs.existsSync(`${c}:\\`))
  if (letter)
    assert.deepEqual(await probeWindowsUsbWriteRoot(`${letter}:\\`), {
      eligible: false,
      identity: ''
    })
  console.log('Windows USB probe native checks passed')
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
