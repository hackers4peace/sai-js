import { LWS_CONTAINER_LINK } from './container.ts'
import {
  discoverDescriptionResource,
  discoverLwsStorage,
  fetchLwsStorageDescription,
  storageRootFromDescription,
} from './discovery.ts'
import { expandedJsonLd } from './jsonld.ts'
import { applyPatch, insertPatch } from './sparql-update.ts'
import type { WhatwgFetch } from './whatwg-fetch.ts'

export interface MintArgs {
  parent: string
  isContainer: boolean
}

export interface CreateArgs {
  parent: string
  identifier: string
  isContainer: boolean
  body?: unknown
}

export type CreationStep =
  | {
      type: 'post'
      url: string
      headers: Record<string, string>
      body?: unknown
    }
  | {
      type: 'patch-description'
      body: unknown
    }

export interface CreationPlan {
  identifier: string
  steps: Array<CreationStep>
}

export interface StorageIdentifierStrategy {
  mint(args: MintArgs): string
  create(args: CreateArgs): CreationPlan
}

/**
 * Flat LWS identifier strategy: every member is allocated directly under the
 * storage root as `{storageRoot}{uuid}`. Creation POSTs to the containing
 * resource with that UUID as the Slug; flat containers are created empty and
 * their description resource is patched afterwards.
 */
export class FlatIdentifierStrategy implements StorageIdentifierStrategy {
  private readonly storageRoot: string
  private readonly randomUUID: () => string

  constructor(storageRoot: string, randomUUID: () => string) {
    this.storageRoot = storageRoot
    this.randomUUID = randomUUID
  }

  mint(_args: MintArgs): string {
    return `${this.storageRoot}${this.randomUUID()}`
  }

  create({ parent, identifier, isContainer, body }: CreateArgs): CreationPlan {
    const slug = identifier.split('/').filter(Boolean).pop()
    if (!slug) {
      throw new Error(`cannot derive a slug from ${identifier}`)
    }
    const headers: Record<string, string> = {
      slug,
      'content-type': 'application/ld+json',
    }
    if (isContainer) {
      headers.link = LWS_CONTAINER_LINK
    }

    return {
      identifier,
      steps: [
        {
          type: 'post',
          url: parent,
          headers,
          // Containers ignore the representation; their description is patched.
          ...(isContainer ? {} : { body: body ?? [] }),
        },
        ...(isContainer && body !== undefined
          ? [{ type: 'patch-description', body } as const]
          : []),
      ],
    }
  }
}

async function serializeBody(body: unknown): Promise<string> {
  if (body === undefined) {
    return '[]'
  }
  return JSON.stringify(await expandedJsonLd(body as Record<string, unknown>))
}

/** Execute a creation plan and return the identifier it created. */
export async function executeCreationPlan(plan: CreationPlan, fetch: WhatwgFetch): Promise<string> {
  for (const step of plan.steps) {
    if (step.type === 'post') {
      const response = await fetch(step.url, {
        method: 'POST',
        headers: step.headers,
        body: await serializeBody(step.body),
      })
      if (!response.ok) {
        // TODO(idempotency): send Idempotency-Key and treat an existing
        // identifier as a safe retry instead of failing on the duplicate UUID.
        throw new Error(`failed to create ${plan.identifier}: ${response.status}`)
      }
      const location = response.headers.get('Location')
      if (!location) {
        throw new Error(`POST ${step.url} did not return a Location`)
      }
      const created = new URL(location, step.url).toString()
      if (created !== plan.identifier) {
        throw new Error(`POST ${step.url} allocated ${created}, expected ${plan.identifier}`)
      }
      continue
    }

    const description = await discoverDescriptionResource(plan.identifier, fetch)
    if (!description) {
      throw new Error(`could not discover description resource of ${plan.identifier}`)
    }
    await applyPatch(
      plan.identifier,
      fetch,
      await insertPatch(step.body as Record<string, unknown>),
      description
    )
  }
  return plan.identifier
}

export interface ResolvedStorage {
  storageUrl: string
  storageRoot: string
  strategy: StorageIdentifierStrategy
}

export interface IdentifierStrategyResolver {
  resolve(storageUrl: string): Promise<ResolvedStorage>
  forStorage(storageRoot: string): StorageIdentifierStrategy
}

/**
 * Resolves a storage through `rel="storage"` and its LWS storage description.
 * The cache is keyed by the exact URLs returned by discovery — identifiers are
 * not normalized. Root/strategy stability is assumed for the process lifetime.
 */
export class CachingIdentifierStrategyResolver implements IdentifierStrategyResolver {
  private readonly byUrl = new Map<string, Promise<ResolvedStorage>>()
  private readonly byRoot = new Map<string, StorageIdentifierStrategy>()
  private readonly fetch: WhatwgFetch
  private readonly randomUUID?: () => string

  constructor(fetch: WhatwgFetch, randomUUID?: () => string) {
    this.fetch = fetch
    this.randomUUID = randomUUID
  }

  async resolve(storageUrl: string): Promise<ResolvedStorage> {
    const cachedRoot = this.byRoot.get(storageUrl)
    if (cachedRoot) {
      return { storageUrl, storageRoot: storageUrl, strategy: cachedRoot }
    }
    const cached = this.byUrl.get(storageUrl)
    if (cached) {
      return cached
    }

    const pending = this.discover(storageUrl)
    this.byUrl.set(storageUrl, pending)
    try {
      const resolved = await pending
      this.byRoot.set(resolved.storageRoot, resolved.strategy)
      return resolved
    } catch (error) {
      this.byUrl.delete(storageUrl)
      throw error
    }
  }

  forStorage(storageRoot: string): StorageIdentifierStrategy {
    const strategy = this.byRoot.get(storageRoot)
    if (!strategy) {
      throw new Error(`no identifier strategy for storage ${storageRoot}`)
    }
    return strategy
  }

  private async discover(storageUrl: string): Promise<ResolvedStorage> {
    const storageDescriptionUrl = await discoverLwsStorage(storageUrl, this.fetch)
    if (!storageDescriptionUrl) {
      throw new Error(`cannot discover the LWS storage of ${storageUrl}`)
    }
    const description = await fetchLwsStorageDescription(storageDescriptionUrl, this.fetch)
    if (!description) {
      throw new Error(`cannot load the LWS storage description of ${storageUrl}`)
    }
    const storageRoot = storageRootFromDescription(description)
    if (!storageRoot) {
      throw new Error(`cannot discover the LWS storage root of ${storageUrl}`)
    }

    // TODO(identifier-strategy): select the strategy advertised by the storage
    // description. Flat is the only supported strategy for now.
    const randomUUID =
      this.randomUUID ??
      (() => {
        throw new Error('minting requires a randomUUID generator')
      })
    const strategy = new FlatIdentifierStrategy(storageRoot, randomUUID)
    return { storageUrl, storageRoot, strategy }
  }
}

export interface IdentifierStrategyContext {
  fetch: WhatwgFetch
  randomUUID?: () => string
  identifierStrategies?: IdentifierStrategyResolver
}

function resolverFor(context: IdentifierStrategyContext): IdentifierStrategyResolver {
  return (
    context.identifierStrategies ??
    new CachingIdentifierStrategyResolver(context.fetch, context.randomUUID)
  )
}

/** Mint a new identifier for a member of `parent`. */
export async function mintResource(
  parent: string,
  context: IdentifierStrategyContext & { randomUUID(): string },
  isContainer = false
): Promise<string> {
  const { strategy } = await resolverFor(context).resolve(parent)
  return strategy.mint({ parent, isContainer })
}

/** Create a resource at an already-minted identifier. */
export async function createResource(
  parent: string,
  identifier: string,
  context: IdentifierStrategyContext,
  isContainer = false,
  body?: unknown
): Promise<string> {
  const { strategy } = await resolverFor(context).resolve(parent)
  return executeCreationPlan(
    strategy.create({ parent, identifier, isContainer, body }),
    context.fetch
  )
}

/** Mint and create a new member, returning its identifier. */
export async function createMintedResource(
  parent: string,
  context: IdentifierStrategyContext & { randomUUID(): string },
  isContainer = false,
  body?: unknown
): Promise<string> {
  const identifier = await mintResource(parent, context, isContainer)
  return createResource(parent, identifier, context, isContainer, body)
}
