/** Native manual grid shifts preserve the complete phrase tag, including beat indices. */
export const validateUsbAnlzPhraseForGridShift = (bytes: Buffer): void => {
  if (
    bytes.length < 32 ||
    bytes.toString('ascii', 0, 4) !== 'PSSI' ||
    bytes.readUInt32BE(4) !== 32 ||
    bytes.readUInt32BE(8) !== bytes.length ||
    bytes.readUInt32BE(12) !== 24 ||
    bytes.length !== 32 + bytes.readUInt16BE(16) * 24
  )
    throw new Error('不支持的 PSSI 乐句结构，无法确认网格平移兼容性')

  const mood = bytes.readUInt16BE(18)
  if (mood >= 1 && mood <= 3) return
  // Exported PSSI masks the body from byte 18, with phrase count added to the key.
  // Only identify the known encoding; never decode/re-encode or rewrite its indices.
  const count = bytes.readUInt16BE(16)
  const unmaskedMood =
    ((bytes[18] ^ ((0xcb + count) & 0xff)) << 8) | (bytes[19] ^ ((0xe1 + count) & 0xff))
  if (unmaskedMood < 1 || unmaskedMood > 3)
    throw new Error('不支持的 PSSI 乐句编码，无法确认网格平移兼容性')
}
