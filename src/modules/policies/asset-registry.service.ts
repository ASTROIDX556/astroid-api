import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssetIdentifier, NATIVE_ASSET_CODE, parseAssetIdentifier } from '../../utils/asset.util';
import { ValidationException } from '../../common/exceptions/domain.exception';
import { StellarConfig } from '../../config/stellar.config';

/**
 * Resolves the assets a request refers to into canonical Stellar identifiers.
 *
 * The registry is the single place that knows which Stellar Anchor assets the
 * deployment supports (see `STELLAR_ANCHOR_ASSETS`). A bare ticker that is
 * configured as an anchor is expanded to the canonical `CODE:ISSUER` form the
 * network understands, so a request for `USDC` and a request for
 * `USDC:GA5Z…` describe the very same asset and aggregate together.
 *
 * Unknown tickers are *not* rejected here: the API has always accepted any
 * asset string and the network client produces the authoritative error for
 * assets that do not exist. Rejecting them centrally would change the
 * behaviour of existing single-asset requests.
 */
@Injectable()
export class AssetRegistryService {
  constructor(private readonly config: ConfigService) {}

  /** The configured Stellar Anchor assets, keyed by upper-case ticker. */
  get anchorAssets(): Record<string, string> {
    return this.config.get<StellarConfig>('stellar')?.anchorAssets ?? {};
  }

  /**
   * Parses a submitted asset string into its descriptor.
   *
   * @throws ValidationException when the identifier is malformed.
   */
  describe(raw: string): AssetIdentifier {
    let parsed: AssetIdentifier;
    try {
      parsed = parseAssetIdentifier(raw);
    } catch (error) {
      throw new ValidationException((error as Error).message, { asset: raw });
    }
    return parsed;
  }

  /**
   * Returns the canonical identifier used for persistence and aggregation:
   * `XLM` for the native asset, `CODE:ISSUER` for a credit asset whose issuer
   * is known, and the bare `CODE` otherwise.
   */
  canonicalize(raw: string): string {
    const parsed = this.describe(raw);
    if (parsed.native) {
      return NATIVE_ASSET_CODE;
    }
    if (parsed.issuer) {
      return parsed.canonical;
    }
    const issuer = this.anchorAssets[parsed.code];
    return issuer ? `${parsed.code}:${issuer}` : parsed.code;
  }

  /** True when the asset code refers to a configured Stellar Anchor asset. */
  isAnchorAsset(raw: string): boolean {
    const parsed = this.describe(raw);
    return !parsed.native && Boolean(this.anchorAssets[parsed.code]);
  }

  /** The issuer of a configured anchor asset, if the code is one. */
  issuerFor(code: string): string | undefined {
    return this.anchorAssets[code.toUpperCase()];
  }
}
