const path = require('path')
const fs = require('fs')
const fsExtra = require('fs-extra')
const { execFile } = require('child_process')
const { promisify } = require('util')

const execFileAsync = promisify(execFile)

const run = (file, args) => execFileAsync(file, args, { maxBuffer: 1024 * 1024 * 8 })

const otoolDependencies = async (filePath) => {
  const { stdout } = await run('otool', ['-L', filePath])
  return stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' (compatibility')[0])
    .filter(Boolean)
}

/**
 * 把 Rust N-API 模块依赖的 dylib 收进 Contents/Frameworks，并把 install name
 * 改写成 @rpath 形式，保证 universal 包里两个架构的 .node 都能找到自己的库。
 */
const collectMacNativeDependencies = async (context, appPath) => {
  const resourcesPath = path.join(appPath, 'Contents', 'Resources')
  const frameworkPath = path.join(appPath, 'Contents', 'Frameworks')
  const rustPath = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'rust_package')
  if (!fs.existsSync(rustPath)) return
  fs.mkdirSync(frameworkPath, { recursive: true })

  const nativeFiles = fs
    .readdirSync(rustPath)
    .filter((name) => name.endsWith('.node'))
    .map((name) => path.join(rustPath, name))
  const pending = [...nativeFiles]
  const visited = new Set()
  const bundled = new Map()
  const projectDir = context.packager.projectDir
  // install_name_tool 改写过的 Mach-O，签名会在这一步失效，需要重新签名。
  const rewrittenFiles = new Set()

  while (pending.length) {
    const current = pending.shift()
    if (!current || visited.has(current) || !fs.existsSync(current)) continue
    visited.add(current)
    for (const dependency of await otoolDependencies(current)) {
      if (dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/')) continue
      if (dependency.startsWith('@')) continue
      const basename = path.basename(dependency)
      let source = dependency
      if (!fs.existsSync(source)) {
        const candidates = [
          path.join(projectDir, 'rust_package', 'target', 'release', 'deps', basename),
          path.join(projectDir, 'rust_package', 'target', 'debug', 'deps', basename)
        ]
        source = candidates.find((candidate) => fs.existsSync(candidate)) || ''
      }
      if (!source) {
        throw new Error(`macOS native module dependency is missing: ${dependency}`)
      }
      const destination = path.join(frameworkPath, basename)
      if (!bundled.has(basename)) {
        fs.copyFileSync(source, destination)
        bundled.set(basename, destination)
        pending.push(destination)
        rewrittenFiles.add(destination)
      }
      await run('install_name_tool', ['-change', dependency, `@rpath/${basename}`, current])
      rewrittenFiles.add(current)
    }
    if (path.extname(current) === '.dylib') {
      await run('install_name_tool', ['-id', `@rpath/${path.basename(current)}`, current])
      rewrittenFiles.add(current)
    }
  }

  const nativeRpath = '@loader_path/../../../../Frameworks'
  for (const nativeFile of nativeFiles) {
    await run('install_name_tool', ['-add_rpath', nativeRpath, nativeFile]).catch(() => {})
    rewrittenFiles.add(nativeFile)
  }
  for (const dylib of bundled.values()) {
    await run('install_name_tool', ['-add_rpath', '@loader_path', dylib]).catch(() => {})
    rewrittenFiles.add(dylib)
  }

  // install_name_tool 会让 Mach-O 的代码签名失效（工具自己也会警告）。
  // arm64 上内核在加载时会校验签名，签名一旦失效就直接 SIGKILL，
  // 表现是 require 原生模块时进程被 Killed: 9。
  // 这里补一次 ad-hoc 签名保证可加载；
  // 正式的 Developer ID 签名由 electron-builder 在 afterPack 之后统一执行。
  for (const file of rewrittenFiles) {
    await run('codesign', ['--force', '--sign', '-', file])
  }
}

/**
 * 校验打包内的 ffmpeg 是否就位。
 * 不再删除，保证两个架构的包在相同路径存在相同文件，配合 singleArchFiles 合并。
 */
const assertBundledFfmpeg = async (appPath) => {
  const ffmpegUniversalPath = path.join(
    appPath,
    'Contents',
    'Resources',
    'ffmpeg',
    'darwin',
    'ffmpeg'
  )
  const exists = await fsExtra.pathExists(ffmpegUniversalPath)
  if (!exists) {
    throw new Error(`packaged macOS ffmpeg is missing: ${ffmpegUniversalPath}`)
  }
}

/**
 * macOS 打包后处理钩子。
 *
 * 必须在「签名之前」执行。electron-builder 的顺序是
 *   afterPack -> 代码签名 -> Apple 公证 -> afterSign
 * install_name_tool 会改写二进制内容，直接让已有签名失效；如果把这一步放在
 * afterSign，就只能靠一次 ad-hoc 重签来恢复签名完整性，而 ad-hoc 签名会直接
 * 抹掉 Developer ID 开发者身份和已经拿到的公证票据，Apple 也不接受 --deep 签名。
 * 放在 afterPack 里，改写完先补一次 ad-hoc 签名保证二进制可加载，
 * electron-builder 随后会用正式的 Developer ID 证书重新签名，签名与公证才能成立。
 */
module.exports = async function (context) {
  if (context.electronPlatformName !== 'darwin') return

  const appFilename = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appFilename)

  await assertBundledFfmpeg(appPath)
  await collectMacNativeDependencies(context, appPath)

  const rustPackagePath = path.join(
    appPath,
    'Contents/Resources/app.asar.unpacked/node_modules/rust_package'
  )
  const nativeEntry = fs
    .readdirSync(rustPackagePath)
    .filter((name) => name.startsWith('index.darwin-') && name.endsWith('.node'))
    .map((name) => path.join(rustPackagePath, name))[0]
  if (nativeEntry) {
    try {
      await run('node', ['-e', `require(${JSON.stringify(nativeEntry)})`])
    } catch (error) {
      throw new Error(
        `打包后的 macOS 原生模块自检失败：${nativeEntry}\n${error.stderr || error.message}`
      )
    }
  }
}
