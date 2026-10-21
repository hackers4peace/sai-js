import { BasicRepresentation, HttpError, NOTIFY } from '@solid/community-server'
import { ApplicationFailure } from '@temporalio/common'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { init, start } = vi.hoisted(() => ({
  init: vi.fn(),
  start: vi.fn(),
}))

vi.mock('../src/temporal/client.js', () => ({
  Temporal: class {
    client = { workflow: { start } }
    init = init
  },
}))

import { ActivityWebhookHandler } from '../src/ActivityWebhookHandler.js'
import { DurableWebhookEmitter } from '../src/DurableWebhookEmitter.js'
import { ReciprocalWebhookHandler } from '../src/ReciprocalWebhookHandler.js'
import { postWebhook } from '../src/temporal/activities/webhook-delivery.js'
import { deliverWebhook } from '../src/temporal/workflows/webhook-delivery.js'

const sendTo = 'https://auth/.sai/activity-webhook/1'
const body = '{"type":"Add","object":"https://registry/alice/activity/1"}'

const channel = {
  id: 'https://registry/.notifications/WebhookChannel2023/1',
  type: NOTIFY.WebhookChannel2023,
  topic: 'https://registry/alice/activity/',
  sendTo,
}

const makeRepresentation = () => new BasicRepresentation(body, 'application/ld+json')

describe('DurableWebhookEmitter', () => {
  beforeEach(() => {
    init.mockReset().mockResolvedValue(undefined)
    start.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('enqueues deliverWebhook on the webhook-delivery queue', async () => {
    await new DurableWebhookEmitter().handle({ channel, representation: makeRepresentation() })

    expect(start).toHaveBeenCalledWith(deliverWebhook, {
      taskQueue: 'webhook-delivery',
      args: [{ sendTo, body, contentType: 'application/ld+json' }],
      workflowId: expect.stringMatching(/^webhook:/),
    })
  })

  test('falls back to a direct POST when the enqueue fails', async () => {
    start.mockRejectedValueOnce(new Error('temporal unavailable'))
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await new DurableWebhookEmitter().handle({ channel, representation: makeRepresentation() })

    expect(fetchMock).toHaveBeenCalledWith(sendTo, {
      method: 'POST',
      headers: { 'content-type': 'application/ld+json' },
      body,
    })
  })
})

describe('postWebhook', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('posts the serialized notification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await postWebhook({ sendTo, body, contentType: 'application/ld+json' })

    expect(fetchMock).toHaveBeenCalledWith(sendTo, {
      method: 'POST',
      headers: { 'content-type': 'application/ld+json' },
      body,
    })
  })

  test.each([400, 410, 413, 415, 422])('marks status %i as non-retryable', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })))

    const error = await postWebhook({ sendTo, body }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ApplicationFailure)
    expect((error as ApplicationFailure).nonRetryable).toBe(true)
  })

  test.each([404, 408, 425, 429, 500])('retries status %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })))

    const error = await postWebhook({ sendTo, body }).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ApplicationFailure)
  })

  test('retries network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    await expect(postWebhook({ sendTo, body })).rejects.toThrow('network down')
  })
})

describe('webhook handlers', () => {
  test.each([
    [
      'activity',
      () =>
        new ActivityWebhookHandler(
          { findBySendTo: async () => undefined } as never,
          {} as never,
          {} as never
        ),
    ],
    [
      'reciprocal',
      () =>
        new ReciprocalWebhookHandler(
          {} as never,
          { findBySendTo: async () => undefined } as never,
          {} as never
        ),
    ],
  ])('%s returns 410 for an unknown sendTo', async (_name, makeHandler) => {
    const error = await makeHandler()
      .handle({ operation: { target: { path: sendTo } } } as never)
      .catch((err: unknown) => err)

    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).statusCode).toBe(410)
  })
})
