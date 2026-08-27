import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { StellarConfig } from '../../../config/stellar.config';
import { ErrorCode } from '../../../common/constants/error-codes';
import { DomainException } from '../../../common/exceptions/domain.exception';

export interface SignatureVerificationResult {
  isValid: boolean;
  matchingSigners: string[];
  unrecognizedSigners: string[];
  totalWeight: number;
  thresholdMet: boolean;
  signatureCount: number;
}

/**
 * Service for parsing and verifying Stellar transaction envelopes.
 * Handles multi-signature verification against expected signers.
 */
@Injectable()
export class StellarTransactionService {
  constructor(private readonly config: ConfigService) {}

  /**
   * Parses a Stellar transaction envelope and verifies signatures.
   * @param xdr - Base64 encoded transaction envelope
   * @param expectedSigners - Array of expected public key signers
   * @returns Signature verification result with detailed metadata
   */
  parseAndVerifyEnvelope(xdr: string, expectedSigners: string[]): SignatureVerificationResult {
    try {
      const envelope = (global as unknown as { xdr: { TransactionEnvelope: { fromXDR: (xdr: string, format: string) => unknown } } }).xdr.TransactionEnvelope.fromXDR(xdr, 'base64') as { tx: () => { signatures?: unknown[]; hash: (passphrase: string) => Buffer } };
      const tx = envelope.tx();

      if (!tx.signatures || tx.signatures.length === 0) {
        return this.createEmptyResult();
      }

      const stellarConfig = this.config.get<StellarConfig>('stellar');
      const networkPassphrase = stellarConfig?.network === 'public' 
        ? Networks.PUBLIC 
        : Networks.TESTNET;

      const txHash = tx.hash(networkPassphrase);
      const signatureSet = tx.signatures;

      const matchingSigners: string[] = [];
      const unrecognizedSigners: string[] = [];

      for (const signature of signatureSet) {
        const sig = signature as { signature: () => Buffer; hint: () => Buffer };
        const signatureBuf = sig.signature();
        const hint = sig.hint();

        let found = false;
        for (const expectedSigner of expectedSigners) {
          try {
            const keypair = Keypair.fromPublicKey(expectedSigner);
            if (keypair.verify(txHash, signatureBuf)) {
              matchingSigners.push(expectedSigner);
              found = true;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!found) {
          unrecognizedSigners.push(hint.toString('base64'));
        }
      }

      return {
        isValid: matchingSigners.length > 0,
        matchingSigners,
        unrecognizedSigners,
        totalWeight: matchingSigners.length,
        thresholdMet: matchingSigners.length > 0,
        signatureCount: signatureSet.length,
      };
    } catch (error) {
      if ((error as Error).message.includes('Invalid XDR')) {
        throw new DomainException(
          ErrorCode.INVALID_STELLAR_TRANSACTION,
          'Invalid transaction envelope format',
        );
      }
      throw new DomainException(
        ErrorCode.STELLAR_ERROR,
        `Failed to parse transaction envelope: ${(error as Error).message}`,
      );
    }
  }

  private createEmptyResult(): SignatureVerificationResult {
    return {
      isValid: false,
      matchingSigners: [],
      unrecognizedSigners: [],
      totalWeight: 0,
      thresholdMet: false,
      signatureCount: 0,
    };
  }
}
