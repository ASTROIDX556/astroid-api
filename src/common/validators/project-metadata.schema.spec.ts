import { describe, expect, it } from 'vitest';
import {
  sanitizeMetadataText,
  updateProjectMetadataSchema,
} from './project-metadata.schema';

describe('updateProjectMetadataSchema (#308)', () => {
  it('strips dangerous HTML/script tags and validates HTTPS external URLs', () => {
    const parsed = updateProjectMetadataSchema.parse({
      displayName: '  <b>Astroid Core</b><script>alert(1)</script>  ',
      description: '<p>Autonomous agent treasury</p>',
      websiteUrl: 'https://astroid.dev/docs',
    });

    expect(parsed.displayName).toBe('Astroid Corealert(1)');
    expect(parsed.description).toBe('Autonomous agent treasury');
    expect(parsed.websiteUrl).toBe('https://astroid.dev/docs');
  });

  it('rejects non-HTTPS URLs and oversized project descriptions', () => {
    const insecureUrl = updateProjectMetadataSchema.safeParse({
      displayName: 'Astroid',
      websiteUrl: 'http://insecure.example.com',
    });
    expect(insecureUrl.success).toBe(false);

    const oversized = updateProjectMetadataSchema.safeParse({
      displayName: 'Astroid',
      description: 'x'.repeat(501),
    });
    expect(oversized.success).toBe(false);
  });

  it('removes control characters from raw metadata strings', () => {
    expect(sanitizeMetadataText('Hello\u0000\u0007 World')).toBe('Hello World');
  });
});
