# Wallet balance cache

`GET /api/v1/wallets/:id/balances` is cache-aside over Redis so frequently
polled reads (agent dashboards, risk checks) do not hit the Horizon/Soroban RPC
every time. The response envelope and body are **identical** on a hit and a
miss — caching is invisible to API consumers.

## Keys and namespace

```
balance:{environment}:{network}:{address}
```

- `environment` — `BALANCE_CACHE_ENV` (defaults to `NODE_ENV`). Two deployments
  sharing a Redis instance never share an entry.
- `network` — `testnet`, `public` or `futurenet`; the same address on two
  networks always has two entries.
- `address` — the wallet's Stellar public key.

## Staleness window

`BALANCE_CACHE_TTL` (seconds, default **30**, max 3600). An entry is rejected
when its `cachedAt` is older than the TTL even if Redis still holds it, so a
missed expiry can never serve a balance indefinitely. 30 seconds keeps
dashboards responsive while bounding worst-case staleness after an external
balance change (someone funding the wallet) to half a minute.

## Invalidation

Cache-aside with an explicit delete on write — never write-through:

- `WalletBalanceInvalidationListener` deletes the key when a transaction of that
  wallet emits a terminal domain event: `transaction.completed`,
  `transaction.failed` or `transaction.cancelled`.
- Archiving a wallet (`DELETE /wallets/:id`) deletes its key as well.
- An invalidation that races an in-flight load bumps a per-key generation, so
  the load's result is **not** written back after the delete.

## Failure behaviour

- Any Redis error (`get`, `setex`, `del`) is logged at **warn** and treated as a
  miss: the request still succeeds by calling the RPC.
- With no Redis client at all the cache is bypassed entirely.
- Concurrent misses for one key share a single in-flight loader, so a burst of
  readers produces one upstream call (no stampede).

## Configuration

See `docs/configuration.md` for `BALANCE_CACHE_TTL` and `BALANCE_CACHE_ENV`.
