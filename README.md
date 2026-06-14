# ratelimit-mini

Zero-dependency rate limiting for Node.js. Five algorithms, one small package.

## Why

Every rate limiter on npm either pulls in 20 dependencies, only implements one algorithm, or hasn't been updated since 2019. This one gives you all the common algorithms in ~200 lines with zero deps.

## Install

```bash
npm install ratelimit-mini
```

## Algorithms

| Algorithm | Best For | Memory | Precision |
|-----------|----------|--------|-----------|
| **Token Bucket** | APIs with burst traffic | O(1) | Continuous |
| **Fixed Window** | Simple per-period limits | O(1) | Window boundary |
| **Sliding Window** | Smooth limits at scale | O(buckets) | Good (approx) |
| **Sliding Log** | Exact enforcement | O(n) | Exact |
| **Leaky Bucket** | Traffic smoothing | O(1) | Continuous |

### Quick Pick

- **API rate limiting?** → Token Bucket (allows bursts, refills continuously)
- **Strict "N per hour" limit?** → Fixed Window (simple, predictable)
- **Need smooth but efficient?** → Sliding Window (good balance)
- **Must be exact?** → Sliding Log (stores every request timestamp)
- **Smooth out spiky traffic?** → Leaky Bucket (steady outflow)

## Usage

### Token Bucket

```js
import { TokenBucket } from 'ratelimit-mini';

const bucket = new TokenBucket({ capacity: 10, rate: 5 }); // 10 burst, 5/sec refill

// Check and consume
if (bucket.tryRemove(1)) {
  handleRequest();
} else {
  rejectWith429();
}

// How long until 1 token is available?
const waitMs = bucket.waitTime(1);
```

### Fixed Window

```js
import { FixedWindow } from 'ratelimit-mini';

const limiter = new FixedWindow({ max: 100, windowMs: 60_000 }); // 100/min

if (limiter.tryAcquire()) {
  handleRequest();
}

console.log(`${limiter.remaining} requests left this window`);
console.log(`Window resets in ${limiter.msUntilReset}ms`);
```

### Sliding Window

```js
import { SlidingWindow } from 'ratelimit-mini';

// 1000 requests per hour, precision=60 buckets (1 per minute)
const limiter = new SlidingWindow({ max: 1000, windowMs: 3_600_000, precision: 60 });

limiter.tryAcquire(); // → true/false
```

### Sliding Log (exact)

```js
import { SlidingLog } from 'ratelimit-mini';

// Exact per-request tracking. Higher memory, max precision.
const limiter = new SlidingLog({ max: 100, windowMs: 60_000 });

limiter.tryAcquire(); // stores timestamp
```

### Leaky Bucket

```js
import { LeakyBucket } from 'ratelimit-mini';

// Smooths bursty traffic to a steady rate
const bucket = new LeakyBucket({ capacity: 50, rate: 10 }); // 50 buffer, 10/sec outflow

bucket.tryAdd(1); // → true if room
```

### Unified Wrapper

```js
import { RateLimiter } from 'ratelimit-mini';

const rl = new RateLimiter({
  algorithm: 'token-bucket',
  capacity: 10,
  rate: 5,
});

const { allowed, remaining } = rl.check();
```

### Per-Key Limiting

Limit per user, IP, or any identifier:

```js
import { KeyedRateLimiter, FixedWindow } from 'ratelimit-mini';

const limiter = new KeyedRateLimiter({
  factory: () => new FixedWindow({ max: 100, windowMs: 60_000 }),
});

// Each user gets their own limiter
const userLimiter = limiter.get('user-123');
userLimiter.tryAcquire();
```

### Controlling Time (for tests)

Pass a custom `now` function instead of relying on `Date.now()`:

```js
let t = 0;
const clock = { now: () => t, advance: (ms) => { t += ms; } };

const bucket = new TokenBucket({ capacity: 5, rate: 5, now: clock.now });
bucket.tryRemove(5);  // empty
clock.advance(1000); // 1 second passes
bucket.tryRemove(5);  // refilled
```

## CLI

```bash
# Test an algorithm interactively
npx ratelimit test token-bucket --capacity 5 --rate 2 --requests 10
npx ratelimit test fixed-window --max 5 --window 1000 --requests 10
npx ratelimit test sliding-window --max 5 --window 2000 --requests 10

# JSON output
npx ratelimit test token-bucket --capacity 5 --rate 2 --requests 10 --json

# Algorithm info
npx ratelimit info token-bucket --capacity 10 --rate 5
```

## API Reference

### TokenBucket

| Method | Description |
|--------|-------------|
| `tryRemove(cost?)` | Remove tokens, returns `boolean` |
| `waitTime(cost?)` | MS until enough tokens (returns 0 if available) |
| `tokens` (getter) | Current available tokens (refills on read) |
| `reset()` | Reset to full capacity |

### FixedWindow

| Method | Description |
|--------|-------------|
| `tryAcquire()` | Try to acquire, returns `boolean` |
| `remaining` (getter) | Remaining in current window |
| `msUntilReset` (getter) | MS until window resets |
| `reset()` | Reset count |

### SlidingWindow

| Method | Description |
|--------|-------------|
| `tryAcquire()` | Try to acquire, returns `boolean` |
| `remaining` (getter) | Remaining in sliding window |
| `reset()` | Clear all buckets |

### SlidingLog

| Method | Description |
|--------|-------------|
| `tryAcquire()` | Try to acquire, returns `boolean` |
| `remaining` (getter) | Remaining slots |
| `reset()` | Clear all timestamps |

### LeakyBucket

| Method | Description |
|--------|-------------|
| `tryAdd(amount?)` | Add to bucket, returns `boolean` |
| `water` (getter) | Current water level |
| `reset()` | Empty the bucket |

### RateLimiter

| Method | Description |
|--------|-------------|
| `check(cost?)` | Returns `{ allowed, remaining }` |
| `reset()` | Reset underlying limiter |

### KeyedRateLimiter

| Method | Description |
|--------|-------------|
| `get(key)` | Get/create limiter for key |
| `reset(key?)` | Reset one or all limiters |
| `size` (getter) | Number of tracked keys |
| `keys()` | Iterator over keys |

## License

MIT
