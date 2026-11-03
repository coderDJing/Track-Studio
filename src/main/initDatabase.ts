import fs = require('fs-extra')
import path = require('path')
import { recoverSetTreeTransaction } from './setLibrarySync/treeTransaction'
import { ensureEnglishCoreLibraries, getCoreFsDirName } from './utils'
import {
  ensureLibraryTreeBaseline,
  findLibraryNodeByPath,
  insertLibraryNode
} from './libraryTreeDb'

function hasSubdirectories(targetPath: fs.PathLike) {
  try {
    const items = fs.readdirSync(targetPath, { withFileTypes: true })
    for (const item of items) {
      if (item.isDirectory()) {
        return true
      }
    }
    return false
  } catch (_err) {
    return false
  }
}

function resolveDemoMusicPath(fileName: string) {
  const packedPath = path.join(__dirname, '../../resources/demoMusic', fileName)
  const unpackedPath = packedPath.replace('app.asar', 'app.asar.unpacked')
  if (fs.pathExistsSync(unpackedPath)) {
    return unpackedPath
  }
  if (fs.pathExistsSync(packedPath)) {
    return packedPath
  }
  return unpackedPath
}

export async function initDatabaseStructure(
  dirPath: string,
  options: { createSamples?: boolean } = {}
): Promise<void> {
  const createSamples = options.createSamples === true
  // 优先进行核心库中文→英文的重命名/归一化，避免先创建英文目录造成并存
  try {
    await ensureEnglishCoreLibraries(dirPath)
  } catch {}
  // 清理旧版 V1 指纹文件
  try {
    const v1 = path.join(dirPath, 'songFingerprint', 'songFingerprint.json')
    if (fs.pathExistsSync(v1)) {
      fs.removeSync(v1)
    }
  } catch {}

  // 库根目录
  await fs.ensureDir(path.join(dirPath, 'library'))

  // 核心库目录改为英文命名，兼容旧库将在读取时尝试从中文重命名为英文
  const filterLibraryPath = path.join(dirPath, 'library', getCoreFsDirName('FilterLibrary'))
  const curatedLibraryPath = path.join(dirPath, 'library', getCoreFsDirName('CuratedLibrary'))
  const recycleBinPath = path.join(dirPath, 'library', getCoreFsDirName('RecycleBin'))
  const recordingLibraryPath = path.join(dirPath, 'library', getCoreFsDirName('RecordingLibrary'))
  const mixtapeLibraryPath = path.join(dirPath, 'library', getCoreFsDirName('MixtapeLibrary'))
  const setLibraryPath = path.join(dirPath, 'library', getCoreFsDirName('SetLibrary'))
  await fs.ensureDir(filterLibraryPath)
  await fs.ensureDir(curatedLibraryPath)
  await fs.ensureDir(setLibraryPath)
  await fs.ensureDir(recycleBinPath)
  await fs.ensureDir(recordingLibraryPath)
  await fs.ensureDir(mixtapeLibraryPath)

  await recoverSetTreeTransaction(dirPath)
  await ensureLibraryTreeBaseline(dirPath, {
    coreDirNames: {
      FilterLibrary: getCoreFsDirName('FilterLibrary'),
      CuratedLibrary: getCoreFsDirName('CuratedLibrary'),
      SetLibrary: getCoreFsDirName('SetLibrary'),
      MixtapeLibrary: getCoreFsDirName('MixtapeLibrary'),
      RecordingLibrary: getCoreFsDirName('RecordingLibrary'),
      RecycleBin: getCoreFsDirName('RecycleBin')
    }
  })

  // 仅在需要时（初始化向导）注入示例内容
  if (
    createSamples &&
    !hasSubdirectories(filterLibraryPath) &&
    !hasSubdirectories(curatedLibraryPath)
  ) {
    await fs.ensureDir(path.join(filterLibraryPath, 'House'))
    const filterLibrarySonglistSongDemo1 = resolveDemoMusicPath(
      'Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
    )
    const filterLibrarySonglistSongDemo2 = resolveDemoMusicPath(
      'War - Low Rider (Kyle Watson Remix).mp3'
    )
    if (fs.pathExistsSync(filterLibrarySonglistSongDemo1)) {
      await fs.copy(
        filterLibrarySonglistSongDemo1,
        path.join(
          filterLibraryPath,
          'House',
          'Oden & Fatzo, Poppy Baskcomb - Tell Me What You Want (Extended Mix).mp3'
        )
      )
    }
    if (fs.pathExistsSync(filterLibrarySonglistSongDemo2)) {
      await fs.copy(
        filterLibrarySonglistSongDemo2,
        path.join(filterLibraryPath, 'House', 'War - Low Rider (Kyle Watson Remix).mp3')
      )
    }

    await fs.ensureDir(path.join(curatedLibraryPath, 'House Nice'))
    const curatedLibrarySonglistSongDemo1 = resolveDemoMusicPath(
      'Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
    )
    if (fs.pathExistsSync(curatedLibrarySonglistSongDemo1)) {
      await fs.copy(
        curatedLibrarySonglistSongDemo1,
        path.join(
          curatedLibraryPath,
          'House Nice',
          'Armand Van Helden - I Want Your Soul (AVH Rework).mp3'
        )
      )
    }

    const filterParent = findLibraryNodeByPath(
      path.join('library', getCoreFsDirName('FilterLibrary')),
      dirPath
    )
    if (filterParent) {
      insertLibraryNode(
        {
          uuid: 'filterLibrarySonglistDemo1',
          parentUuid: filterParent.uuid,
          dirName: 'House',
          nodeType: 'songList',
          order: 1
        },
        dirPath
      )
    }

    const curatedParent = findLibraryNodeByPath(
      path.join('library', getCoreFsDirName('CuratedLibrary')),
      dirPath
    )
    if (curatedParent) {
      insertLibraryNode(
        {
          uuid: 'curatedLibrarySonglistDemo1',
          parentUuid: curatedParent.uuid,
          dirName: 'House Nice',
          nodeType: 'songList',
          order: 1
        },
        dirPath
      )
    }
  }
}
