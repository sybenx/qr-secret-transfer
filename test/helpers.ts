import { sha256 } from '@noble/hashes/sha2.js';
import { type Env, concatBytes, utf8Encode } from '../src/core/index.ts';

/** Deterministic randomness: SHA-256 in counter mode over a seed. For tests only. */
export function seededRandom(seed: string): (n: number) => Uint8Array {
  let counter = 0;
  const key = utf8Encode(seed);
  return (n) => {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const block = sha256(concatBytes(key, utf8Encode(`:${counter++}`)));
      out.set(block.subarray(0, Math.min(32, n - filled)), filled);
      filled += 32;
    }
    return out;
  };
}

export class FakeClock {
  constructor(public t = 1_800_000_000) {}
  now = () => this.t;
  advance(seconds: number) {
    this.t += seconds;
  }
}

export function testEnv(seed: string, clock = new FakeClock()): Env & { clock: FakeClock } {
  return { random: seededRandom(seed), now: clock.now, clock };
}
