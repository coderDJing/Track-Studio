import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import fs = require('fs-extra')

const execFileAsync = promisify(execFile)
const ATTRIB_TIMEOUT_MS = 3_000

// 目录读取/创建无需先清除隐藏属性，直接设置即可，避免每次读缓存启动两次 attrib。
export const setFileHidden = async (filePath: string): Promise<void> => {
  if (os.platform() !== 'win32') return
  await execFileAsync('attrib', ['+h', filePath], {
    windowsHide: true,
    timeout: ATTRIB_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  })
}

export type HiddenFileOperationStep =
  | 'checking-existing-before'
  | 'clearing-hidden'
  | 'running-operation'
  | 'checking-existing-after'
  | 'setting-hidden'

export const operateHiddenFile = async (
  filePath: string,
  operateFunction: () => Promise<unknown> | unknown,
  onStep?: (step: HiddenFileOperationStep) => void
) => {
  const run = async () => {
    onStep?.('running-operation')
    return await Promise.resolve(operateFunction())
  }
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

  onStep?.('checking-existing-before')
  if (await fs.pathExists(filePath)) {
    onStep?.('clearing-hidden')
    await tryAttrib('-h')
  }
  try {
    await run()
  } finally {
    onStep?.('checking-existing-after')
    if (await fs.pathExists(filePath)) {
      onStep?.('setting-hidden')
      await tryAttrib('+h')
    }
  }
}
