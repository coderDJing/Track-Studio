import { EventEmitter } from 'node:events'

/** 启动时只订阅进度。模型下载本体在 demucsUltraModelDownload，点下载时再加载。 */
export const demucsUltraModelDownloadEvents = new EventEmitter()
