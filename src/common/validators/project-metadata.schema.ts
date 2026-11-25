import { z } from 'zod';

const HTML_TAG_REGEX = /<[^>]*>/g;
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizeMetadataText(input: string): string {
  return input
    .replace(HTML_TAG_REGEX, '')
    .replace(CONTROL_CHARS_REGEX, '')
    .trim();
}

export const httpsUrlSchema = z
  .string()
  .trim()
  .url('Must be a valid URL')
  .refine(
    (val) => {
      try {
        return new URL(val).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'External project URLs must use the https:// scheme' },
  );

export const updateProjectMetadataSchema = z.object({
  displayName: z
    .string()
    .transform(sanitizeMetadataText)
    .pipe(
      z
        .string()
        .min(2, 'Project display name must be at least 2 characters')
        .max(80, 'Project display name cannot exceed 80 characters'),
    ),
  description: z
    .string()
    .transform(sanitizeMetadataText)
    .pipe(
      z
        .string()
        .max(500, 'Project description cannot exceed 500 characters'),
    )
    .optional(),
  websiteUrl: httpsUrlSchema.optional(),
  repositoryUrl: httpsUrlSchema.optional(),
});

export type UpdateProjectMetadataInput = z.infer<
  typeof updateProjectMetadataSchema
>;
