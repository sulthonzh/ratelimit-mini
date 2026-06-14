// ratelimit-mini — Zero-dep rate limiting
// Algorithms: Token Bucket, Fixed Window, Sliding Window, Leaky Bucket

/**
 * Token Bucket Algorithm
 * Tokens refill continuously at `rate` tokens/sec.
 * Bucket holds at most `capacity` tokens.
 * Each request consumes `cost` tokens (default 1).
 */
export class TokenBucket {
  constructor({ capacity, rate, cost = 1, now = Date.now }) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
    if (rate <= 0) throw new Error('rate must be > 0');
    this.capacity = capacity;
    this.rate = rate;
    this.cost = cost;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._tokens = capacity;
    this._lastRefill = this._now();
  }

  _refill() {
    const now = this._now();
    const elapsed = (now - this._lastRefill) / 1000;
    this._tokens = Math.min(this.capacity, this._tokens + elapsed * this.rate);
    this._lastRefill = now;
  }

  tryRemove(cost = this.cost) {
    this._refill();
    if (this._tokens >= cost) {
      this._tokens -= cost;
      return true;
    }
    return false;
  }

  /** Returns wait time in ms until enough tokens are available */
  waitTime(cost = this.cost) {
    this._refill();
    if (this._tokens >= cost) return 0;
    const needed = cost - this._tokens;
    return Math.ceil((needed / this.rate) * 1000);
  }

  get tokens() {
    this._refill();
    return this._tokens;
  }

  reset() {
    this._tokens = this.capacity;
    this._lastRefill = this._now();
  }
}

/**
 * Fixed Window Algorithm
 * Limits to `maxRequests` per `windowMs` time window.
 * Window resets at fixed intervals (aligned to epoch).
 */
export class FixedWindow {
  constructor({ max, windowMs, now = Date.now }) {
    if (max <= 0) throw new Error('max must be > 0');
    if (windowMs <= 0) throw new Error('windowMs must be > 0');
    this.max = max;
    this.windowMs = windowMs;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._count = 0;
    this._windowStart = this._currentWindowStart();
  }

  _currentWindowStart() {
    return Math.floor(this._now() / this.windowMs) * this.windowMs;
  }

  _resetIfNeeded() {
    const ws = this._currentWindowStart();
    if (ws > this._windowStart) {
      this._windowStart = ws;
      this._count = 0;
    }
  }

  tryAcquire() {
    this._resetIfNeeded();
    if (this._count < this.max) {
      this._count++;
      return true;
    }
    return false;
  }

  /** ms until the current window resets */
  get msUntilReset() {
    this._resetIfNeeded();
    return this._windowStart + this.windowMs - this._now();
  }

  get remaining() {
    this._resetIfNeeded();
    return Math.max(0, this.max - this._count);
  }

  reset() {
    this._count = 0;
    this._windowStart = this._currentWindowStart();
  }
}

/**
 * Sliding Window Algorithm (approximated)
 * Uses a rolling window with precision buckets.
 * More accurate than fixed window, less memory than sliding log.
 */
export class SlidingWindow {
  constructor({ max, windowMs, precision = 10, now = Date.now }) {
    if (max <= 0) throw new Error('max must be > 0');
    if (windowMs <= 0) throw new Error('windowMs must be > 0');
    if (precision < 1) throw new Error('precision must be >= 1');
    this.max = max;
    this.windowMs = windowMs;
    this.bucketMs = Math.ceil(windowMs / precision);
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._buckets = new Map();
  }

  _evict() {
    const cutoff = this._now() - this.windowMs;
    for (const [ts] of this._buckets) {
      if (ts <= cutoff) this._buckets.delete(ts);
    }
  }

  _currentCount() {
    this._evict();
    let sum = 0;
    for (const v of this._buckets.values()) sum += v;
    return sum;
  }

  tryAcquire() {
    const count = this._currentCount();
    if (count >= this.max) return false;
    const now = this._now();
    const bucketKey = Math.floor(now / this.bucketMs) * this.bucketMs;
    this._buckets.set(bucketKey, (this._buckets.get(bucketKey) || 0) + 1);
    return true;
  }

  get remaining() {
    return Math.max(0, this.max - this._currentCount());
  }

  reset() {
    this._buckets.clear();
  }
}

/**
 * Sliding Window Log Algorithm (exact)
 * Stores individual timestamps for precise rate limiting.
 * Higher memory usage but most accurate.
 */
export class SlidingLog {
  constructor({ max, windowMs, now = Date.now }) {
    if (max <= 0) throw new Error('max must be > 0');
    if (windowMs <= 0) throw new Error('windowMs must be > 0');
    this.max = max;
    this.windowMs = windowMs;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._events = [];
  }

  _evict() {
    const cutoff = this._now() - this.windowMs;
    while (this._events.length > 0 && this._events[0] <= cutoff) {
      this._events.shift();
    }
  }

  tryAcquire() {
    this._evict();
    if (this._events.length >= this.max) return false;
    this._events.push(this._now());
    return true;
  }

  get remaining() {
    this._evict();
    return Math.max(0, this.max - this._events.length);
  }

  reset() {
    this._events = [];
  }
}

/**
 * Leaky Bucket Algorithm
 * Requests pour in, leak out at steady `rate` requests/sec.
 * Bucket overflows if `capacity` exceeded. Smooths burst traffic.
 */
export class LeakyBucket {
  constructor({ capacity, rate, now = Date.now }) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
    if (rate <= 0) throw new Error('rate must be > 0');
    this.capacity = capacity;
    this.rate = rate;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._water = 0;
    this._lastLeak = this._now();
  }

  _leak() {
    const now = this._now();
    const elapsed = (now - this._lastLeak) / 1000;
    const leaked = elapsed * this.rate;
    this._water = Math.max(0, this._water - leaked);
    this._lastLeak = now;
  }

  tryAdd(amount = 1) {
    this._leak();
    if (this._water + amount <= this.capacity) {
      this._water += amount;
      return true;
    }
    return false;
  }

  get water() {
    this._leak();
    return this._water;
  }

  reset() {
    this._water = 0;
    this._lastLeak = this._now();
  }
}

/**
 * RateLimiter — unified wrapper with pluggable algorithms
 */
export class RateLimiter {
  constructor({ algorithm = 'token-bucket', ...opts }) {
    const algos = {
      'token-bucket': TokenBucket,
      'fixed-window': FixedWindow,
      'sliding-window': SlidingWindow,
      'sliding-log': SlidingLog,
      'leaky-bucket': LeakyBucket,
    };
    const Algo = algos[algorithm];
    if (!Algo) throw new Error(`Unknown algorithm: ${algorithm}. Available: ${Object.keys(algos).join(', ')}`);
    this.algorithm = algorithm;
    this._limiter = new Algo(opts);
  }

  /** Returns { allowed, remaining } */
  check(cost = 1) {
    const limiter = this._limiter;
    if (limiter instanceof TokenBucket) {
      return { allowed: limiter.tryRemove(cost), remaining: Math.floor(limiter.tokens) };
    }
    if (limiter instanceof LeakyBucket) {
      return { allowed: limiter.tryAdd(cost), remaining: Math.floor(limiter.capacity - limiter.water) };
    }
    // FixedWindow, SlidingWindow, SlidingLog all have tryAcquire + remaining
    return { allowed: limiter.tryAcquire(), remaining: limiter.remaining };
  }

  reset() {
    this._limiter.reset();
  }

  get limiter() {
    return this._limiter;
  }
}

/**
 * Per-key rate limiter — separate limiters per identifier (e.g., user ID, IP)
 */
export class KeyedRateLimiter {
  constructor({ factory, cleanupIntervalMs, maxSize }) {
    this._factory = factory;
    this._limiters = new Map();
    this._cleanupIntervalMs = cleanupIntervalMs || 60000;
    this._maxSize = maxSize || 10000;
    this._lastCleanup = Date.now();
  }

  _get(key) {
    // Lazy cleanup
    const now = Date.now();
    if (now - this._lastCleanup > this._cleanupIntervalMs) {
      this._cleanup();
      this._lastCleanup = now;
    }

    if (!this._limiters.has(key)) {
      if (this._limiters.size >= this._maxSize) {
        // Evict oldest entry
        const firstKey = this._limiters.keys().next().value;
        this._limiters.delete(firstKey);
      }
      this._limiters.set(key, this._factory());
    }
    return this._limiters.get(key);
  }

  check(key, cost) {
    return this._get(key);
  }

  /** Get the underlying limiter for a key, creating if needed */
  get(key) {
    return this._get(key);
  }

  _cleanup() {
    // Subclasses can override for smarter eviction
    // By default, we just enforce maxSize via eviction in _get
  }

  reset(key) {
    if (key) {
      this._limiters.get(key)?.reset();
    } else {
      for (const l of this._limiters.values()) l.reset();
    }
  }

  get size() {
    return this._limiters.size;
  }

  keys() {
    return this._limiters.keys();
  }
}

export default RateLimiter;
