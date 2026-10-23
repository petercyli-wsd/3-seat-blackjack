export interface Rng {
  /** Uniform integer in [0, n). */
  int(n: number): number;
}

/** Rejection-sampled CSPRNG so shuffles carry no modulo bias. */
export const cryptoRng: Rng = {
  int(n) {
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % n;
    }
  },
};

/** Deterministic generator (mulberry32) for tests and reproducible demo shoes. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    int(n) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const x = ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
      return Math.floor(x * n);
    },
  };
}
