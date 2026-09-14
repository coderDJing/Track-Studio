import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import fs = require('fs-extra')

const execFileAsync = promisify(execFile)

export const operateHiddenFile = async (
  filePath: string,
  operateFunction: () => Promise<unknown> | unknown
) => {
  const run = async () => await Promise.resolve(operateFunction())
  if (os.platform() !== 'win32') return run()

  const tryAttrib = async (attribute: '+h' | '-h') => {
    try {
      await execFileAsync('attrib', [attribute, filePath], { windowsHide: true })
    } catch {}
  }

  if (await fs.pathExists(filePath)) await tryAttrib('-h')
  try {
    await run()
  } finally {
    if (await fs.pathExists(filePath)) await tryAttrib('+h')
  }
}
