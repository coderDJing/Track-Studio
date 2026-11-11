/**
 * tempo 曲线记录器。
 *
 * 导出的并行拉伸需要「每个 128 帧块上 tempo AudioParam 到底等于多少」。这个值只在
 * 音频线程内部成立：setTargetAtTime 的指数逼近、k-rate 的逐块采样、以及 float32 的
 * 取整语义都由浏览器实现决定，主线程用 JS 解析求值只能逼近到 ±1 ULP。而 Rubber Band
 * 的相位声码器对历史极其敏感——差 1 ULP 就会让输出相位永久分叉（实测 SNR 只有
 * 11~19 dB），所以必须拿浏览器算出来的真值。
 *
 * 做法：在离线上下文里给每条轨道挂一个只读参数、输出静音的处理器，把 tempo 参数每块
 * 采一次值回传。开销是每 128 帧一个 float，可以忽略。
 */

const QUANTUM = 128
const FLUSH_QUANTA = 2048

class MixtapeTempoCurveRecorder extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'tempo',
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: 'k-rate'
      }
    ]
  }

  constructor(options) {
    super()
    const processorOptions = (options && options.processorOptions) || {}
    this.totalQuanta = Math.max(0, Number(processorOptions.totalQuanta) || 0)
    this.skipQuanta = Math.max(0, Number(processorOptions.skipQuanta) || 0)
    this.pending = new Float32Array(FLUSH_QUANTA)
    this.pendingCount = 0
    this.quantum = 0
    this.emitted = 0
    this.done = false
  }

  emit() {
    if (this.pendingCount === 0) return
    const values = new Float32Array(this.pending.subarray(0, this.pendingCount))
    this.pendingCount = 0
    this.emitted += values.length
    this.port.postMessage({ type: 'curve', values }, [values.buffer])
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0]
    if (output) {
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel].fill(0)
      }
    }
    if (this.done) return true

    const index = this.quantum
    this.quantum += 1
    if (index >= this.skipQuanta) {
      this.pending[this.pendingCount] = parameters.tempo[0]
      this.pendingCount += 1
      if (this.pendingCount >= FLUSH_QUANTA) this.emit()
    }
    if (this.totalQuanta > 0 && this.quantum >= this.totalQuanta) {
      this.emit()
      this.done = true
      this.port.postMessage({ type: 'curve-done', total: this.emitted })
    }
    return true
  }
}

registerProcessor('mixtape-tempo-curve-recorder', MixtapeTempoCurveRecorder)
