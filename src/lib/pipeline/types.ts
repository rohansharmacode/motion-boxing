import type { Landmark, Pose } from '../motion/pose'
export type { Landmark }
export type Delegate = 'GPU' | 'CPU'
export type Tier = 0 | 1 | 2
export interface BodyFrame {
  timeMs: number
  image: Pose
  world: Pose
  person: 'tracked' | 'no-person'
}
export interface PipelineStatus {
  state: 'idle' | 'starting' | 'running' | 'stopped' | 'error' | 'disposed'
  fps: number
  inferenceMs: number
  delegate: Delegate | null
  tier: Tier
  person: BodyFrame['person']
  renderer: { pixelRatioCap: number; bloom: boolean; shadows: boolean }
  error?: string
}
export interface Assets {
  scriptUrl: string
  wasmUrl: string
  localScriptUrl: string
  localWasmUrl: string
  modelUrl: string
  localModelUrl: string
}
export const defaultAssets: Assets = {
  scriptUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/vision_bundle.cjs',
  wasmUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm',
  localScriptUrl: '/mediapipe/vision_bundle.cjs',
  localWasmUrl: '/mediapipe/wasm',
  modelUrl: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  localModelUrl: '/mediapipe/pose_landmarker_lite.task',
}
export type WorkerRequest =
  | { type: 'init'; assets: Assets }
  | { type: 'frame'; bitmap: ImageBitmap; timeMs: number }
  | { type: 'dispose' }
export type WorkerResponse =
  | { type: 'ready'; delegate: Delegate }
  | { type: 'result'; timeMs: number; inferenceMs: number; delegate: Delegate; image: Landmark[][]; world: Landmark[][] }
  | { type: 'error'; message: string }
  | { type: 'disposed' }
