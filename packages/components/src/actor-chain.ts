import { BadRequestHttpError } from '@solid/community-server'

/** OAuth actor chain entry (`act` claim of RFC 8693). */
export interface ActorClaim {
  sub: string
  act?: ActorClaim
}

/** Bound the chain so a token cannot create unbounded nesting work. */
const MAX_ACTOR_DEPTH = 10

/**
 * Validate an `act` chain: every actor is an HTTP(S) URI and the nesting is
 * bounded. The chain is returned structurally so it can be re-issued without
 * trusting the input object identity.
 */
export function verifyActorChain(value: unknown, depth = 0): ActorClaim {
  if (depth > MAX_ACTOR_DEPTH) {
    throw new BadRequestHttpError('The actor chain is nested too deeply.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestHttpError('The actor chain needs to be an object.')
  }
  const record = value as Record<string, unknown>
  if (typeof record.sub !== 'string' || !/^https?:\/\//u.test(record.sub)) {
    throw new BadRequestHttpError('Every actor chain entry needs an HTTP(S) sub.')
  }
  if (record.act === undefined) return { sub: record.sub }
  return { sub: record.sub, act: verifyActorChain(record.act, depth + 1) }
}

/** Append an actor as the most nested entry of the chain. */
export function appendActor(chain: ActorClaim, sub: string): ActorClaim {
  if (!chain.act) return { sub: chain.sub, act: { sub } }
  return { sub: chain.sub, act: appendActor(chain.act, sub) }
}

/** The most nested actor (the final client/actor). */
export function deepestActor(chain: ActorClaim): string {
  return chain.act ? deepestActor(chain.act) : chain.sub
}
