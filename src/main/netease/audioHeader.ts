/**
 * 只解析容器头，判断这份文件到底是什么规格。
 *
 * 为什么需要它：同一档位不同曲目返回的位深/采样率不一样（jymaster 可能给 24/96，
 * 也可能因为没母带而退回 16/44.1），所以"这首实际是什么"只能看文件本身，
 * 不能看我们请求的档位名。
 */
export type AudioHeader = {
  format: 'flac' | 'mp3' | 'unknown'
  bitDepth: number
  sampleRate: number
  channels: number
}

export function parseAudioHeader(buffer: Buffer): AudioHeader | null {
  if (!buffer || buffer.length < 4) return null
  if (buffer.toString('latin1', 0, 4) === 'fLaC') return parseFlac(buffer)
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    // 'ID3' 头：MP3
    return { format: 'mp3', bitDepth: 0, sampleRate: 0, channels: 0 }
  }
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return parseMp3Frame(buffer)
  }
  return { format: 'unknown', bitDepth: 0, sampleRate: 0, channels: 0 }
}

function parseFlac(buffer: Buffer): AudioHeader | null {
  if (buffer.length < 42) return null
  // 第一个 block 必须是 STREAMINFO(0)
  if ((buffer[4] & 0x7f) !== 0) return { format: 'flac', bitDepth: 0, sampleRate: 0, channels: 0 }
  const base = 18
  const sampleRate = (buffer[base] << 12) | (buffer[base + 1] << 4) | (buffer[base + 2] >> 4)
  const channels = ((buffer[base + 2] >> 1) & 0x07) + 1
  const bitDepth = (((buffer[base + 2] & 0x01) << 4) | (buffer[base + 3] >> 4)) + 1
  return { format: 'flac', bitDepth, sampleRate, channels }
}

const MP3_SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000], // MPEG 2.5
  2: [22050, 24000, 16000], // MPEG 2
  3: [44100, 48000, 32000] // MPEG 1
}

function parseMp3Frame(buffer: Buffer): AudioHeader | null {
  const header = (buffer[0] << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3]
  const versionBits = (header >> 19) & 0x03
  const sampleRateIndex = (header >> 10) & 0x03
  const channelMode = (header >> 6) & 0x03
  const rates = MP3_SAMPLE_RATES[versionBits]
  const sampleRate = rates && sampleRateIndex < 3 ? rates[sampleRateIndex] : 0
  return {
    format: 'mp3',
    bitDepth: 0,
    sampleRate,
    channels: channelMode === 3 ? 1 : 2
  }
}
