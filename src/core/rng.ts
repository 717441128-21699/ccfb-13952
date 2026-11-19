/** 可种子化的确定性 PRNG（mulberry32），保证合成序列可复现、测试可比对 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** [0,1) 均匀分布 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }

  /** 正态分布（Box-Muller） */
  gaussian(sigma = 1): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

/** 字符串 -> 32bit 种子 */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
