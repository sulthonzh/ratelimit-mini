import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, FixedWindow, SlidingWindow, SlidingLog, LeakyBucket, RateLimiter, KeyedRateLimiter } from './index.js';

// Helper: controlled clock
function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// ===== TokenBucket =====
test('TokenBucket: starts full', () => {
  const bucket = new TokenBucket({ capacity: 10, rate: 1 });
  assert.equal(bucket.tokens, 10);
});

test('TokenBucket: consumes tokens', () => {
  const bucket = new TokenBucket({ capacity: 5, rate: 1 });
  assert.equal(bucket.tryRemove(3), true);
  assert.equal(bucket.tokens, 2);
});

test('TokenBucket: denies when empty', () => {
  const bucket = new TokenBucket({ capacity: 2, rate: 1 });
  assert.equal(bucket.tryRemove(2), true);
  assert.equal(bucket.tryRemove(1), false);
});

test('TokenBucket: refills over time', () => {
  const clock = makeClock(0);
  const bucket = new TokenBucket({ capacity: 5, rate: 5, now: clock.now });
  assert.equal(bucket.tryRemove(5), true);
  assert.equal(bucket.tryRemove(1), false);
  clock.advance(1000); // 1s → 5 tokens refilled
  assert.equal(bucket.tryRemove(5), true);
});

test('TokenBucket: does not exceed capacity', () => {
  const clock = makeClock(0);
  const bucket = new TokenBucket({ capacity: 3, rate: 100, now: clock.now });
  clock.advance(10000); // huge time gap
  assert.equal(bucket.tokens, 3); // capped
});

test('TokenBucket: waitTime returns 0 when enough tokens', () => {
  const bucket = new TokenBucket({ capacity: 10, rate: 1 });
  assert.equal(bucket.waitTime(5), 0);
});

test('TokenBucket: waitTime calculates correctly', () => {
  const clock = makeClock(0);
  const bucket = new TokenBucket({ capacity: 5, rate: 5, now: clock.now });
  bucket.tryRemove(5); // empty
  // Need 1 token at 5/sec → 200ms
  assert.equal(bucket.waitTime(1), 200);
});

test('TokenBucket: reset restores to capacity', () => {
  const bucket = new TokenBucket({ capacity: 10, rate: 1 });
  bucket.tryRemove(5);
  bucket.reset();
  assert.equal(bucket.tokens, 10);
});

test('TokenBucket: throws on invalid params', () => {
  assert.throws(() => new TokenBucket({ capacity: 0, rate: 1 }), /capacity/);
  assert.throws(() => new TokenBucket({ capacity: 1, rate: 0 }), /rate/);
});

test('TokenBucket: partial refill (half second)', () => {
  const clock = makeClock(0);
  const bucket = new TokenBucket({ capacity: 10, rate: 10, now: clock.now });
  bucket.tryRemove(10);
  clock.advance(500); // 0.5s → 5 tokens
  assert.equal(bucket.tokens, 5);
});

// ===== FixedWindow =====
test('FixedWindow: allows up to max', () => {
  const lim = new FixedWindow({ max: 5, windowMs: 1000 });
  for (let i = 0; i < 5; i++) assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false);
});

test('FixedWindow: resets on new window', () => {
  const clock = makeClock(0);
  const lim = new FixedWindow({ max: 3, windowMs: 1000, now: clock.now });
  for (let i = 0; i < 3; i++) assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false);
  clock.advance(1001);
  assert.equal(lim.tryAcquire(), true);
});

test('FixedWindow: remaining count', () => {
  const lim = new FixedWindow({ max: 10, windowMs: 1000 });
  lim.tryAcquire();
  lim.tryAcquire();
  assert.equal(lim.remaining, 8);
});

test('FixedWindow: msUntilReset', () => {
  const clock = makeClock(500);
  const lim = new FixedWindow({ max: 10, windowMs: 1000, now: clock.now });
  const ms = lim.msUntilReset;
  assert.ok(ms > 0 && ms <= 500, `msUntilReset should be 0-500, got ${ms}`);
});

test('FixedWindow: windows align to epoch', () => {
  const clock = makeClock(500); // start at 500ms
  const lim = new FixedWindow({ max: 2, windowMs: 1000, now: clock.now });
  // Window [0, 1000) since 500 is in first window
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false);
  clock.advance(501); // now at 1001ms → window [1000, 2000)
  assert.equal(lim.tryAcquire(), true);
});

test('FixedWindow: reset', () => {
  const lim = new FixedWindow({ max: 5, windowMs: 1000 });
  lim.tryAcquire();
  lim.reset();
  assert.equal(lim.remaining, 5);
});

test('FixedWindow: throws on invalid params', () => {
  assert.throws(() => new FixedWindow({ max: 0, windowMs: 1000 }), /max/);
  assert.throws(() => new FixedWindow({ max: 1, windowMs: 0 }), /windowMs/);
});

// ===== SlidingWindow =====
test('SlidingWindow: allows up to max', () => {
  const lim = new SlidingWindow({ max: 5, windowMs: 1000, precision: 5 });
  for (let i = 0; i < 5; i++) assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false);
});

test('SlidingWindow: old requests expire', () => {
  const clock = makeClock(0);
  const lim = new SlidingWindow({ max: 3, windowMs: 1000, precision: 5, now: clock.now });
  for (let i = 0; i < 3; i++) assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false);
  clock.advance(1001);
  assert.equal(lim.tryAcquire(), true);
});

test('SlidingWindow: rolling window counts correctly', () => {
  const clock = makeClock(0);
  const lim = new SlidingWindow({ max: 5, windowMs: 1000, precision: 10, now: clock.now });
  // Fill 5 at t=0
  for (let i = 0; i < 5; i++) lim.tryAcquire();
  assert.equal(lim.tryAcquire(), false);
  // Move 600ms — still in window (0-1000), 3 of 5 should still count if buckets are 100ms
  clock.advance(600);
  // All 5 still in window (they were at t=0, window is now [-400, 600])
  // Actually with bucket approach, they bucketed at t=0 bucket key
  // Window is 1000ms, so at t=600, cutoff is t=-400 → all 5 still count
  assert.equal(lim.tryAcquire(), false);
  // Move to t=1001 → cutoff is t=1 → bucket at t=0 is evicted
  clock.advance(401);
  assert.equal(lim.tryAcquire(), true);
});

test('SlidingWindow: remaining', () => {
  const lim = new SlidingWindow({ max: 10, windowMs: 1000, precision: 5 });
  lim.tryAcquire();
  lim.tryAcquire();
  assert.equal(lim.remaining, 8);
});

test('SlidingWindow: reset', () => {
  const lim = new SlidingWindow({ max: 5, windowMs: 1000, precision: 5 });
  lim.tryAcquire();
  lim.reset();
  assert.equal(lim.remaining, 5);
});

test('SlidingWindow: throws on invalid precision', () => {
  assert.throws(() => new SlidingWindow({ max: 1, windowMs: 1000, precision: 0 }), /precision/);
});

// ===== SlidingLog =====
test('SlidingLog: allows up to max', () => {
  const lim = new SlidingLog({ max: 5, windowMs: 1000 });
  for (let i = 0; i < 5; i++) assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false);
});

test('SlidingLog: exact eviction', () => {
  const clock = makeClock(0);
  const lim = new SlidingLog({ max: 3, windowMs: 1000, now: clock.now });
  // t=0: acquire 3
  lim.tryAcquire(); // t=0
  clock.advance(100);
  lim.tryAcquire(); // t=100
  clock.advance(100);
  lim.tryAcquire(); // t=200
  assert.equal(lim.tryAcquire(), false); // full
  // t=1001: first event at t=0 is now > 1000ms ago → evicted
  clock.advance(801); // t=1001
  assert.equal(lim.tryAcquire(), true); // t=0 evicted, room for 1
  // Now we have t=100, t=200, t=1001 = 3 events
  assert.equal(lim.tryAcquire(), false);
});

test('SlidingLog: remaining', () => {
  const lim = new SlidingLog({ max: 10, windowMs: 1000 });
  lim.tryAcquire();
  assert.equal(lim.remaining, 9);
});

test('SlidingLog: reset', () => {
  const lim = new SlidingLog({ max: 5, windowMs: 1000 });
  lim.tryAcquire();
  lim.reset();
  assert.equal(lim.remaining, 5);
});

// ===== LeakyBucket =====
test('LeakyBucket: accepts up to capacity', () => {
  const bucket = new LeakyBucket({ capacity: 5, rate: 1 });
  for (let i = 0; i < 5; i++) assert.equal(bucket.tryAdd(1), true);
  assert.equal(bucket.tryAdd(1), false);
});

test('LeakyBucket: leaks over time', () => {
  const clock = makeClock(0);
  const bucket = new LeakyBucket({ capacity: 5, rate: 5, now: clock.now });
  for (let i = 0; i < 5; i++) bucket.tryAdd(1);
  assert.equal(bucket.tryAdd(1), false);
  clock.advance(1000); // leak 5/sec → 1s = 5 leaked
  assert.equal(bucket.water, 0);
  assert.equal(bucket.tryAdd(1), true);
});

test('LeakyBucket: partial leak', () => {
  const clock = makeClock(0);
  const bucket = new LeakyBucket({ capacity: 10, rate: 10, now: clock.now });
  bucket.tryAdd(10);
  clock.advance(500); // 0.5s → leak 5
  assert.equal(bucket.water, 5);
});

test('LeakyBucket: reset', () => {
  const bucket = new LeakyBucket({ capacity: 5, rate: 1 });
  bucket.tryAdd(3);
  bucket.reset();
  assert.equal(bucket.water, 0);
});

test('LeakyBucket: throws on invalid params', () => {
  assert.throws(() => new LeakyBucket({ capacity: 0, rate: 1 }), /capacity/);
  assert.throws(() => new LeakyBucket({ capacity: 1, rate: 0 }), /rate/);
});

// ===== RateLimiter (wrapper) =====
test('RateLimiter: token-bucket wrapper', () => {
  const rl = new RateLimiter({ algorithm: 'token-bucket', capacity: 5, rate: 1 });
  const r = rl.check(1);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 4);
});

test('RateLimiter: fixed-window wrapper', () => {
  const rl = new RateLimiter({ algorithm: 'fixed-window', max: 5, windowMs: 1000 });
  const r = rl.check();
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 4);
});

test('RateLimiter: sliding-window wrapper', () => {
  const rl = new RateLimiter({ algorithm: 'sliding-window', max: 5, windowMs: 1000, precision: 5 });
  const r = rl.check();
  assert.equal(r.allowed, true);
});

test('RateLimiter: sliding-log wrapper', () => {
  const rl = new RateLimiter({ algorithm: 'sliding-log', max: 5, windowMs: 1000 });
  const r = rl.check();
  assert.equal(r.allowed, true);
});

test('RateLimiter: leaky-bucket wrapper', () => {
  const rl = new RateLimiter({ algorithm: 'leaky-bucket', capacity: 5, rate: 1 });
  const r = rl.check(1);
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 4);
});

test('RateLimiter: throws on unknown algorithm', () => {
  assert.throws(() => new RateLimiter({ algorithm: 'bogus' }), /Unknown algorithm/);
});

test('RateLimiter: reset delegates to inner limiter', () => {
  const rl = new RateLimiter({ algorithm: 'fixed-window', max: 2, windowMs: 1000 });
  rl.check();
  rl.reset();
  assert.equal(rl.check().remaining, 1);
});

// ===== KeyedRateLimiter =====
test('KeyedRateLimiter: separate limiters per key', () => {
  const kl = new KeyedRateLimiter({
    factory: () => new FixedWindow({ max: 2, windowMs: 1000 })
  });
  assert.equal(kl.get('user1').tryAcquire(), true);
  assert.equal(kl.get('user1').tryAcquire(), true);
  assert.equal(kl.get('user1').tryAcquire(), false);
  // user2 has their own bucket
  assert.equal(kl.get('user2').tryAcquire(), true);
  assert.equal(kl.get('user2').tryAcquire(), true);
});

test('KeyedRateLimiter: tracks size', () => {
  const kl = new KeyedRateLimiter({
    factory: () => new TokenBucket({ capacity: 5, rate: 1 })
  });
  kl.get('a');
  kl.get('b');
  kl.get('c');
  assert.equal(kl.size, 3);
});

test('KeyedRateLimiter: reset single key', () => {
  const kl = new KeyedRateLimiter({
    factory: () => new FixedWindow({ max: 2, windowMs: 1000 })
  });
  kl.get('x').tryAcquire();
  kl.get('x').tryAcquire();
  assert.equal(kl.get('x').remaining, 0);
  kl.reset('x');
  assert.equal(kl.get('x').remaining, 2);
});

test('KeyedRateLimiter: reset all keys', () => {
  const kl = new KeyedRateLimiter({
    factory: () => new FixedWindow({ max: 3, windowMs: 1000 })
  });
  kl.get('a').tryAcquire();
  kl.get('b').tryAcquire();
  kl.reset();
  assert.equal(kl.get('a').remaining, 3);
  assert.equal(kl.get('b').remaining, 3);
});

test('KeyedRateLimiter: evicts oldest when maxSize reached', () => {
  const kl = new KeyedRateLimiter({
    factory: () => new FixedWindow({ max: 10, windowMs: 1000 }),
    maxSize: 2
  });
  kl.get('a');
  kl.get('b');
  kl.get('c'); // should evict 'a'
  assert.equal(kl.size, 2);
  assert.ok(![...kl.keys()].includes('a'));
});

// ===== Edge cases =====
test('TokenBucket: zero cost always allowed', () => {
  const bucket = new TokenBucket({ capacity: 1, rate: 1 });
  assert.equal(bucket.tryRemove(0), true);
});

test('SlidingLog: events at exact boundary are evicted', () => {
  const clock = makeClock(0);
  const lim = new SlidingLog({ max: 10, windowMs: 1000, now: clock.now });
  lim.tryAcquire(); // t=0
  clock.advance(1000); // t=1000, cutoff = 0
  // Event at t=0 is <= cutoff → evicted
  lim.tryAcquire();
  assert.equal(lim.remaining, 9); // max=10, 1 event remaining
});
