type WindowsUsbWriteDevice = { eligible: boolean; identity: string }
type WindowsUsbWriteNative = {
  probeWindowsUsbWriteRoot: (root: string) => Promise<WindowsUsbWriteDevice>
  isWindowsProcessRunning: (name: string) => Promise<boolean>
}

const loadNative = (): WindowsUsbWriteNative => {
  const native = require('rust_package') as WindowsUsbWriteNative
  if (
    typeof native.probeWindowsUsbWriteRoot !== 'function' ||
    typeof native.isWindowsProcessRunning !== 'function'
  )
    throw new Error('原生 U 盘检测模块未更新，请重新构建应用')
  return native
}

export const probeWindowsUsbWriteRoot = (root: string): Promise<WindowsUsbWriteDevice> =>
  loadNative().probeWindowsUsbWriteRoot(root)

export const isWindowsProcessRunning = (name: string): Promise<boolean> =>
  loadNative().isWindowsProcessRunning(name)
