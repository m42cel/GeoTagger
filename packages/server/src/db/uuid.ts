import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 generation for file IDs (SPEC §8.2).
 *
 * Node's built-in `crypto.randomUUIDv7()` fills its random bits fresh on every call,
 * so two ids minted in the same millisecond sort in whatever order the RNG happened
 * to produce — verified empirically. `upsertScanned` can mint hundreds of ids in a
 * single millisecond during a scan, and `ORDER BY id` is relied on to mean insertion
 * order, so generation here instead follows RFC 9562 §6.2 Method 2 ("Monotonic
 * Random"): random bits are generated fresh only when the clock has advanced since
 * the last id, and reused-plus-incremented otherwise, which guarantees each id in a
 * millisecond sorts after the one before it.
 */

const RAND_BITS = 74n; // 12-bit rand_a + 62-bit rand_b
const RAND_MAX = (1n << RAND_BITS) - 1n;

let lastMs = 0;
let lastRand = 0n;

function randomRand74(): bigint {
  // 10 bytes = 80 bits is enough to mask down to 74 bits.
  const buf = randomBytes(10);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n & RAND_MAX;
}

export function generateFileId(): string {
  let ms = Date.now();

  if (ms > lastMs) {
    lastMs = ms;
    lastRand = randomRand74();
  } else {
    // Same millisecond as the last id (or the clock went backwards, which is treated
    // the same way): keep the timestamp and step the random tail forward by one, so
    // the new id always sorts strictly after the previous one.
    lastRand += 1n;
    if (lastRand > RAND_MAX) {
      // Exhausted 74 bits of counter inside one millisecond — vanishingly unlikely,
      // but handled by moving to the next tick rather than wrapping and colliding.
      lastMs += 1;
      ms = lastMs;
      lastRand = randomRand74();
    }
  }

  const randA = (lastRand >> 62n) & 0xfffn; // top 12 bits
  const randB = lastRand & 0x3fffffffffffffffn; // bottom 62 bits

  const timeHex = BigInt(ms).toString(16).padStart(12, '0');
  const randAHex = randA.toString(16).padStart(3, '0');
  // variant '10' occupies the top 2 bits of this nibble-group; OR it into the first
  // hex digit of rand_b's 16-digit field.
  const variantAndRandB = (0x8n << 60n) | randB;
  const randBHex = variantAndRandB.toString(16).padStart(16, '0');

  return [
    timeHex.slice(0, 8),
    timeHex.slice(8, 12),
    `7${randAHex}`,
    randBHex.slice(0, 4),
    randBHex.slice(4, 16),
  ].join('-');
}
