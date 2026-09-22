declare module 'onnxruntime-node' {
  export class Tensor {
    constructor(type: 'float32', data: Float32Array, dims: readonly number[])

    readonly data:
      | Float32Array
      | Float64Array
      | Int8Array
      | Uint8Array
      | Int16Array
      | Uint16Array
      | Int32Array
      | Uint32Array
      | BigInt64Array
      | BigUint64Array
      | readonly string[]
    readonly dims: readonly number[]
    readonly type: string
  }

  export namespace InferenceSession {
    type SessionOptions = {
      executionProviders?: readonly string[]
      graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all'
    }
  }

  export class InferenceSession {
    static create(
      modelPath: string,
      options?: InferenceSession.SessionOptions
    ): Promise<InferenceSession>

    run(feeds: Readonly<Record<string, Tensor>>): Promise<Record<string, Tensor>>
  }
}
