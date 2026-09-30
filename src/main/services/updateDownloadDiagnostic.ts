import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// RC 诊断：确认增量失败原因并连续两次增量更新成功后移除这些非错误阶段记录。
const LOG_NAME = 'update-download.log'
const MAX_LOG_BYTES = 512 * 1024

const sanitizeMessage = (value: unknown): string =>
  String(value ?? '')
    .replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']+/g, '$1?[redacted]')
    .slice(0, 6000)

const appendDiagnostic = (stage: string, value: unknown): void => {
  try {
    const logPath = path.join(app.getPath('userData'), LOG_NAME)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
      const previousPath = `${logPath}.1`
      fs.rmSync(previousPath, { force: true })
      fs.renameSync(logPath, previousPath)
    }
    fs.appendFileSync(
      logPath,
      `${JSON.stringify({
        time: new Date().toISOString(),
        version: app.getVersion(),
        stage,
        message: sanitizeMessage(value)
      })}\n`,
      'utf8'
    )
  } catch {
    // Diagnostics must not interrupt update downloads.
  }
}

export const updateDownloadDiagnosticLogger = {
  info(message?: unknown): void {
    const text = String(message ?? '')
    if (text.startsWith('Download block maps')) appendDiagnostic('blockmaps', text)
    else if (text.startsWith('Full:') && text.includes('To download:')) {
      appendDiagnostic('differential-plan', text)
    } else if (text.startsWith('New version ') && text.includes(' has been downloaded')) {
      appendDiagnostic('download-complete', text)
    }
  },
  warn(message?: unknown): void {
    const text = String(message ?? '')
    if (text.startsWith('Cannot parse blockmap')) appendDiagnostic('blockmap-warning', text)
    else if (text.startsWith('sha512 checksum mismatch after differential download')) {
      appendDiagnostic('differential-checksum-warning', text)
    }
  },
  error(message?: unknown): void {
    const text = String(message ?? '')
    if (text.startsWith('Cannot download differentially, fallback to full download:')) {
      appendDiagnostic('differential-fallback', text)
    }
  }
}
