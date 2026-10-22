// Child process for broker-bench: one ephemeral subscriber replaying the whole log from earliest.
// argv: <brokerUrl> <expectedEvents> <name>. Prints "done <ms>" when every event was handled.
import { performance } from 'node:perf_hooks';
import { LocalBrokerBus } from '../../packages/event-bus/src/local-broker-bus';

const [url, expectedRaw, name] = process.argv.slice(2);
const expected = Number(expectedRaw);
const bus = await LocalBrokerBus.connect(url!, `bench-${name}`, { logger: { warn: () => {}, error: console.error } });
let seen = 0;
const t0 = performance.now();
const ids = new Set<string>();
await bus.subscribe({ group: `bench-${name}`, from: 'earliest', ephemeral: true }, (event) => {
  // Touch the event like a projection would.
  ids.add(event.paymentId);
  seen += 1;
  if (seen === expected) {
    console.log(`done ${Math.round(performance.now() - t0)}`);
    void bus.close().then(() => process.exit(0));
  }
});
