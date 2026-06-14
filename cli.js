#!/usr/bin/env node
import { TokenBucket, FixedWindow, SlidingWindow, SlidingLog, LeakyBucket, RateLimiter, KeyedRateLimiter } from './index.js';

const args = process.argv.slice(2);

function usage() {
  console.log(`ratelimit-mini CLI

Usage:
  ratelimit test <algorithm> [options]
  ratelimit info <algorithm> [options]

Algorithms:
  token-bucket     Continuous refill, burst-friendly
  fixed-window     Fixed time windows, simple
  sliding-window   Rolling window with precision buckets
  sliding-log      Exact per-request timestamps
  leaky-bucket     Steady outflow, smooths bursts

Options:
  --max <n>           Max requests (default: 10)
  --window <ms>       Window in ms (default: 1000)
  --capacity <n>      Bucket capacity (default: 10)
  --rate <n>          Refill/leak rate per sec (default: 5)
  --requests <n>      Number of test requests (default: 15)
  --precision <n>     Sliding window precision buckets (default: 10)
  --json              Output as JSON
  --help, -h          Show this help

Examples:
  ratelimit test token-bucket --capacity 5 --rate 2 --requests 10
  ratelimit test fixed-window --max 5 --window 1000 --requests 10
  ratelimit test sliding-window --max 5 --window 2000 --requests 10
  ratelimit info token-bucket --capacity 10 --rate 5
`);
}

function parseFlag(name, fallback) {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return parseFloat(args[idx + 1]);
  return fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

const cmd = args[0];
const algo = args[1];

if (hasFlag('--help') || hasFlag('-h') || !cmd || !algo) {
  usage();
  process.exit(0);
}

const isJson = hasFlag('--json');

if (cmd === 'info') {
  const info = { algorithm: algo };
  if (algo === 'token-bucket' || algo === 'leaky-bucket') {
    info.capacity = parseFlag('--capacity', 10);
    info.rate = parseFlag('--rate', 5);
    info.description = algo === 'token-bucket'
      ? `Bucket holds ${info.capacity} tokens, refills at ${info.rate}/sec`
      : `Bucket holds ${info.capacity} requests, leaks at ${info.rate}/sec`;
  } else {
    info.max = parseFlag('--max', 10);
    info.windowMs = parseFlag('--window', 1000);
    info.description = `${info.max} requests per ${info.windowMs}ms window`;
  }
  if (isJson) console.log(JSON.stringify(info, null, 2));
  else console.log(`${info.algorithm}: ${info.description}`);
  process.exit(0);
}

if (cmd === 'test') {
  const requests = parseFlag('--requests', 15);
  const results = [];

  let limiter;
  const opts = {};
  if (algo === 'token-bucket') {
    opts.capacity = parseFlag('--capacity', 10);
    opts.rate = parseFlag('--rate', 5);
    limiter = new TokenBucket(opts);
  } else if (algo === 'fixed-window') {
    opts.max = parseFlag('--max', 10);
    opts.windowMs = parseFlag('--window', 1000);
    limiter = new FixedWindow(opts);
  } else if (algo === 'sliding-window') {
    opts.max = parseFlag('--max', 10);
    opts.windowMs = parseFlag('--window', 1000);
    opts.precision = parseFlag('--precision', 10);
    limiter = new SlidingWindow(opts);
  } else if (algo === 'sliding-log') {
    opts.max = parseFlag('--max', 10);
    opts.windowMs = parseFlag('--window', 1000);
    limiter = new SlidingLog(opts);
  } else if (algo === 'leaky-bucket') {
    opts.capacity = parseFlag('--capacity', 10);
    opts.rate = parseFlag('--rate', 5);
    limiter = new LeakyBucket(opts);
  } else {
    console.error(`Unknown algorithm: ${algo}`);
    process.exit(1);
  }

  for (let i = 0; i < requests; i++) {
    let allowed, remaining;
    if (limiter instanceof TokenBucket) {
      allowed = limiter.tryRemove(1);
      remaining = Math.floor(limiter.tokens);
    } else if (limiter instanceof LeakyBucket) {
      allowed = limiter.tryAdd(1);
      remaining = Math.floor(limiter.capacity - limiter.water);
    } else {
      allowed = limiter.tryAcquire();
      remaining = limiter.remaining;
    }
    results.push({ request: i + 1, allowed, remaining });
  }

  const allowedCount = results.filter(r => r.allowed).length;
  const deniedCount = results.length - allowedCount;

  if (isJson) {
    console.log(JSON.stringify({ algorithm: algo, config: opts, totalRequests: requests, allowed: allowedCount, denied: deniedCount, results }, null, 2));
  } else {
    console.log(`\nAlgorithm: ${algo}`);
    console.log(`Config: ${JSON.stringify(opts)}`);
    console.log(`Requests: ${requests} | Allowed: ${allowedCount} | Denied: ${deniedCount}\n`);
    for (const r of results) {
      const status = r.allowed ? '✓ ALLOW' : '✗ DENY';
      console.log(`  #${String(r.request).padStart(3)} ${status}  (remaining: ${r.remaining})`);
    }
    console.log();
  }
  process.exit(0);
}

usage();
process.exit(1);
