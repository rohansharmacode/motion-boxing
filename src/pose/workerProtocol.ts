// Messages between src/pose/pipeline.ts and src/pose/pose.worker.ts.

export const LANDMARKS = 33
/** Floats per landmark in a packed array: x, y, z, visibility. */
export const STRIDE = 4

export interface TrackerAttempt {
  delegate: 'GPU' | 'CPU'
  /** Absolute model URL. */
  model: string
  /** Absolute lite model URL, used if a GPU attempt fails mid-round. */
  lite: string
}

export type WorkerRequest =
  | {
      type: 'init'
      wasmBase: string
      attempts: TrackerAttempt[]
      options: { detection: number; presence: number; tracking: number }
    }
  /** t: tracker timestamp (ms, increasing). captureT: when the camera captured the frame (performance.now clock). */
  | { type: 'frame'; bitmap: ImageBitmap; t: number; captureT: number }
  | { type: 'dispose' }

export type WorkerResponse =
  | { type: 'ready'; delegate: 'GPU' | 'CPU'; model: string }
  | {
      type: 'result'
      t: number
      captureT: number
      inferenceMs: number
      /** Packed LANDMARKS * STRIDE floats, raw MediaPipe coordinates (not mirrored). null: no pose. */
      image: Float32Array | null
      world: Float32Array | null
    }
  | { type: 'error'; fatal: boolean; message: string; t?: number }
