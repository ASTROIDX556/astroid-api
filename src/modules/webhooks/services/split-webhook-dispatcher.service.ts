import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';

export type SplitWebhookEventType =
  | 'split.transfer.completed'
  | 'split.configuration.updated';

export interface SplitWebhookEventPayload {
  eventId: string;
  eventType: SplitWebhookEventType;
  organizationId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface SplitWebhookSubscription {
  id: string;
  url: string;
  secret: string;
  active: boolean;
  events: SplitWebhookEventType[];
}

export interface SplitWebhookDeliveryResult {
  subscriptionId: string;
  url: string;
  delivered: boolean;
  statusCode?: number;
  signature: string;
  error?: string;
}

@Injectable()
export class SplitWebhookDispatcherService {
  signPayload(rawBody: string, secret: string, timestamp: string): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(`${timestamp}.${rawBody}`);
    return `sha256=${hmac.digest('hex')}`;
  }

  async dispatchSplitEvent(
    event: SplitWebhookEventPayload,
    subscriptions: SplitWebhookSubscription[],
    transport: (
      url: string,
      headers: Record<string, string>,
      body: string,
    ) => Promise<{ statusCode: number }>,
  ): Promise<SplitWebhookDeliveryResult[]> {
    const eligible = subscriptions.filter(
      (sub) => sub.active && sub.events.includes(event.eventType),
    );
    const body = JSON.stringify(event);

    const results = await Promise.all(
      eligible.map(async (sub): Promise<SplitWebhookDeliveryResult> => {
        const signature = this.signPayload(body, sub.secret, event.occurredAt);
        try {
          const response = await transport(
            sub.url,
            {
              'Content-Type': 'application/json',
              'X-Astroid-Event': event.eventType,
              'X-Astroid-Delivery': event.eventId,
              'X-Astroid-Timestamp': event.occurredAt,
              'X-Astroid-Signature': signature,
            },
            body,
          );
          const delivered = response.statusCode >= 200 && response.statusCode < 300;
          return {
            subscriptionId: sub.id,
            url: sub.url,
            delivered,
            statusCode: response.statusCode,
            signature,
          };
        } catch (err) {
          return {
            subscriptionId: sub.id,
            url: sub.url,
            delivered: false,
            signature,
            error: err instanceof Error ? err.message : 'Delivery failed',
          };
        }
      }),
    );

    return results;
  }
}
