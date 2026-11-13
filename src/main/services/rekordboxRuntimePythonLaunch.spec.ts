import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPortablePythonLaunch } from './rekordboxRuntimePythonLaunch'

const DEEP_HOME = `C:/frkb-tests/${'long-directory/'.repeat(20)}runtime/python`
const DEEP_PYTHON = `${DEEP_HOME}/python.exe`

describe.skipIf(process.platform !== 'win32')('windows portable python launch', () => {
  it('uses extended-length paths for both executable and PYTHONHOME', () => {
    const launch = buildPortablePythonLaunch(DEEP_PYTHON, DEEP_HOME)
    expect(launch.command).toBe(path.toNamespacedPath(DEEP_PYTHON))
    expect(launch.pythonHome).toBe(path.toNamespacedPath(DEEP_HOME))
    expect(launch.command.startsWith('\\\\?\\')).toBe(true)
    expect(launch.pythonHome.startsWith('\\\\?\\')).toBe(true)
  })

  it('keeps an already namespaced path stable (no double prefix)', () => {
    const namespacedPython = path.toNamespacedPath(DEEP_PYTHON)
    const namespacedHome = path.toNamespacedPath(DEEP_HOME)
    const launch = buildPortablePythonLaunch(namespacedPython, namespacedHome)
    expect(launch.command).toBe(namespacedPython)
    expect(launch.pythonHome).toBe(namespacedHome)
  })

  it('omits PYTHONHOME when the runtime home is unknown', () => {
    expect(buildPortablePythonLaunch(DEEP_PYTHON, '').pythonHome).toBe('')
    expect(buildPortablePythonLaunch(DEEP_PYTHON, '').command.startsWith('\\\\?\\')).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('posix portable python launch', () => {
  it('passes the plain paths through without inventing PYTHONHOME', () => {
    const pythonPath = '/opt/frkb/runtime/python/bin/python3'
    expect(buildPortablePythonLaunch(pythonPath, '/opt/frkb/runtime/python')).toEqual({
      command: pythonPath,
      pythonHome: ''
    })
  })
})
