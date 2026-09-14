import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import fs = require('fs-extra')

const execFileAsync = promisify(execFile)
const ATTRIB_TIMEOUT_MS = 3_000

export const operateHiddenFile = async (
  filePath: string,
  operateFunction: () => Promise<unknown> | unknown
) => {
  const run = async () => await Promise.resolve(operateFunction())
  if (os.platform() !== 'win32') return run()

  const tryAttrib = async (attribute: '+h' | '-h') => {
    try {
      // attrib 偶发不退出时不能无限占住上层文件 I/O 单飞队列。
      await execFileAsync('attrib', [attribute, filePath], {
        windowsHide: true,
        timeout: ATTRIB_TIMEOUT_MS,
        killSignal: 'SIGKILL'
      })
    } catch {}
  }

  if (await fs.pathExists(filePath)) await tryAttrib('-h')
  try {
    await run()
  } finally {
    if (await fs.pathExists(filePath)) await tryAttrib('+h')
  }
}
