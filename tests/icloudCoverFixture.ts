export const coverPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
)
export function coverWave() {
  const payload = Buffer.concat([Buffer.from('\0image/png\0\x03\0', 'binary'), coverPng])
  const frame = Buffer.alloc(10)
  frame.write('APIC')
  frame.writeUInt32BE(payload.length, 4)
  const tags = Buffer.concat([frame, payload]),
    id3 = Buffer.alloc(10)
  id3.write('ID3')
  id3[3] = 3
  for (let i = 0; i < 4; i++) id3[9 - i] = (tags.length >>> (i * 7)) & 127
  const wav = Buffer.alloc(32044)
  wav.write('RIFF')
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(32000, 40)
  const chunk = Buffer.alloc(8)
  chunk.write('id3 ')
  chunk.writeUInt32LE(id3.length + tags.length, 4)
  const result = Buffer.concat([
    wav,
    chunk,
    id3,
    tags,
    ...((id3.length + tags.length) % 2 ? [Buffer.alloc(1)] : [])
  ])
  result.writeUInt32LE(result.length - 8, 4)
  return result
}
