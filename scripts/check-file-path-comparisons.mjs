import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

// Physical file identity must go through filePathComparison. Library-tree paths are
// exact display/rename data: preserve case-only renames instead of suppressing them.
const violations = []
let checkedFiles = 0

const isLiteralCheck = (node) =>
  ts.isTypeOfExpression(node) ||
  ts.isStringLiteral(node) ||
  node.kind === ts.SyntaxKind.NullKeyword ||
  (ts.isIdentifier(node) && ['undefined', 'null'].includes(node.text))
const isPath = (node, renderer) => {
  if (ts.isPropertyAccessExpression(node))
    return /^(filePath|rootPath|sourcePath|targetPath|destPath|analyzePath)$/.test(node.name.text)
  return (
    renderer &&
    ts.isIdentifier(node) &&
    /(?:FilePath|filePath|RootPath|rootPath|SongPath|songPath)$/.test(node.text)
  )
}
const isNormalized = (node, source) =>
  ts.isCallExpression(node) && /normaliz|[Pp]athKey|[Kk]ey$/.test(node.expression.getText(source))

function inspect(file) {
  if (!/\.(ts|vue)$/.test(file) || /(?:\.spec|\.d)\.ts$/.test(file)) return
  checkedFiles += 1
  const relative = file.replace(/\\/g, '/')
  const text = fs.readFileSync(file, 'utf8')
  const script = file.endsWith('.vue') ? /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(text) : null
  if (file.endsWith('.vue') && !script) return
  const offset = script ? script.index + script[0].indexOf('>') + 1 : 0
  const source = ts.createSourceFile(
    file + '.ts',
    script ? script[1] : text,
    ts.ScriptTarget.Latest,
    true
  )
  const renderer = relative.startsWith('src/renderer/')
  function walk(node) {
    if (
      renderer &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /normaliz.*path/i.test(node.name.text) &&
      node.initializer &&
      ts.isArrowFunction(node.initializer) &&
      ts.isCallExpression(node.initializer.body) &&
      ts.isPropertyAccessExpression(node.initializer.body.expression) &&
      ['toLowerCase', 'toLocaleLowerCase'].includes(node.initializer.body.expression.name.text)
    ) {
      const line = text.slice(0, offset + node.getStart(source)).split('\n').length
      violations.push(`${relative}:${line}: unconditional lowercasing in ${node.name.text}`)
    }
    if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(
        node.operatorToken.kind
      ) &&
      (isPath(node.left, renderer) || isPath(node.right, renderer)) &&
      !isLiteralCheck(node.left) &&
      !isLiteralCheck(node.right) &&
      !isNormalized(node.left, source) &&
      !isNormalized(node.right, source)
    ) {
      const line = text.slice(0, offset + node.getStart(source)).split('\n').length
      violations.push(`${relative}:${line}: ${node.getText(source)}`)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
}
function walkDirectory(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walkDirectory(file)
    else inspect(file)
  }
}
walkDirectory('src')
if (violations.length) {
  console.error(
    'Raw file-path identity comparisons found; use the platform-aware comparison helpers:\n' +
      violations.join('\n')
  )
  process.exitCode = 1
} else {
  console.log(`File-path comparison check passed (${checkedFiles} source files).`)
}
