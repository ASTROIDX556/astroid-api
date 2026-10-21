import { describe, it, expect } from 'vitest';
import { ApiStandardResponse, ApiEnvelopeDto } from './api-response.decorator';

class SampleWalletDto {
  id!: string;
}

describe('ApiStandardResponse (#417)', () => {
  it('returns a valid method decorator for single and array DTO responses', () => {
    const singleDecorator = ApiStandardResponse(SampleWalletDto);
    const arrayDecorator = ApiStandardResponse(SampleWalletDto, { isArray: true });
    expect(typeof singleDecorator).toBe('function');
    expect(typeof arrayDecorator).toBe('function');
    expect(new ApiEnvelopeDto()).toBeInstanceOf(ApiEnvelopeDto);
  });
});
