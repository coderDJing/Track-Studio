import { EventEmitter } from 'node:events'

/** 安装完成后通知曲库探测丢掉旧解释器。不要从下载模块引用，避免启动包带上解压逻辑。 */
export const rekordboxRuntimeEvents = new EventEmitter()
