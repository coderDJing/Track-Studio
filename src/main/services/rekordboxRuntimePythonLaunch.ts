import path from 'node:path'

/**
 * Windows 的 portable Python 在超过 MAX_PATH 的目录下会因 DLL LoadLibrary 失败
 * （例如 `import _collections_cy: 文件名或扩展名太长`）。这里为自带 runtime 统一构造
 * 扩展长度入口：
 * - 可执行文件用 `\\?\` 前缀启动，使 Python 的 sys.executable/sys.prefix 落在扩展路径上；
 * - PYTHONHOME 同样使用扩展路径，保证 sys.path 与 DLL 搜索都走扩展路径。
 * 不修改系统 LongPaths 注册表，也不回退系统 Python。
 * 用户显式 ENV_PYTHON 不走这里，保持其自身环境语义。
 */
export type PortablePythonLaunch = {
  command: string
  pythonHome: string
}

export const buildPortablePythonLaunch = (
  pythonPath: string,
  runtimeHome: string
): PortablePythonLaunch => {
  if (process.platform !== 'win32') {
    return { command: pythonPath, pythonHome: '' }
  }
  return {
    command: path.toNamespacedPath(pythonPath),
    pythonHome: runtimeHome ? path.toNamespacedPath(runtimeHome) : ''
  }
}
