import { ApplicationFailure } from '@temporalio/common'

export interface PostWebhookInput {
  sendTo: string
  body: string
  contentType?: string
}

const NON_RETRYABLE_STATUS = new Set([400, 410, 413, 415, 422])

/**
 * Posts one webhook notification.
 *
 * Delivery is at-least-once. A lost 2xx response or a 5xx after the receiver
 * processed the notification can repeat it, so receivers must tolerate
 * duplicates. A future `Idempotency-Key` header would let them dedupe.
 */
export async function postWebhook(payload: PostWebhookInput): Promise<void> {
  const response = await fetch(payload.sendTo, {
    method: 'POST',
    headers: payload.contentType ? { 'content-type': payload.contentType } : {},
    body: payload.body,
  })

  if (response.ok) {
    return
  }

  if (NON_RETRYABLE_STATUS.has(response.status)) {
    throw ApplicationFailure.nonRetryable(
      `webhook rejected notification: ${response.status} ${payload.sendTo}`,
      'WebhookRejected'
    )
  }

  throw new Error(`webhook delivery failed: ${response.status} ${payload.sendTo}`)
}
