import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { signWebhookPayload } from './signing';

describe('signWebhookPayload', () => {
  it('should generate expected signature', () => {
    const secret = 'test-secret';
    const timestamp = '1234567890';
    const payload = JSON.stringify({ event: 'test.event' });
    
    const signature = signWebhookPayload(secret, timestamp, payload);
    
    const expected = createHmac('sha256', secret).update(timestamp + '.' + payload).digest('hex');
    expect(signature).toBe(expected);
  });
});
