import { shell } from 'electron'
import path = require('path')
import fs = require('fs-extra')
import { normalizeFilePathForComparison } from '../../../shared/filePathComparison'
import { SET_PACKAGE_AUDIO_DIR_NAME } from '../../../shared/setPackage'
import type { SetPackageManifest } from './manifest'

const pathKey = (value: string) =>
  normalizeFilePathForComparison(path.resolve(value), process.platform === 'win32')

const containsPath = (parent: string, child: string) => {
  const relative = path.relative(pathKey(parent), pathKey(child))
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

/** 只回收完整的独立 SET 包；混入其他文件、链接或与当前音乐库重叠时保留源目录。 */
export async function cleanupImportedPackage(
  manifestPath: string,
  manifest: SetPackageManifest,
  databaseRoot: string
): Promise<void> {
  const packageDir = await fs.realpath(path.dirname(manifestPath))
  const libraryRoot = await fs.realpath(databaseRoot)
  if (containsPath(packageDir, libraryRoot) || containsPath(libraryRoot, packageDir)) {
    throw new Error('SET 源文件夹与当前音乐库重叠，不能删除')
  }
  if ((await fs.lstat(path.dirname(manifestPath))).isSymbolicLink()) {
    throw new Error('SET 源文件夹是链接，不能删除')
  }
  const expectedFiles = new Set([pathKey(path.join(packageDir, path.basename(manifestPath)))])
  const expectedDirs = new Set<string>()
  for (const file of manifest.files) {
    if (!file.path.startsWith(`${SET_PACKAGE_AUDIO_DIR_NAME}/`)) {
      throw new Error('SET 音频不在包内 audio 文件夹中，不能删除源文件夹')
    }
    const absolute = path.resolve(packageDir, ...file.path.split('/'))
    if (!containsPath(packageDir, absolute) || pathKey(absolute) === pathKey(packageDir)) {
      throw new Error('SET 音频路径越界，不能删除源文件夹')
    }
    expectedFiles.add(pathKey(absolute))
    for (
      let dir = path.dirname(absolute);
      pathKey(dir) !== pathKey(packageDir);
      dir = path.dirname(dir)
    ) {
      expectedDirs.add(pathKey(dir))
    }
  }
  const visit = async (dir: string) => {
    for (const name of await fs.readdir(dir)) {
      const absolute = path.join(dir, name)
      const key = pathKey(absolute)
      const stat = await fs.lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error('SET 源文件夹包含链接，不能删除')
      if (stat.isDirectory() && expectedDirs.has(key)) {
        await visit(absolute)
      } else if (stat.isFile() && expectedFiles.delete(key)) {
        continue
      } else {
        throw new Error('SET 源文件夹包含包外文件，不能删除')
      }
    }
  }
  await visit(packageDir)
  if (expectedFiles.size > 0) throw new Error('SET 源文件夹内容已变化，不能删除')
  await shell.trashItem(packageDir)
}
