export const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  window.electron.ipcRenderer.invoke(channel, payload) as Promise<T>
