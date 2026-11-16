/**
 * 把一份已经校验、写好标签的新文件，原子地换成 `.store` 里的正式文件。
 *
 * 重下音质会走这里：新文件先在临时位准备好，成功后再处理旧文件。
 * 失败时旧文件必须还在，调用方在这一步之前不要删 `netease_file`。
 *
 * 扩展名可能变化（`.flac` → `.mp3`），所以正式名要等新文件就绪再定。
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fs from 'fs-extra'
import { moveFileToRecycleBin } from '../recycleBinService'
import { updateSetItemFilePathReferences } from '../setListDb'
import { assertAbsPathInsideStore, getNeteaseStoreDir, getStoreFilePath } from './paths'

export type StoreReplaceResult = {
  finalPath: string
  oldPath: string | null
  /** 旧文件还在（换扩展名且回收失败时可能发生）；正常情况是 null */
  leftoverOldPath: string | null
}

async function recycleOrRemove(filePath: string): Promise<void> {
  if (!(await fs.pathExists(filePath))) return
  const result = await moveFileToRecycleBin(filePath)
  if (result.status === 'failed') {
    await fs.remove(filePath).catch(() => {})
  }
}

/**
 * `stagingPath` 必须已经是完整可用的音频（容器校验和标签都做完），
 * 并且仍在 `.store` 里。本函数只负责把它改名成正式路径、处理旧文件、改 SET 引用。
 */
export async function replaceStoreFileAtomically(options: {
  songId: string
  ext: string
  stagingPath: string
  oldPath?: string | null
}): Promise<StoreReplaceResult> {
  const stagingPath = assertAbsPathInsideStore(options.stagingPath)
  const finalPath = assertAbsPathInsideStore(getStoreFilePath(options.songId, options.ext))
  const oldPath = options.oldPath ? path.resolve(options.oldPath) : null
  if (oldPath && !isSamePath(oldPath, stagingPath)) {
    assertAbsPathInsideStore(oldPath)
  }

  if (!(await fs.pathExists(stagingPath))) {
    throw new Error('新文件还没准备好，不能替换')
  }

  if (isSamePath(stagingPath, finalPath)) {
    return { finalPath, oldPath, leftoverOldPath: null }
  }

  if (oldPath && isSamePath(oldPath, finalPath)) {
    if (await fs.pathExists(oldPath)) {
      const asidePath = assertAbsPathInsideStore(
        path.join(
          getNeteaseStoreDir(),
          `.${options.songId}.old.${randomUUID()}${path.extname(oldPath)}`
        )
      )
      await fs.rename(oldPath, asidePath)
      try {
        await fs.rename(stagingPath, finalPath)
      } catch (error) {
        // 新文件没就位：把旧的挪回去，调用方仍能播上一份
        if (await fs.pathExists(asidePath)) {
          await fs.rename(asidePath, oldPath).catch(() => {})
        }
        throw error
      }
      await recycleOrRemove(asidePath)
      return { finalPath, oldPath, leftoverOldPath: null }
    }
    // 库记录还在、盘上的旧文件已经丢了：直接把新文件放到正式路径，不要先 rename 一个不存在的旧文件
  }

  if (await fs.pathExists(finalPath)) {
    await recycleOrRemove(finalPath)
  }
  await fs.rename(stagingPath, finalPath)

  if (oldPath && !isSamePath(oldPath, finalPath)) {
    // SET 若还引用着旧路径（常见于扩展名变了），把引用切到新文件，不能让它指到已经要回收的那份
    let refsUpdated = false
    try {
      updateSetItemFilePathReferences(oldPath, finalPath)
      refsUpdated = true
    } catch {
      // 引用更新失败时留下旧文件，避免 SET 先红线；新文件已经就位
    }
    if (refsUpdated) {
      await recycleOrRemove(oldPath)
      return { finalPath, oldPath, leftoverOldPath: null }
    }
    return { finalPath, oldPath, leftoverOldPath: oldPath }
  }

  return { finalPath, oldPath, leftoverOldPath: null }
}

export function isSamePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}
