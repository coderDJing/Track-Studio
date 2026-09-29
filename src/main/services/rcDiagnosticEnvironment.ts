/** 供 worker 可加载的模块判断主进程 RC 诊断，避免静态引入 Electron。 */
export const isPackagedRcMainProcess = (): boolean =>
  process.type === 'browser' &&
  process.env.FRKB_APP_PACKAGED === '1' &&
  /-rc(?:\.|$)/i.test(process.env.FRKB_APP_VERSION || '')
