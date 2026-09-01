import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { Request } from 'express';

@Injectable()
export class AgentSignatureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    
    const signature = request.headers['x-agent-signature'] as string;
    const publicKey = request.headers['x-agent-publickey'] as string;
    const timestampStr = request.headers['x-agent-timestamp'] as string;

    if (!signature || !publicKey || !timestampStr) {
      throw new UnauthorizedException('Missing required agent signature headers');
    }

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) {
      throw new UnauthorizedException('Invalid timestamp format');
    }

    // 5-minute variance window
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    if (Math.abs(now - timestamp) > fiveMinutes) {
      throw new UnauthorizedException('Timestamp out of valid window (possible replay attack)');
    }

    // Extract raw body
    // In a real NestJS app, raw body must be buffered. We assume `request.body` is available as a string or buffer,
    // or we construct the payload to sign. Often the payload is `timestamp + '.' + rawBody`.
    // We will assume the payload to verify is the timestamp concatenated with the raw body.
    let rawBody = '';
    if (request.body) {
       rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    }
    const messageToVerify = `${timestampStr}.${rawBody}`;

    try {
      const keypair = Keypair.fromPublicKey(publicKey);
      const isValid = keypair.verify(
        Buffer.from(messageToVerify),
        Buffer.from(signature, 'base64')
      );

      if (!isValid) {
        throw new UnauthorizedException('Invalid agent signature');
      }
    } catch {
      throw new UnauthorizedException('Malformed signature or public key');
    }

    // Attach agent context
    (request as unknown as Record<string, unknown>).agent = { publicKey };
    
    return true;
  }
}
