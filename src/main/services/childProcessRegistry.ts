import childProcess, { type ChildProcess } from 'node:child_process'
import { log } from '../log'

type RegisteredChildProcess = {
  child: ChildProcess
  label: string
}

const registeredChildren = new Set<RegisteredChildProcess>()

const removeRegisteredChild = (entry: RegisteredChildProcess) => {
  registeredChildren.delete(entry)
}

export function registerChildProcess(child: ChildProcess, label = 'child-process'): () => void {
  const entry: RegisteredChildProcess = { child, label }
  registeredChildren.add(entry)
  const cleanup = () => removeRegisteredChild(entry)
  child.once('exit', cleanup)
  child.once('close', cleanup)
  child.once('error', cleanup)
  return cleanup
}

export function terminateChildProcess(child: ChildProcess, label = 'child-process'): void {
  if (!child.pid) return
  try {
    child.stdin?.write('q')
  } catch {}
  if (!child.killed) {
    try {
      child.kill()
    } catch {}
  }
  if (process.platform !== 'win32') return
  try {
    childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    })
  } catch (error) {
    log.error('[process] terminate child tree failed', { label, pid: child.pid, error })
  }
}

export function terminateRegisteredChildProcesses(): void {
  for (const entry of Array.from(registeredChildren)) {
    terminateChildProcess(entry.child, entry.label)
    removeRegisteredChild(entry)
  }
}

/**
 * 精确 PID 终止：只用于本应用自己 spawn、并由 worker 上报过的 sidecar。
 *
 * 主进程没有该 ChildProcess 句柄（它属于 worker），因此只按“我方记录过的精确 PID”
 * 终止单个进程树，绝不按名称/全局模式批量杀 python/node。
 */
export function terminateOwnedPidExact(pid: number, label = 'owned-sidecar'): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (process.platform === 'win32') {
    try {
      const result = childProcess.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      return result.status === 0
    } catch (error) {
      log.error('[process] terminate owned pid failed', { label, pid, error })
      return false
    }
  }
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    // 进程已退出时视为已清理，不再重复处理。
    if (code !== 'ESRCH') {
      log.error('[process] terminate owned pid failed', { label, pid, error })
    }
    return false
  }
}
