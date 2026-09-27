import { describe, expect, it, vi } from 'vitest';
import { JitterBuffer } from './jitterBuffer';

describe('JitterBuffer playout depth', () => {
  it('buffers a burst then plays in order with no loss', () => {
    const jb = new JitterBuffer(20);
    // Push a full burst first: pull() gates on buffered depth, so feeding
    // one frame at a time and pulling immediately never starts playout.
    for (let i = 0; i < 5; i += 1) {
      jb.push(i, i * 960, new Uint8Array([i]));
    }
    expect(jb.pull()).not.toBeNull();
    expect(jb.pull()).not.toBeNull();
    expect(jb.stats.lossRate).toBe(0);
  });

  it('pulls past a gap and reports it as loss', () => {
    // Age the burst past the 80ms depth gate: same-tick pushes all carry
    // receivedAt ~= now, so the gate would otherwise hold the first pulls.
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const jb = new JitterBuffer(20);
      for (const i of [0, 1, 3, 4, 5]) {
        jb.push(i, i * 960, new Uint8Array([i]));
      }
      now += 500; // well past currentDepthMs
      expect(jb.pull()).not.toBeNull(); // seq 0
      expect(jb.pull()).not.toBeNull(); // seq 1
      expect(jb.pull()).toBeNull(); // seq 2 missing -> PLC
      expect(jb.pull()).not.toBeNull(); // seq 3
      // 1 lost of 6 accounted frames.
      expect(jb.stats.lossRate).toBeCloseTo(1 / 6, 5);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
