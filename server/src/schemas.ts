import { z } from 'zod';
import { SPORT, STORED_EVENT_TYPES } from './types';

/** Ids are UUIDs in practice; allow any short token of safe characters. */
export const IdSchema = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(64, 'is too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'must contain only letters, digits, "-" or "_"');

export const SportSchema = z.literal(SPORT).default(SPORT);

export const CreatePlayerBody = z.object({
  name: z.string().trim().min(1, 'is required').max(50, 'must be at most 50 characters'),
});

export const StartSessionBody = z.object({
  player_id: IdSchema,
  sport: SportSchema,
});

export const EndSessionBody = z.object({
  session_id: IdSchema,
});

export const EventBody = z.object({
  session_id: IdSchema,
  player_id: IdSchema,
  sport: SportSchema,
  event_ts: z.iso.datetime({ offset: true, message: 'must be an ISO-8601 timestamp with Z or an offset' }),
  event_type: z.enum(STORED_EVENT_TYPES),
  hand: z.enum(['L', 'R']),
  speed_mps: z.number().min(0).max(100),
  accuracy: z.number().min(0).max(1).nullish(),
  reaction_ms: z.number().min(0).max(60_000).nullish(),
  guard_up: z.boolean().nullish(),
  points: z.number().int().min(-10_000).max(10_000).nullish(),
  /** Optional extra detail stored in MOTION_EVENTS.payload (VARIANT). */
  payload: z.record(z.string(), z.unknown()).nullish(),
});
export type EventInput = z.infer<typeof EventBody>;

export const EventBatch = z.array(EventBody);

export const AskBody = z.object({
  player_id: IdSchema.optional(),
  question: z.string().trim().min(3, 'is too short').max(500, 'must be at most 500 characters'),
});
