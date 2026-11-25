export function assertRequiredStartupEnv(
  env: Record<string, string | undefined>,
  requiredKeys: readonly string[],
): void {
  const missing = requiredKeys.filter((k) => {
    const val = env[k];
    return typeof val !== 'string' || val.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required startup environment variables: ${missing.join(', ')}`,
    );
  }
}
