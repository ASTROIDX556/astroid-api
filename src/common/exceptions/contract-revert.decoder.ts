import {
  ConflictException,
  ContractPanicException,
  ContractRevertedException,
  DomainException,
  ForbiddenException,
  InsufficientFundsException,
} from './domain.exception';

/**
 * Decoding of raw smart-contract revert data into readable messages.
 *
 * Smart-contract failures reach the API in several different shapes:
 *  • a Soroban host error string, e.g. `HostError: Error(Contract, #4)`;
 *  • Solidity-style revert bytes: either canonical `Error(string)` /
 *    `Panic(uint256)` payloads or a custom-error selector + ABI-encoded args;
 *  • a base64/hex payload forwarded verbatim by the RPC client;
 *  • an already-decoded `{ code, message, data }` object.
 *
 * `decodeContractRevert` normalises all of them into a
 * {@link DecodedContractRevert} and never throws: payloads it cannot interpret
 * come back as `kind: 'unknown'` with the raw bytes/string preserved so nothing
 * is lost. `toContractRevertException` then turns the decoded result into a
 * typed `DomainException` (insufficient funds, forbidden, conflict, panic or a
 * generic contract revert) carrying the decoded data in its `details`.
 *
 * Contracts outside the standard set can be taught to the decoder with
 * {@link registerContractErrorAbi} (selector + signature), e.g. at module
 * bootstrap:
 *
 * ```ts
 * registerContractErrorAbi({
 *   selector: '0xa9059cbb',
 *   signature: 'InsufficientBalance(address,uint256)',
 *   description: 'Sender balance is lower than the requested transfer amount',
 * });
 * ```
 */

/** How the revert payload was interpreted. */
export type ContractRevertKind = 'contract' | 'custom' | 'message' | 'panic' | 'unknown';

/** Wire format the raw revert payload arrived in. */
export type ContractRevertDataFormat = 'hex' | 'base64' | 'bytes' | 'text' | 'object';

/** A contract error ABI entry the decoder can recognise by its 4-byte selector. */
export interface ContractErrorAbi {
  /** 4-byte selector as hex, with or without the `0x` prefix. */
  selector: string;
  /** Canonical signature, e.g. `InsufficientBalance(address,uint256)`. */
  signature: string;
  /** Short, user-facing explanation of what the error means. */
  description: string;
}

/** Raw payload, kept verbatim so unrecognised failures stay debuggable. */
export interface RawContractRevertData {
  format: ContractRevertDataFormat;
  /** Original string, or the hex encoding when the input was binary. */
  data: string;
}

/** Structured result of decoding a contract revert. */
export interface DecodedContractRevert {
  kind: ContractRevertKind;
  /** Human-readable explanation, safe to surface to API clients. */
  message: string;
  /** Contract that raised the error, when the payload identified one. */
  contractId?: string;
  /** Numeric contract error code (`Error(Contract, #N)`) when present. */
  errorCode?: number;
  /** Non-numeric error code label, e.g. `InvalidAction` from `Error(Auth, InvalidAction)`. */
  errorLabel?: string;
  /** Soroban host error category (`Contract`, `Auth`, `Value`, …). */
  hostErrorType?: string;
  /** 4-byte custom error selector (Solidity-style payloads only). */
  selector?: string;
  /** Canonical signature of a recognised custom error. */
  signature?: string;
  /** Decoded ABI arguments of a recognised custom error. */
  args?: readonly string[];
  /** Solidity `Panic(uint256)` code, when applicable. */
  panicCode?: number;
  /** The payload exactly as received (or its hex form for binary input). */
  raw: RawContractRevertData;
}

/** Canonical Solidity selectors handled without any registration. */
const ERROR_STRING_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/** Registrable custom error ABIs, keyed by normalised selector. */
const contractErrorAbis = new Map<string, ContractErrorAbi>();

/** Human-readable meanings of Solidity panic codes. */
const PANIC_REASONS: Record<number, string> = {
  0x00: 'generic compiler-inserted panic',
  0x01: 'assertion failed',
  0x11: 'arithmetic overflow or underflow',
  0x12: 'division or modulo by zero',
  0x21: 'invalid enum value',
  0x22: 'invalid storage byte array access',
  0x31: 'pop on an empty array',
  0x32: 'array index out of bounds',
  0x41: 'out of memory',
  0x51: 'call to an uninitialized function',
};

/** Revert reasons that map onto an existing, more specific error code. */
const INSUFFICIENT_FUNDS_PATTERN =
  /insufficient (funds|balance|allowance|collateral|liquidity)|not enough (funds|balance)|balance too low|exceeds? (the )?(available )?balance/i;
const UNAUTHORIZED_PATTERN =
  /unauthori[sz]ed|not authorized|forbidden|access denied|caller is not the owner|not the owner|missing (role|permission)|auth(?:entication|orization)? (?:failed|required)|invalid signature/i;
const CONFLICT_PATTERN =
  /already (?:initiali[sz]ed|exists|registered|claimed|set)|duplicate (?:entry|record|key)|reentrancy|nonce (?:already )?used/i;

/**
 * Registers a custom contract error ABI so its selector decodes to a readable
 * message. Registering the same selector twice replaces the previous entry,
 * which lets tests and multi-tenant deployments override a definition.
 *
 * @throws TypeError when the selector is not exactly four bytes of hex.
 */
export function registerContractErrorAbi(abi: ContractErrorAbi): void {
  const selector = normalizeSelector(abi.selector);
  if (!selector) {
    throw new TypeError(
      `Contract error selector must be 4 bytes of hex, received '${abi.selector}'`,
    );
  }
  contractErrorAbis.set(selector, { ...abi, selector });
}

/** Returns the currently registered custom error ABIs (for diagnostics/tests). */
export function listContractErrorAbis(): ContractErrorAbi[] {
  return [...contractErrorAbis.values()];
}

/**
 * Decodes any supported revert payload. Never throws: malformed, truncated or
 * unknown data yields `kind: 'unknown'` with `raw` intact.
 */
export function decodeContractRevert(input: unknown): DecodedContractRevert {
  try {
    return decodeInput(input);
  } catch (error) {
    return {
      kind: 'unknown',
      message: `Unrecognised contract revert data: ${errorMessage(error)}`,
      raw: { format: 'text', data: safeStringify(input) },
    };
  }
}

/**
 * Converts a decoded revert into the most descriptive domain exception:
 *  • panics            → {@link ContractPanicException}
 *  • insufficient funds→ {@link InsufficientFundsException}
 *  • auth failures     → {@link ForbiddenException}
 *  • duplicate state   → {@link ConflictException}
 *  • everything else   → {@link ContractRevertedException}
 *
 * Every result carries the full decoded payload in `details.contractError`,
 * including the raw bytes, so callers can debug without re-decoding.
 */
export function isRecognisedContractRevert(decoded: DecodedContractRevert): boolean {
  return (
    decoded.kind === 'contract' ||
    decoded.kind === 'custom' ||
    decoded.kind === 'panic' ||
    decoded.signature !== undefined
  );
}

export function toContractRevertException(decoded: DecodedContractRevert): DomainException {
  const details = { contractError: decoded };

  if (decoded.kind === 'panic') {
    return new ContractPanicException(decoded.message, details);
  }
  if (INSUFFICIENT_FUNDS_PATTERN.test(decoded.message)) {
    return new InsufficientFundsException(decoded.message, details);
  }
  if (decoded.hostErrorType === 'Auth' || UNAUTHORIZED_PATTERN.test(decoded.message)) {
    return new ForbiddenException(decoded.message, details);
  }
  if (CONFLICT_PATTERN.test(decoded.message)) {
    return new ConflictException(decoded.message, details);
  }
  return new ContractRevertedException(`Contract call reverted: ${decoded.message}`, details);
}

// ── decoding internals ────────────────────────────────────────────────────

function decodeInput(input: unknown): DecodedContractRevert {
  if (input === null || input === undefined) {
    return unknownRevert({ format: 'text', data: '' }, 'No contract revert data was provided');
  }
  if (input instanceof Error) {
    return decodeError(input);
  }
  if (input instanceof Uint8Array) {
    return decodeBytes(input, 'bytes', bytesToHex(input));
  }
  if (typeof input === 'string') {
    return decodeString(input);
  }
  if (typeof input === 'object') {
    return decodeObject(input as Record<string, unknown>);
  }
  return unknownRevert(
    { format: 'text', data: String(input) },
    `Unsupported revert payload: ${String(input)}`,
  );
}

function decodeError(error: Error): DecodedContractRevert {
  const candidate = error as Error & { revertData?: unknown; data?: unknown };
  const payload = candidate.revertData ?? candidate.data;
  if (payload !== undefined && payload !== null) {
    return decodeInput(payload);
  }
  return decodeString(error.message);
}

function decodeObject(value: Record<string, unknown>): DecodedContractRevert {
  const contractId = firstString(value.contractId, value.contract_id);
  const nestedError = value.error;

  // `{ error: { ... } }` — unwrap and keep the outer contract id.
  if (nestedError && typeof nestedError === 'object' && !(nestedError instanceof Error)) {
    return withContext(decodeObject(nestedError as Record<string, unknown>), contractId);
  }

  const numericCode = toErrorCode(value.errorCode ?? value.error_code ?? value.code);

  const payload =
    value.revertData ?? value.revert_data ?? value.data ?? value.returnValue ?? value.return_value;

  if (typeof payload === 'string' || payload instanceof Uint8Array) {
    return withContext(decodeInput(payload), contractId, numericCode);
  }

  if (nestedError instanceof Error) {
    return withContext(decodeError(nestedError), contractId, numericCode);
  }
  if (typeof nestedError === 'string') {
    return withContext(decodeString(nestedError), contractId, numericCode);
  }
  if (typeof value.message === 'string') {
    return withContext(decodeString(value.message), contractId, numericCode);
  }
  if (numericCode !== undefined) {
    return {
      kind: 'contract',
      message: `Contract error #${numericCode}`,
      contractId,
      errorCode: numericCode,
      raw: { format: 'object', data: safeStringify(value) },
    };
  }
  return unknownRevert(
    { format: 'object', data: safeStringify(value) },
    'Contract revert payload did not contain a recognisable error',
  );
}

function decodeString(input: string): DecodedContractRevert {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return unknownRevert({ format: 'text', data: input }, 'Contract revert reason was empty');
  }

  const hexBytes = toHexBytes(trimmed);
  if (hexBytes) {
    return decodeBytes(hexBytes, 'hex', trimmed);
  }

  const base64Bytes = toBase64Bytes(trimmed);
  if (base64Bytes) {
    return decodeBytes(base64Bytes, 'base64', trimmed);
  }

  const hostError = parseHostError(trimmed);
  if (hostError) {
    return hostError;
  }

  if (/^0x[0-9a-f]*$/i.test(trimmed)) {
    return unknownRevert(
      { format: 'hex', data: input },
      'Contract revert payload is not valid hex-encoded data',
    );
  }

  return { kind: 'message', message: trimmed, raw: { format: 'text', data: input } };
}

function decodeBytes(
  bytes: Uint8Array,
  format: ContractRevertDataFormat,
  rawData: string,
): DecodedContractRevert {
  const hex = bytesToHex(bytes);
  const raw: RawContractRevertData = { format, data: rawData };

  if (bytes.length < 4) {
    return unknownRevert(
      raw,
      `Revert payload is too short (${bytes.length} bytes) to contain a selector`,
      hex,
    );
  }

  const selector = `0x${bytesToHex(bytes.subarray(0, 4))}`;
  const args = bytes.subarray(4);

  if (selector === ERROR_STRING_SELECTOR) {
    return {
      kind: 'message',
      message: decodeAbiString(args) ?? 'Contract reverted without a reason',
      selector,
      signature: 'Error(string)',
      raw,
    };
  }

  if (selector === PANIC_SELECTOR) {
    const panicCode = decodeAbiUint(args);
    const reason =
      panicCode === undefined
        ? 'unknown panic code'
        : (PANIC_REASONS[panicCode] ?? `unknown panic code 0x${panicCode.toString(16)}`);
    return {
      kind: 'panic',
      message: `Contract panicked: ${reason}`,
      selector,
      signature: 'Panic(uint256)',
      panicCode,
      raw,
    };
  }

  const known = contractErrorAbis.get(selector);
  if (known) {
    const decodedArgs = decodeAbiArgs(args, known.signature);
    const argsSuffix = decodedArgs.length > 0 ? ` (args: ${decodedArgs.join(', ')})` : '';
    return {
      kind: 'custom',
      message: `${known.description}${argsSuffix}`,
      selector,
      signature: known.signature,
      args: decodedArgs,
      raw,
    };
  }

  return unknownRevert(raw, `Unrecognised contract revert (selector ${selector})`, selector);
}

/**
 * Parses Soroban host errors such as `Error(Contract, #4)` or
 * `Error(Auth, InvalidAction)`, with or without the `HostError:` prefix.
 */
function parseHostError(text: string): DecodedContractRevert | undefined {
  const match = /Error\(\s*([A-Za-z]+)\s*,\s*#?([A-Za-z0-9_]+)\s*\)/.exec(text);
  if (!match) {
    return undefined;
  }

  const [, hostErrorType, label] = match;
  const numericCode = /^\d+$/.test(label) ? Number(label) : undefined;
  const message =
    numericCode !== undefined
      ? `Contract execution failed with ${hostErrorType} error #${numericCode}`
      : `Contract execution failed with ${hostErrorType} error ${label}`;

  return {
    kind: 'contract',
    message,
    errorCode: numericCode,
    errorLabel: numericCode === undefined ? label : undefined,
    hostErrorType,
    raw: { format: 'text', data: text },
  };
}

// ── small helpers ─────────────────────────────────────────────────────────

function unknownRevert(
  raw: RawContractRevertData,
  message: string,
  selector?: string,
): DecodedContractRevert {
  return { kind: 'unknown', message, selector, raw };
}

function withContext(
  decoded: DecodedContractRevert,
  contractId?: string,
  errorCode?: number,
): DecodedContractRevert {
  if (decoded.kind === 'unknown') {
    return decoded;
  }
  return {
    ...decoded,
    contractId: decoded.contractId ?? contractId,
    errorCode: decoded.errorCode ?? errorCode,
  };
}

function normalizeSelector(value: string): string | undefined {
  const stripped = value.trim().toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{8}$/.test(stripped) ? `0x${stripped}` : undefined;
}

function toErrorCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, nested: unknown) => {
        if (typeof nested === 'object' && nested !== null) {
          if (seen.has(nested)) {
            return '[Circular]';
          }
          seen.add(nested);
        }
        return nested;
      }) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function toHexBytes(value: string): Uint8Array | undefined {
  const stripped = value.replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(stripped) || stripped.length % 2 !== 0 || stripped.length < 8) {
    return undefined;
  }
  return new Uint8Array(Buffer.from(stripped, 'hex'));
}

function toBase64Bytes(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length < 8) {
    return undefined;
  }
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = new Uint8Array(Buffer.from(normalised, 'base64'));
  // Round-trip check so plain words that happen to be valid base64 characters
  // are not mistaken for encoded revert payloads.
  if (bytes.length < 4 || Buffer.from(bytes).toString('base64') !== normalised) {
    return undefined;
  }
  return bytes;
}

// ── minimal ABI reader ────────────────────────────────────────────────────

function readWord(args: Uint8Array, index: number): bigint | undefined {
  if (args.length < (index + 1) * 32) {
    return undefined;
  }
  return BigInt(`0x${bytesToHex(args.subarray(index * 32, (index + 1) * 32))}`);
}

function decodeAbiUint(args: Uint8Array): number | undefined {
  const word = readWord(args, 0);
  return word === undefined ? undefined : Number(word);
}

function decodeAbiString(args: Uint8Array): string | undefined {
  const offset = readWord(args, 0);
  return offset === undefined ? undefined : readAbiString(args, Number(offset));
}

/** Reads a length-prefixed string that starts at `start` bytes into `args`. */
function readAbiString(args: Uint8Array, start: number): string | undefined {
  const length = readWord(args, start / 32);
  if (length === undefined) {
    return undefined;
  }
  const body = args.subarray(start + 32, start + 32 + Number(length));
  if (body.length !== Number(length)) {
    return undefined;
  }
  return Buffer.from(body).toString('utf8');
}

function decodeAbiArgs(args: Uint8Array, signature: string): string[] {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open === -1 || close <= open + 1) {
    return [];
  }
  const types = signature
    .slice(open + 1, close)
    .split(',')
    .map((type) => type.trim());

  try {
    return types.map((type, index) => decodeAbiArg(args, type, index));
  } catch {
    return [];
  }
}

function decodeAbiArg(args: Uint8Array, type: string, index: number): string {
  if (type === 'string' || type === 'bytes') {
    const offset = readWord(args, index);
    if (offset === undefined) {
      return '0x';
    }
    if (type === 'string') {
      return readAbiString(args, Number(offset)) ?? '';
    }
    const length = readWord(args, Number(offset) / 32);
    if (length === undefined) {
      return '0x';
    }
    return `0x${bytesToHex(args.subarray(Number(offset) + 32, Number(offset) + 32 + Number(length)))}`;
  }

  const word = readWord(args, index);
  if (word === undefined) {
    return '0x';
  }

  if (type === 'address') {
    return `0x${word.toString(16).padStart(40, '0')}`;
  }
  if (type === 'bool') {
    return word === 0n ? 'false' : 'true';
  }
  if (type.startsWith('int')) {
    const bits = Number(type.slice(3) || 256);
    const unsigned = BigInt.asUintN(bits, word);
    const signed = unsigned >= 1n << BigInt(bits - 1) ? unsigned - (1n << BigInt(bits)) : unsigned;
    return signed.toString();
  }
  if (type.startsWith('bytes')) {
    const size = Number(type.slice(5) || 32);
    return `0x${bytesToHex(args.subarray(index * 32, index * 32 + size))}`;
  }
  return word.toString();
}
