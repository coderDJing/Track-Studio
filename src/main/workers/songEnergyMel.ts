export const SONG_ENERGY_MODEL_SAMPLE_RATE = 16000
export const SONG_ENERGY_MODEL_CHANNELS = 1

export const FFT_SIZE = 512
export const FFT_HALF_SIZE = FFT_SIZE / 2
export const SPECTRUM_SIZE = FFT_HALF_SIZE + 1
export const FRAME_HOP_SIZE = 256
export const MEL_BAND_COUNT = 96
export const PATCH_FRAME_COUNT = 187

type MelFilter = {
  startBin: number
  coefficients: Float64Array
}

const hannWindow = Float64Array.from(
  { length: FFT_SIZE },
  (_, index) => 0.5 * (1 - Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1)))
)

const bitReversedIndices = (() => {
  const result = new Uint16Array(FFT_SIZE)
  const bitCount = Math.log2(FFT_SIZE)
  for (let index = 0; index < FFT_SIZE; index += 1) {
    let source = index
    let reversed = 0
    for (let bit = 0; bit < bitCount; bit += 1) {
      reversed = (reversed << 1) | (source & 1)
      source >>= 1
    }
    result[index] = reversed
  }
  return result
})()

const hzToSlaneyMel = (frequency: number) => {
  const linearStep = 200 / 3
  if (frequency < 1000) return frequency / linearStep
  const minimumLogMel = 1000 / linearStep
  const logStep = Math.log(6.4) / 27
  return minimumLogMel + Math.log(frequency / 1000) / logStep
}

const slaneyMelToHz = (mel: number) => {
  const linearStep = 200 / 3
  const minimumLogMel = 1000 / linearStep
  if (mel < minimumLogMel) return mel * linearStep
  const logStep = Math.log(6.4) / 27
  return 1000 * Math.exp(logStep * (mel - minimumLogMel))
}

const melFilters = (() => {
  const pointCount = MEL_BAND_COUNT + 2
  const maximumMel = hzToSlaneyMel(SONG_ENERGY_MODEL_SAMPLE_RATE / 2)
  const frequencies = Float64Array.from({ length: pointCount }, (_, index) =>
    slaneyMelToHz((index * maximumMel) / (pointCount - 1))
  )

  const filters: MelFilter[] = []
  for (let bandIndex = 0; bandIndex < MEL_BAND_COUNT; bandIndex += 1) {
    const left = frequencies[bandIndex]
    const center = frequencies[bandIndex + 1]
    const right = frequencies[bandIndex + 2]
    const startBin = Math.max(0, Math.ceil((left * FFT_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE))
    const endBin = Math.min(
      SPECTRUM_SIZE - 1,
      Math.floor((right * FFT_SIZE) / SONG_ENERGY_MODEL_SAMPLE_RATE)
    )
    const coefficients = new Float64Array(Math.max(0, endBin - startBin + 1))
    const slaneyNormalization = 2 / (right - left)
    for (let bin = startBin; bin <= endBin; bin += 1) {
      const frequency = (bin * SONG_ENERGY_MODEL_SAMPLE_RATE) / FFT_SIZE
      const triangle =
        frequency <= center
          ? (frequency - left) / (center - left)
          : (right - frequency) / (right - center)
      coefficients[bin - startBin] = Math.max(0, triangle) * slaneyNormalization
    }
    filters.push({ startBin, coefficients })
  }
  return filters
})()

const transformRealFft = (real: Float64Array, imaginary: Float64Array) => {
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const reversedIndex = bitReversedIndices[index]
    if (reversedIndex <= index) continue
    const realValue = real[index]
    real[index] = real[reversedIndex]
    real[reversedIndex] = realValue
  }

  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const halfSize = size / 2
    const angle = (-2 * Math.PI) / size
    const phaseStepReal = Math.cos(angle)
    const phaseStepImaginary = Math.sin(angle)
    for (let start = 0; start < FFT_SIZE; start += size) {
      let phaseReal = 1
      let phaseImaginary = 0
      for (let offset = 0; offset < halfSize; offset += 1) {
        const evenIndex = start + offset
        const oddIndex = evenIndex + halfSize
        const oddReal = real[oddIndex] * phaseReal - imaginary[oddIndex] * phaseImaginary
        const oddImaginary = real[oddIndex] * phaseImaginary + imaginary[oddIndex] * phaseReal
        const evenReal = real[evenIndex]
        const evenImaginary = imaginary[evenIndex]
        real[evenIndex] = evenReal + oddReal
        imaginary[evenIndex] = evenImaginary + oddImaginary
        real[oddIndex] = evenReal - oddReal
        imaginary[oddIndex] = evenImaginary - oddImaginary
        const nextPhaseReal = phaseReal * phaseStepReal - phaseImaginary * phaseStepImaginary
        phaseImaginary = phaseReal * phaseStepImaginary + phaseImaginary * phaseStepReal
        phaseReal = nextPhaseReal
      }
    }
  }
}

export const buildSongEnergyMelFrames = (samples: Float32Array) => {
  const frameCount = Math.floor(samples.length / FRAME_HOP_SIZE) + 1
  const frames = new Float32Array(frameCount * MEL_BAND_COUNT)
  const real = new Float64Array(FFT_SIZE)
  const imaginary = new Float64Array(FFT_SIZE)
  const powerSpectrum = new Float64Array(SPECTRUM_SIZE)

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const sampleStart = frameIndex * FRAME_HOP_SIZE - FFT_HALF_SIZE
    for (let index = 0; index < FFT_SIZE; index += 1) {
      const sample = samples[sampleStart + index] ?? 0
      real[index] = (Number.isFinite(sample) ? sample : 0) * hannWindow[index]
      imaginary[index] = 0
    }
    transformRealFft(real, imaginary)
    for (let bin = 0; bin < SPECTRUM_SIZE; bin += 1) {
      powerSpectrum[bin] = real[bin] * real[bin] + imaginary[bin] * imaginary[bin]
    }

    const outputOffset = frameIndex * MEL_BAND_COUNT
    for (let bandIndex = 0; bandIndex < MEL_BAND_COUNT; bandIndex += 1) {
      const filter = melFilters[bandIndex]
      let melPower = 0
      for (let index = 0; index < filter.coefficients.length; index += 1) {
        melPower += powerSpectrum[filter.startBin + index] * filter.coefficients[index]
      }
      frames[outputOffset + bandIndex] = Math.log10(1 + 10000 * Math.max(0, melPower))
    }
  }
  return { frames, frameCount }
}
