/*!
 * rubberband-wasm v4.0.1 (https://www.npmjs.com/package/rubberband-wasm)
 * (c) Dani Biro
 * @license GPLv2
 */

;(function () {
  'use strict'

  var RubberBandOption
  ;(function (RubberBandOption) {
    RubberBandOption[(RubberBandOption['RubberBandOptionProcessOffline'] = 0)] =
      'RubberBandOptionProcessOffline'
    RubberBandOption[(RubberBandOption['RubberBandOptionProcessRealTime'] = 1)] =
      'RubberBandOptionProcessRealTime'
    RubberBandOption[(RubberBandOption['RubberBandOptionStretchElastic'] = 0)] =
      'RubberBandOptionStretchElastic'
    RubberBandOption[(RubberBandOption['RubberBandOptionStretchPrecise'] = 16)] =
      'RubberBandOptionStretchPrecise'
    RubberBandOption[(RubberBandOption['RubberBandOptionTransientsCrisp'] = 0)] =
      'RubberBandOptionTransientsCrisp'
    RubberBandOption[(RubberBandOption['RubberBandOptionTransientsMixed'] = 256)] =
      'RubberBandOptionTransientsMixed'
    RubberBandOption[(RubberBandOption['RubberBandOptionTransientsSmooth'] = 512)] =
      'RubberBandOptionTransientsSmooth'
    RubberBandOption[(RubberBandOption['RubberBandOptionDetectorCompound'] = 0)] =
      'RubberBandOptionDetectorCompound'
    RubberBandOption[(RubberBandOption['RubberBandOptionDetectorPercussive'] = 1024)] =
      'RubberBandOptionDetectorPercussive'
    RubberBandOption[(RubberBandOption['RubberBandOptionDetectorSoft'] = 2048)] =
      'RubberBandOptionDetectorSoft'
    RubberBandOption[(RubberBandOption['RubberBandOptionPhaseLaminar'] = 0)] =
      'RubberBandOptionPhaseLaminar'
    RubberBandOption[(RubberBandOption['RubberBandOptionPhaseIndependent'] = 8192)] =
      'RubberBandOptionPhaseIndependent'
    RubberBandOption[(RubberBandOption['RubberBandOptionThreadingAuto'] = 0)] =
      'RubberBandOptionThreadingAuto'
    RubberBandOption[(RubberBandOption['RubberBandOptionThreadingNever'] = 65536)] =
      'RubberBandOptionThreadingNever'
    RubberBandOption[(RubberBandOption['RubberBandOptionThreadingAlways'] = 131072)] =
      'RubberBandOptionThreadingAlways'
    RubberBandOption[(RubberBandOption['RubberBandOptionWindowStandard'] = 0)] =
      'RubberBandOptionWindowStandard'
    RubberBandOption[(RubberBandOption['RubberBandOptionWindowShort'] = 1048576)] =
      'RubberBandOptionWindowShort'
    RubberBandOption[(RubberBandOption['RubberBandOptionWindowLong'] = 2097152)] =
      'RubberBandOptionWindowLong'
    RubberBandOption[(RubberBandOption['RubberBandOptionSmoothingOff'] = 0)] =
      'RubberBandOptionSmoothingOff'
    RubberBandOption[(RubberBandOption['RubberBandOptionSmoothingOn'] = 8388608)] =
      'RubberBandOptionSmoothingOn'
    RubberBandOption[(RubberBandOption['RubberBandOptionFormantShifted'] = 0)] =
      'RubberBandOptionFormantShifted'
    RubberBandOption[(RubberBandOption['RubberBandOptionFormantPreserved'] = 16777216)] =
      'RubberBandOptionFormantPreserved'
    RubberBandOption[(RubberBandOption['RubberBandOptionPitchHighSpeed'] = 0)] =
      'RubberBandOptionPitchHighSpeed'
    RubberBandOption[(RubberBandOption['RubberBandOptionPitchHighQuality'] = 33554432)] =
      'RubberBandOptionPitchHighQuality'
    RubberBandOption[(RubberBandOption['RubberBandOptionPitchHighConsistency'] = 67108864)] =
      'RubberBandOptionPitchHighConsistency'
    RubberBandOption[(RubberBandOption['RubberBandOptionChannelsApart'] = 0)] =
      'RubberBandOptionChannelsApart'
    RubberBandOption[(RubberBandOption['RubberBandOptionChannelsTogether'] = 268435456)] =
      'RubberBandOptionChannelsTogether'
    RubberBandOption[(RubberBandOption['RubberBandOptionEngineFaster'] = 0)] =
      'RubberBandOptionEngineFaster'
    RubberBandOption[(RubberBandOption['RubberBandOptionEngineFiner'] = 536870912)] =
      'RubberBandOptionEngineFiner'
  })(RubberBandOption || (RubberBandOption = {}))
  var RubberBandPresetOption
  ;(function (RubberBandPresetOption) {
    RubberBandPresetOption[(RubberBandPresetOption['DefaultOptions'] = 0)] = 'DefaultOptions'
    RubberBandPresetOption[(RubberBandPresetOption['PercussiveOptions'] = 1056768)] =
      'PercussiveOptions'
  })(RubberBandPresetOption || (RubberBandPresetOption = {}))
  var RubberBandLiveOption
  ;(function (RubberBandLiveOption) {
    RubberBandLiveOption[(RubberBandLiveOption['RubberBandLiveOptionWindowShort'] = 0)] =
      'RubberBandLiveOptionWindowShort'
    RubberBandLiveOption[(RubberBandLiveOption['RubberBandLiveOptionWindowMedium'] = 1048576)] =
      'RubberBandLiveOptionWindowMedium'
    RubberBandLiveOption[(RubberBandLiveOption['RubberBandLiveOptionFormantShifted'] = 0)] =
      'RubberBandLiveOptionFormantShifted'
    RubberBandLiveOption[
      (RubberBandLiveOption['RubberBandLiveOptionFormantPreserved'] = 16777216)
    ] = 'RubberBandLiveOptionFormantPreserved'
    RubberBandLiveOption[(RubberBandLiveOption['RubberBandLiveOptionChannelsApart'] = 0)] =
      'RubberBandLiveOptionChannelsApart'
    RubberBandLiveOption[
      (RubberBandLiveOption['RubberBandLiveOptionChannelsTogether'] = 268435456)
    ] = 'RubberBandLiveOptionChannelsTogether'
  })(RubberBandLiveOption || (RubberBandLiveOption = {}))
  class RubberBandInterface {
    constructor() {}
    static async initialize(module) {
      if (typeof WebAssembly === 'undefined') {
        throw new Error('WebAssembly is not supported in this environment!')
      }
      let heap = {}
      const errorHandler = (...params) => {
        console.error('WASI called with params', params)
        return 52
      }
      let printBuffer = []
      const wasmInstance = await WebAssembly.instantiate(module, {
        env: {
          emscripten_notify_memory_growth: () => {
            heap.HEAP8 = new Uint8Array(wasmInstance.exports.memory.buffer)
            heap.HEAP32 = new Uint32Array(wasmInstance.exports.memory.buffer)
          }
        },
        wasi_snapshot_preview1: {
          proc_exit: (...params) => errorHandler('proc_exit', params),
          fd_read: (...params) => errorHandler('fd_read', params),
          fd_write: (fd, iov, iovcnt, pnum) => {
            if (fd > 2) return 52
            let num = 0
            for (let i = 0; i < iovcnt; i++) {
              const ptr = heap.HEAP32[iov >> 2]
              const len = heap.HEAP32[(iov + 4) >> 2]
              iov += 8
              for (let j = 0; j < len; j++) {
                const curr = heap.HEAP8[ptr + j]
                if (curr === 0 || curr === 10) {
                  console.log(printBuffer.join(''))
                  printBuffer.length = 0
                } else {
                  printBuffer.push(String.fromCharCode(curr))
                }
              }
              num += len
            }
            heap.HEAP32[pnum >> 2] = num
            return 0
          },
          fd_seek: (...params) => errorHandler('fd_seek', params),
          fd_close: (...params) => errorHandler('fd_close', params),
          environ_sizes_get: (penviron_count, penviron_buf_size) => {
            // heap.HEAP32[penviron_count >> 2] = 0;
            // heap.HEAP32[penviron_buf_size >> 2] = 0;
            return 52 // NO_SYS
          },
          environ_get: (...params) => errorHandler('environ_get', params),
          clock_time_get: (...params) => errorHandler('clock_time_get', params)
        }
      })
      const exports = wasmInstance.exports
      heap.HEAP8 = new Uint8Array(wasmInstance.exports.memory.buffer)
      heap.HEAP32 = new Uint32Array(wasmInstance.exports.memory.buffer)
      exports._initialize()
      const instance = { heap, exports }
      const ret = new RubberBandInterface()
      ret.wasm = instance
      return ret
    }
    malloc(size) {
      return this.wasm.exports.wasm_malloc(size)
    }
    memWrite(destPtr, data) {
      const uint8Array =
        data instanceof Uint8Array
          ? data
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      this.wasm.heap.HEAP8.set(uint8Array, destPtr)
    }
    memWritePtr(destPtr, srcPtr) {
      const buf = new Uint8Array(4)
      const view = new DataView(buf.buffer)
      view.setUint32(0, srcPtr, true)
      this.wasm.heap.HEAP8.set(buf, destPtr)
    }
    memReadU8(srcPtr, length) {
      return this.wasm.heap.HEAP8.subarray(srcPtr, srcPtr + length)
    }
    memReadF32(srcPtr, length) {
      const res = this.memReadU8(srcPtr, length * 4)
      return new Float32Array(res.buffer, res.byteOffset, length)
    }
    free(ptr) {
      this.wasm.exports.wasm_free(ptr)
    }
    rubberband_new(sampleRate, channels, options, initialTimeRatio, initialPitchScale) {
      return this.wasm.exports.rb_new(
        sampleRate,
        channels,
        options,
        initialTimeRatio,
        initialPitchScale
      )
    }
    rubberband_delete(state) {
      this.wasm.exports.rb_delete(state)
    }
    rubberband_reset(state) {
      this.wasm.exports.rb_reset(state)
    }
    rubberband_get_engine_version(state) {
      return this.wasm.exports.rb_get_engine_version(state)
    }
    rubberband_set_time_ratio(state, ratio) {
      this.wasm.exports.rb_set_time_ratio(state, ratio)
    }
    rubberband_set_pitch_scale(state, scale) {
      this.wasm.exports.rb_set_pitch_scale(state, scale)
    }
    rubberband_set_formant_scale(state, scale) {
      this.wasm.exports.rb_set_formant_scale(state, scale)
    }
    rubberband_get_time_ratio(state) {
      return this.wasm.exports.rb_get_time_ratio(state)
    }
    rubberband_get_pitch_scale(state) {
      return this.wasm.exports.rb_get_pitch_scale(state)
    }
    rubberband_get_formant_scale(state) {
      return this.wasm.exports.rb_get_formant_scale(state)
    }
    rubberband_get_preferred_start_pad(state) {
      return this.wasm.exports.rb_get_preferred_start_pad(state)
    }
    rubberband_get_start_delay(state) {
      return this.wasm.exports.rb_get_start_delay(state)
    }
    rubberband_get_latency(state) {
      return this.wasm.exports.rb_get_latency(state)
    }
    rubberband_set_transients_option(state, options) {
      this.wasm.exports.rb_set_transients_option(state, options)
    }
    rubberband_set_detector_option(state, options) {
      this.wasm.exports.rb_set_detector_option(state, options)
    }
    rubberband_set_phase_option(state, options) {
      this.wasm.exports.rb_set_phase_option(state, options)
    }
    rubberband_set_formant_option(state, options) {
      this.wasm.exports.rb_set_formant_option(state, options)
    }
    rubberband_set_pitch_option(state, options) {
      this.wasm.exports.rb_set_pitch_option(state, options)
    }
    rubberband_set_expected_input_duration(state, samples) {
      this.wasm.exports.rb_set_expected_input_duration(state, samples)
    }
    rubberband_get_samples_required(state) {
      return this.wasm.exports.rb_get_samples_required(state)
    }
    rubberband_set_max_process_size(state, samples) {
      this.wasm.exports.rb_set_max_process_size(state, samples)
    }
    rubberband_get_process_size_limit(state) {
      return this.wasm.exports.rb_get_process_size_limit(state)
    }
    rubberband_set_key_frame_map(state, keyframecount, from, to) {
      this.wasm.exports.rb_set_key_frame_map(state, keyframecount, from, to)
    }
    rubberband_study(state, input, samples, final) {
      this.wasm.exports.rb_study(state, input, samples, final)
    }
    rubberband_process(state, input, samples, final) {
      this.wasm.exports.rb_process(state, input, samples, final)
    }
    rubberband_available(state) {
      return this.wasm.exports.rb_available(state)
    }
    rubberband_retrieve(state, output, samples) {
      return this.wasm.exports.rb_retrieve(state, output, samples)
    }
    rubberband_get_channel_count(state) {
      return this.wasm.exports.rb_get_channel_count(state)
    }
    rubberband_calculate_stretch(state) {
      this.wasm.exports.rb_calculate_stretch(state)
    }
    rubberband_set_debug_level(state, level) {
      this.wasm.exports.rb_set_debug_level(state, level)
    }
    rubberband_set_default_debug_level(level) {
      this.wasm.exports.rb_set_default_debug_level(level)
    }
    // RubberBandLiveShifter — real-time pitch shifter introduced in Rubber Band 4.0.
    rubberband_live_new(sampleRate, channels, options) {
      return this.wasm.exports.rb_live_new(sampleRate, channels, options)
    }
    rubberband_live_delete(state) {
      this.wasm.exports.rb_live_delete(state)
    }
    rubberband_live_reset(state) {
      this.wasm.exports.rb_live_reset(state)
    }
    rubberband_live_set_pitch_scale(state, scale) {
      this.wasm.exports.rb_live_set_pitch_scale(state, scale)
    }
    rubberband_live_get_pitch_scale(state) {
      return this.wasm.exports.rb_live_get_pitch_scale(state)
    }
    rubberband_live_set_formant_scale(state, scale) {
      this.wasm.exports.rb_live_set_formant_scale(state, scale)
    }
    rubberband_live_get_formant_scale(state) {
      return this.wasm.exports.rb_live_get_formant_scale(state)
    }
    rubberband_live_get_start_delay(state) {
      return this.wasm.exports.rb_live_get_start_delay(state)
    }
    rubberband_live_set_formant_option(state, options) {
      this.wasm.exports.rb_live_set_formant_option(state, options)
    }
    rubberband_live_get_block_size(state) {
      return this.wasm.exports.rb_live_get_block_size(state)
    }
    rubberband_live_shift(state, input, output) {
      this.wasm.exports.rb_live_shift(state, input, output)
    }
    rubberband_live_get_channel_count(state) {
      return this.wasm.exports.rb_live_get_channel_count(state)
    }
    rubberband_live_set_debug_level(state, level) {
      this.wasm.exports.rb_live_set_debug_level(state, level)
    }
    rubberband_live_set_default_debug_level(level) {
      this.wasm.exports.rb_live_set_default_debug_level(level)
    }
  }

  const MAX_BLOCK = 8192 // max frames fed to / retrieved from RB per call (scratch size)
  const RING_CAPACITY = 1 << 16 // per-channel output ring buffer size (frames), power of two
  const BUFFER_TARGET = 4096 // frames to keep buffered ahead in the output ring
  const PUMP_BUDGET = 256 // max feed/drain cycles per process() call (render-deadline guard)
  let wasmModulePromise = null
  const DEFAULT_OPTIONS =
    RubberBandOption.RubberBandOptionProcessRealTime |
    RubberBandOption.RubberBandOptionChannelsTogether |
    RubberBandOption.RubberBandOptionEngineFiner
  class RubberBandProcessor extends AudioWorkletProcessor {
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
    constructor() {
      super()
      this.rb = null
      this.state = 0
      this.channels = 0
      this.options = DEFAULT_OPTIONS
      this.closed = false
      // wasm scratch (de-interleaved): pointer arrays + per-channel data buffers
      this.inPtr = 0
      this.outPtr = 0
      this.inChan = []
      this.outChan = []
      // source material
      this.source = []
      this.sourceLen = 0
      this.sourceSampleRate = sampleRate
      this.rateFactor = 1 // contextRate / sourceRate
      // transport
      this.readPos = 0
      this.playing = false
      this.startTimeSec = null
      this.stopTimeSec = null
      this.loop = false
      this.finished = false
      this.sentFinal = false
      this.endedPosted = false
      this.startPad = 0 // leading silent input frames still to inject
      this.toDrop = 0 // output frames still to discard (start delay)
      this.needStart = true // start pad/delay must be (re)computed on next pump
      // ratios (user-facing)
      this.speed = 1 // playback speed; timeRatio = rateFactor / speed
      this.pitchScale = 1 // 1.0 = no shift
      // output ring buffer (shared indices; one Float32Array per channel)
      this.ring = []
      this.ringRead = 0
      this.ringWrite = 0
      this.ringCount = 0
      this.framesSinceReport = 0
      this.port.onmessage = (e) => this.onMessage(e.data)
    }
    async onMessage(msg) {
      if (this.closed) return
      switch (msg && msg.type) {
        case 'initialise':
          await this.initialise(msg)
          break
        case 'buffer':
          this.setBuffer(msg)
          break
        case 'play':
          if (this.finished && this.ringCount === 0) this.resetTransport(0)
          this.endedPosted = false
          this.startTimeSec = Number.isFinite(msg.startTimeSec)
            ? Math.max(currentTime, msg.startTimeSec)
            : currentTime
          this.stopTimeSec = null
          this.preroll()
          this.playing = true
          this.port.postMessage({ type: 'scheduled' })
          break
        case 'prepare': {
          this.speed = msg.speed > 0 ? msg.speed : 1
          const frame = Math.max(0, Math.round((msg.seconds || 0) * this.sourceSampleRate))
          this.resetTransport(Math.min(frame, this.sourceLen))
          this.preroll()
          this.port.postMessage({ type: 'prepared' })
          break
        }
        case 'pause':
          this.playing = false
          this.startTimeSec = null
          break
        case 'stop':
          if (Number.isFinite(msg.stopTimeSec) && msg.stopTimeSec > currentTime) {
            this.stopTimeSec = msg.stopTimeSec
          } else {
            this.finishScheduledStop()
          }
          break
        case 'seek': {
          const frame = Math.max(0, Math.round((msg.seconds || 0) * this.sourceSampleRate))
          this.resetTransport(Math.min(frame, this.sourceLen))
          if (this.playing) this.preroll()
          break
        }
        case 'loop':
          this.loop = !!msg.value
          break
        case 'speed':
          this.speed = msg.value > 0 ? msg.value : 1
          this.applyRatios()
          break
        case 'pitch':
          this.pitchScale = msg.value > 0 ? msg.value : 1
          this.applyRatios()
          break
        case 'close':
          this.dispose()
          break
      }
    }
    async initialise(msg) {
      try {
        this.channels = msg.channels
        if (typeof msg.options === 'number') this.options = msg.options
        // A compiled WebAssembly.Module cannot be reliably structured-cloned into
        // an AudioWorkletGlobalScope, so the wasm is passed as bytes and compiled
        // here. (A pre-compiled Module is also accepted, e.g. for non-worklet use.)
        const w = msg.wasm
        const mod =
          w instanceof WebAssembly.Module
            ? w
            : await (wasmModulePromise || (wasmModulePromise = WebAssembly.compile(w)))
        if (this.closed) return
        this.rb = await RubberBandInterface.initialize(mod)
        // A 'close' may have arrived while we were awaiting; don't resurrect.
        if (this.closed) {
          this.rb = null
          return
        }
        this.allocate()
        this.createState()
        this.port.postMessage({ type: 'ready' })
      } catch (e) {
        this.port.postMessage({ type: 'error', error: String((e && e.message) || e) })
      }
    }
    allocate() {
      const rb = this.rb
      this.inPtr = rb.malloc(this.channels * 4)
      this.outPtr = rb.malloc(this.channels * 4)
      this.inChan = []
      this.outChan = []
      this.ring = []
      for (let ch = 0; ch < this.channels; ch++) {
        const ip = rb.malloc(MAX_BLOCK * 4)
        const op = rb.malloc(MAX_BLOCK * 4)
        this.inChan.push(ip)
        this.outChan.push(op)
        rb.memWritePtr(this.inPtr + ch * 4, ip)
        rb.memWritePtr(this.outPtr + ch * 4, op)
        this.ring.push(new Float32Array(RING_CAPACITY))
      }
    }
    createState() {
      const rb = this.rb
      if (this.state) {
        rb.rubberband_delete(this.state)
        this.state = 0
      }
      // Construct at the *context* sample rate (the worklet global `sampleRate`),
      // not the source rate, so output frames map 1:1 onto render frames.
      this.state = rb.rubberband_new(sampleRate, this.channels, this.options, 1, 1)
      if (rb.rubberband_get_engine_version(this.state) !== 3)
        throw new Error('Mixtape R3 processor did not initialise engine version 3')
      rb.rubberband_set_max_process_size(this.state, MAX_BLOCK)
      this.applyRatios()
    }
    applyRatios() {
      if (!this.rb || !this.state) return
      // Fold any source/context sample-rate difference into the ratios so RB does
      // the resampling for us: feeding source-rate frames to a context-rate
      // stretcher shifts pitch by rateFactor and speed by rateFactor, which we
      // counteract here.
      const timeRatio = this.rateFactor / this.speed
      const pitch = this.pitchScale / this.rateFactor
      this.rb.rubberband_set_time_ratio(this.state, timeRatio)
      this.rb.rubberband_set_pitch_scale(this.state, pitch)
    }
    setBuffer(msg) {
      this.source = msg.channels || []
      this.sourceLen = this.source[0] ? this.source[0].length : 0
      this.sourceSampleRate = msg.sampleRate || sampleRate
      this.rateFactor = sampleRate / this.sourceSampleRate
      this.playing = false
      this.startTimeSec = null
      this.stopTimeSec = null
      this.resetTransport(0)
    }
    /** Reset transport + stretcher to a clean start at `startFrame`. */
    resetTransport(startFrame) {
      this.readPos = startFrame
      this.ringRead = 0
      this.ringWrite = 0
      this.ringCount = 0
      this.finished = false
      this.sentFinal = false
      this.endedPosted = false
      this.startPad = 0
      this.toDrop = 0
      // Defer querying the start pad / delay until the first pump: they depend on
      // the time/pitch ratios, which may still change (e.g. setBuffer then
      // setPitch/setTempo) before playback of this segment actually begins.
      this.needStart = true
      const rb = this.rb
      const st = this.state
      if (rb && st) {
        rb.rubberband_reset(st)
        this.applyRatios()
      }
    }
    /** Fill the output ring off the render-deadline (called from message handler). */
    preroll() {
      this.pump(BUFFER_TARGET, 1 << 20)
    }
    /**
     * Drive the stretcher until the output ring holds `target` frames (or the
     * stream ends / the budget is exhausted).
     */
    pump(target, budget) {
      const rb = this.rb
      const st = this.state
      if (!rb || !st || this.finished) return
      if (this.needStart) {
        // Ratios for this segment are now set; query start pad / delay against them.
        this.applyRatios()
        this.startPad = rb.rubberband_get_preferred_start_pad(st)
        this.toDrop = rb.rubberband_get_start_delay(st)
        this.needStart = false
      }
      while (this.ringCount < target && !this.finished && budget-- > 0) {
        const avail = rb.rubberband_available(st)
        if (avail < 0) {
          // -1: all input processed and all output read => fully finished.
          this.finished = true
          break
        }
        if (avail > 0) {
          this.drain(avail)
          continue
        }
        // avail === 0: RB needs more input to make progress.
        if (this.sentFinal) break // already flushed; nothing more will come.
        let req = rb.rubberband_get_samples_required(st)
        if (req <= 0) req = 1 // ensure forward progress
        if (req > MAX_BLOCK) req = MAX_BLOCK
        const isFinal = this.assembleInput(req)
        rb.rubberband_process(st, this.inPtr, req, isFinal ? 1 : 0)
        if (isFinal) this.sentFinal = true
      }
    }
    /** Assemble `req` input frames into the wasm scratch; returns whether `final`. */
    assembleInput(req) {
      const rb = this.rb
      const channels = this.channels
      const dst = []
      for (let ch = 0; ch < channels; ch++) dst.push(rb.memReadF32(this.inChan[ch], req))
      let final = false
      for (let i = 0; i < req; i++) {
        if (this.startPad > 0) {
          for (let ch = 0; ch < channels; ch++) dst[ch][i] = 0
          this.startPad--
          continue
        }
        if (this.readPos >= this.sourceLen) {
          if (this.loop && this.sourceLen > 0) {
            // Wrap within the same block so no frames are withheld at the seam.
            this.readPos = 0
          } else {
            for (let ch = 0; ch < channels; ch++) dst[ch][i] = 0
            final = true // source exhausted, not looping: last block.
            continue
          }
        }
        const p = this.readPos
        for (let ch = 0; ch < channels; ch++) {
          const src = this.source[ch]
          dst[ch][i] = src ? src[p] : 0
        }
        this.readPos++
      }
      return final
    }
    /** Retrieve up to `avail` frames from RB into the ring, applying start-delay trim. */
    drain(avail) {
      const rb = this.rb
      const st = this.state
      let remaining = avail
      while (remaining > 0) {
        const free = RING_CAPACITY - this.ringCount
        if (free <= 0) break
        const want = Math.min(remaining, MAX_BLOCK, free)
        const got = rb.rubberband_retrieve(st, this.outPtr, want)
        if (got <= 0) break
        // Trim the start delay by FRAME (once per retrieve), not per channel.
        let start = 0
        if (this.toDrop > 0) {
          const d = Math.min(this.toDrop, got)
          this.toDrop -= d
          start = d
        }
        const keep = got - start
        if (keep > 0) {
          const views = []
          for (let ch = 0; ch < this.channels; ch++)
            views.push(rb.memReadF32(this.outChan[ch], got))
          this.push(views, start, keep)
        }
        remaining -= got
      }
    }
    /** Push `keep` frames (from offset `start`) of each channel view into the ring. */
    push(views, start, keep) {
      const cap = RING_CAPACITY
      const w = this.ringWrite
      const first = Math.min(keep, cap - w)
      const second = keep - first
      for (let ch = 0; ch < this.channels; ch++) {
        const src = views[ch]
        this.ring[ch].set(src.subarray(start, start + first), w)
        if (second > 0) this.ring[ch].set(src.subarray(start + first, start + keep), 0)
      }
      this.ringWrite = (w + keep) % cap
      this.ringCount += keep
    }
    /** Pop `n` frames from the ring into the output channel arrays. */
    pop(out, n, outputOffset = 0) {
      const cap = RING_CAPACITY
      const r = this.ringRead
      const first = Math.min(n, cap - r)
      const second = n - first
      for (let ch = 0; ch < this.channels; ch++) {
        const dst = out[ch]
        if (!dst) continue
        dst.set(this.ring[ch].subarray(r, r + first), outputOffset)
        if (second > 0) dst.set(this.ring[ch].subarray(0, second), outputOffset + first)
      }
      this.ringRead = (r + n) % cap
      this.ringCount -= n
    }
    dispose() {
      this.closed = true
      const rb = this.rb
      if (rb) {
        if (this.state) rb.rubberband_delete(this.state)
        for (const p of this.inChan) rb.free(p)
        for (const p of this.outChan) rb.free(p)
        if (this.inPtr) rb.free(this.inPtr)
        if (this.outPtr) rb.free(this.outPtr)
      }
      this.state = 0
      this.rb = null
      this.port.onmessage = null
    }
    finishScheduledStop() {
      this.playing = false
      this.startTimeSec = null
      this.stopTimeSec = null
      if (!this.endedPosted) {
        this.endedPosted = true
        this.port.postMessage({ type: 'ended' })
      }
    }
    process(_inputs, outputs, parameters) {
      if (this.closed) return false // release the processor
      const out = outputs[0]
      if (!out || out.length === 0) return true
      const n = out[0].length
      if (!this.rb || !this.state || !this.playing) {
        for (let ch = 0; ch < out.length; ch++) out[ch].fill(0)
        return true
      }
      const quantumEndSec = currentTime + n / sampleRate
      if (this.startTimeSec !== null && quantumEndSec <= this.startTimeSec) {
        for (let ch = 0; ch < out.length; ch++) out[ch].fill(0)
        return true
      }
      const outputStart =
        this.startTimeSec !== null && currentTime < this.startTimeSec
          ? Math.min(n, Math.max(0, Math.ceil((this.startTimeSec - currentTime) * sampleRate)))
          : 0
      const outputEnd =
        this.stopTimeSec !== null
          ? Math.min(n, Math.max(0, Math.ceil((this.stopTimeSec - currentTime) * sampleRate)))
          : n
      if (outputEnd <= outputStart) {
        for (let ch = 0; ch < out.length; ch++) out[ch].fill(0)
        if (this.stopTimeSec !== null && quantumEndSec >= this.stopTimeSec)
          this.finishScheduledStop()
        return true
      }
      const tempoValues = parameters.tempo
      const nextTempo = tempoValues && tempoValues.length > 0 ? tempoValues[0] : this.speed
      if (Number.isFinite(nextTempo) && Math.abs(nextTempo - this.speed) > 0.000001) {
        this.speed = Math.max(0.25, Math.min(4, nextTempo))
        this.applyRatios()
      }
      // Top up the ring with a bounded amount of work (steady-state warm-up was
      // already done off-deadline in preroll()).
      this.pump(BUFFER_TARGET, PUMP_BUDGET)
      const requested = outputEnd - outputStart
      const give = Math.min(requested, this.ringCount)
      for (let ch = 0; ch < out.length; ch++) out[ch].fill(0)
      if (give > 0) this.pop(out, give, outputStart)
      if (this.finished && this.ringCount === 0 && !this.endedPosted) {
        this.endedPosted = true
        this.playing = false
        this.port.postMessage({ type: 'ended' })
      }
      if (this.stopTimeSec !== null && quantumEndSec >= this.stopTimeSec) this.finishScheduledStop()
      this.framesSinceReport += requested
      if (this.framesSinceReport >= sampleRate / 30) {
        this.framesSinceReport = 0
        this.port.postMessage({ type: 'position', seconds: this.audiblePositionSeconds() })
      }
      return true
    }
    // The audible source-time playhead: the input read cursor minus the output
    // still buffered in the ring (converted back to source frames), so it tracks
    // what the listener actually hears rather than what has been fed in.
    audiblePositionSeconds() {
      const bufferedSource = (this.ringCount * this.speed * this.sourceSampleRate) / sampleRate
      let frames = this.readPos - bufferedSource
      if (frames < 0) frames = this.loop && this.sourceLen ? frames + this.sourceLen : 0
      if (frames < 0) frames = 0
      return frames / this.sourceSampleRate
    }
  }
  registerProcessor('rubberband-processor', RubberBandProcessor)
})()
