// Run with: node --test scripts/demucs-model-ensure.spec.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { formatErrorWithCause } from './lib/demucs-runtime-support.mjs'
import { downloadToFile } from './lib/demucs-model-ensure.mjs'

const certificateError = () => {
  const cause = Object.assign(new Error('certificate expired'), {
    code: 'CERT_HAS_EXPIRED'
  })
  return new TypeError('fetch failed', { cause })
}

test('formats nested fetch failure with the TLS cause and code', () => {
  const text = formatErrorWithCause(certificateError())
  assert.match(text, /fetch failed/)
  assert.match(text, /certificate expired/)
  assert.match(text, /CERT_HAS_EXPIRED/)
})

test('keeps plain HTTP and string errors readable', () => {
  assert.equal(formatErrorWithCause(new Error('HTTP 403')), 'HTTP 403')
  assert.equal(formatErrorWithCause('socket hang up'), 'socket hang up')
})

test('redacts proxy credentials from formatted messages', () => {
  const text = formatErrorWithCause(
    new Error('request via https://user:secret@proxy.example:8080 failed')
  )
  assert.doesNotMatch(text, /user:secret/)
  assert.match(text, /https:\/\/\*\*\*@proxy\.example:8080/)
})

test('does not hang on a cyclic cause chain', () => {
  const first = new Error('first')
  const second = new Error('second')
  first.cause = second
  second.cause = first
  const text = formatErrorWithCause(first)
  assert.match(text, /first/)
  assert.match(text, /second/)
  assert.ok(text.length < 200)
})

test('limits the cause chain depth', () => {
  const root = new Error('error-0')
  let current = root
  for (let index = 1; index < 10; index += 1) {
    const next = new Error(`error-${index}`)
    current.cause = next
    current = next
  }
  const text = formatErrorWithCause(root)
  assert.match(text, /error-0/)
  assert.match(text, /error-5/)
  assert.doesNotMatch(text, /error-6/)
})

test('surfaces the nested cause and code in the final model download error', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frkb-model-error-'))
  const targetPath = path.join(directory, 'model.bin')
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    await assert.rejects(
      downloadToFile({
        url: 'https://example.invalid/models/model.bin',
        targetPath,
        timeoutSec: 1,
        retries: 2,
        toShortText: (value) => String(value),
        fetchImpl: async () => {
          throw certificateError()
        }
      }),
      (error) => {
        assert.match(error.message, /Download failed/)
        assert.match(error.message, /example\.invalid/)
        assert.match(error.message, /fetch failed/)
        assert.match(error.message, /certificate expired/)
        assert.match(error.message, /CERT_HAS_EXPIRED/)
        return true
      }
    )
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /CERT_HAS_EXPIRED/)
    assert.equal(fs.existsSync(targetPath), false)
  } finally {
    console.warn = originalWarn
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
