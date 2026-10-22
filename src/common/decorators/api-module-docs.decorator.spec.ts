import { describe, expect, it } from 'vitest';
import { ApiModuleEndpointDocs } from './api-module-docs.decorator';

class SampleTransactionDto {
  id!: string;
}

describe('ApiModuleEndpointDocs (#441)', () => {
  it('applies standardized OpenAPI metadata across domain module handlers', () => {
    class TestController {
      @ApiModuleEndpointDocs({
        tag: 'transactions',
        summary: 'List organization transactions',
        model: SampleTransactionDto,
        isArray: true,
      })
      list() {
        return [];
      }
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      TestController.prototype,
      'list',
    );
    expect(descriptor?.value).toBeTypeOf('function');
    const summaryMeta = Reflect.getMetadata(
      'swagger/apiOperation',
      TestController.prototype.list,
    );
    expect(summaryMeta).toEqual({
      summary: 'List organization transactions',
      description: 'List organization transactions',
    });
  });
});
