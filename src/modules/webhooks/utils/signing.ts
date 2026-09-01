import { createHmac } from 'crypto';

export function signWebhookPayload(secret: string, timestamp: string, payload: string): string {
  return createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
}
