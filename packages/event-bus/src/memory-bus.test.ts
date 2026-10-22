import { describe, expect, it } from 'vitest';
import { happyPath } from '@ct/contracts/testing';
import { InMemoryBus } from './memory-bus';

describe('InMemoryBus', () => {
  it('delivers in order and resumes a group from its committed offset', async () => {
    const bus = new InMemoryBus();
    const events = happyPath('p-1');
    for (const e of events.slice(0, 3)) await bus.publish(e);

    const seen: number[] = [];
    const sub = await bus.subscribe({ group: 'g' }, (_e, m) => { seen.push(m.offset); });
    await bus.drain();
    await sub.unsubscribe();
    for (const e of events.slice(3, 5)) await bus.publish(e);

    const sub2 = await bus.subscribe({ group: 'g' }, (_e, m) => { seen.push(m.offset); });
    await bus.drain();
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    await sub2.unsubscribe();
    await bus.close();
  });

  it('retries a failing handler (at-least-once)', async () => {
    const bus = new InMemoryBus();
    await bus.publish(happyPath('p-2')[0]!);
    let calls = 0;
    await bus.subscribe({ group: 'g' }, () => {
      calls += 1;
      if (calls < 3) throw new Error('boom');
    });
    await bus.drain();
    expect(calls).toBe(3);
    await bus.close();
  });

  it('latest + ephemeral skip history', async () => {
    const bus = new InMemoryBus();
    await bus.publish(happyPath('p-3')[0]!);
    const seen: string[] = [];
    await bus.subscribe({ group: 'x', from: 'latest', ephemeral: true }, (e) => { seen.push(e.type); });
    await bus.publish(happyPath('p-4')[0]!);
    await bus.drain();
    expect(seen).toEqual(['payment.initiated']);
    await bus.close();
  });
});
