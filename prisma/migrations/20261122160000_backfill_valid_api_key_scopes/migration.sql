UPDATE "api_keys" AS api_key
SET "scopes" = ARRAY(
  SELECT granted.scope
  FROM unnest(
    COALESCE(api_key."scopes", ARRAY[]::TEXT[]) ||
    COALESCE(api_key."permissions", ARRAY[]::TEXT[])
  ) AS granted(scope)
  WHERE granted.scope = ANY(
    ARRAY['read', 'write', 'transactions:execute', 'webhooks:manage']::TEXT[]
  )
  GROUP BY granted.scope
  ORDER BY array_position(
    ARRAY['read', 'write', 'transactions:execute', 'webhooks:manage']::TEXT[],
    granted.scope
  )
);
