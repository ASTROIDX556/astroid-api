/**
 * Stellar asset identity helpers.
 *
 * A Stellar asset is either the native asset (`XLM`) or a credit asset issued
 * by an account. The network identifies a credit asset by the pair
 * `CODE:ISSUER`, while operators usually refer to well-known Stellar Anchor
 * assets by their ticker alone (`USDC`).
 *
 * This module is deliberately dependency-free and side-effect free so the
 * policy engine, the transaction pipeline and the API boundary can all share
 * exactly one notion of "which asset is this?".
 */

/** Ticker of the native (Lumens) asset. */
export const NATIVE_ASSET_CODE = 'XLM';

/** Maximum length of a Stellar asset code. */
export const ASSET_CODE_MAX_LENGTH = 12;

/** A parsed Stellar asset identifier. */
export interface AssetIdentifier {
  /** Upper-case asset code, e.g. `XLM` or `USDC`. */
  code: string;
  /** Issuing account for credit assets; undefined for the native asset. */
  issuer?: string;
  /**
   * Canonical identifier used for persistence, aggregation and comparison:
   * `XLM` for the native asset, `CODE:ISSUER` for a resolved credit asset and
   * a bare `CODE` when the issuer could not be resolved.
   */
  canonical: string;
  /** True when the asset is the native asset. */
  native: boolean;
}

/** True when the value is a syntactically valid Stellar asset code. */
export function isValidAssetCode(value: string): boolean {
  return /^[A-Za-z0-9]{1,12}$/.test(value);
}

/** True when the value looks like a Stellar account address (`G…`). */
export function isValidIssuerAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value);
}

/**
 * Parses an asset identifier of the form `CODE` or `CODE:ISSUER`.
 *
 * @throws Error when the identifier is malformed. API boundaries validate the
 * payload with the Zod schema first, so a throw here signals a programming
 * error rather than user input.
 */
export function parseAssetIdentifier(raw: string): AssetIdentifier {
  const value = raw.trim();
  if (!value) {
    throw new Error('Asset identifier must not be empty');
  }

  const separator = value.indexOf(':');
  if (separator === -1) {
    if (!isValidAssetCode(value)) {
      throw new Error(
        `Invalid asset '${raw}': a bare asset code must be 1-12 alphanumeric characters`,
      );
    }
    const code = value.toUpperCase();
    return { code, canonical: code, native: code === NATIVE_ASSET_CODE };
  }

  const code = value.slice(0, separator).trim().toUpperCase();
  const issuer = value.slice(separator + 1).trim();
  if (!isValidAssetCode(code)) {
    throw new Error(`Invalid asset '${raw}': the asset code must be 1-12 alphanumeric characters`);
  }
  if (!isValidIssuerAddress(issuer)) {
    throw new Error(`Invalid asset '${raw}': the issuer must be a Stellar account address (G…)`);
  }
  if (code === NATIVE_ASSET_CODE) {
    throw new Error(`Invalid asset '${raw}': the native asset ${NATIVE_ASSET_CODE} has no issuer`);
  }
  return { code, issuer, canonical: `${code}:${issuer}`, native: false };
}

/**
 * Returns the upper-case asset code of an identifier, ignoring any issuer.
 * `USDC:GA5Z…` and `USDC` both yield `USDC`, which is the key used by
 * asset-scoped policy configuration.
 */
export function assetCodeOf(raw: string): string {
  return parseAssetIdentifier(raw).code;
}

/** True when the identifier refers to the native asset. */
export function isNativeAsset(raw: string): boolean {
  return parseAssetIdentifier(raw).native;
}
