// `npm run traffic -- --count 10 --seed 42 --rate 2 [--scenario force-hold | --mix provider-reject=0.02]
//   [--concurrency 8] [--url http://127.0.0.1:7071]`
import { formatMoney } from '@ct/contracts';
import { runTraffic } from './run';
import { parseTrafficArgs, TRAFFIC_USAGE } from './send';

async function main(): Promise<void> {
  let args;
  try {
    args = parseTrafficArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(TRAFFIC_USAGE);
    return;
  }
  const quiet = args.quiet ?? args.count > 200;
  const mix = args.mix ? Object.entries(args.mix).map(([k, v]) => `${k} ${((v ?? 0) * 100).toFixed(1)}%`).join(', ') : '';
  console.log(
    `Sending ${args.count} synthetic payment(s) to ${args.url}/payments ` +
      `(seed ${args.seed}, rate ${args.rate || 'unlimited'}/s, concurrency ${args.concurrency}` +
      `${args.scenario ? `, scenario ${args.scenario}` : ''}${mix ? `, mix ${mix}` : ''})`,
  );

  let refused = 0;
  let done = 0;
  let unreachable = false;
  const progress = quiet
    ? setInterval(() => console.log(`  ... ${done}/${args.count} sent`), 1000)
    : undefined;
  const summary = await runTraffic({
    url: args.url,
    seed: args.seed,
    count: args.count,
    start: args.start,
    rate: args.rate,
    concurrency: args.concurrency,
    scenario: args.scenario,
    mix: args.mix,
    shouldStop: () => unreachable,
    onResult: (p, r) => {
      done += 1;
      if (r.detail?.startsWith('connection refused') && ++refused >= 3 && done === refused) unreachable = true;
      if (quiet && r.outcome !== 'error') return;
      const label = `${p.body.corridor} ${formatMoney(p.body.amount)} ${p.body.debtor.name} -> ${p.body.creditor.name}${p.body.scenario ? ` [${p.body.scenario}]` : ''}`;
      const extra = r.outcome === 'error' ? ` ${r.status ?? ''} ${r.detail ?? ''}`.trimEnd() : r.paymentId ? ` ${r.paymentId}` : '';
      console.log(`  #${p.index} ${r.outcome.padEnd(9)} ${label}${extra}`);
    },
  });
  if (progress) clearInterval(progress);
  if (unreachable) console.error(`\nThe Payment API at ${args.url} is not reachable. Is "npm start" running?`);
  const { counts } = summary;
  console.log(
    `\nSummary: ${counts.accepted} accepted, ${counts.duplicate} duplicate(s), ${counts.error} error(s)` +
      ` in ${(summary.durationMs / 1000).toFixed(1)} s (${summary.achievedRate.toFixed(1)}/s${summary.retried ? `, ${summary.retried} retried` : ''})`,
  );
  process.exit(counts.error > 0 ? 1 : 0);
}

void main();
