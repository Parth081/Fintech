// `npm run traffic -- --count 10 --seed 42 --rate 2 [--scenario force-hold] [--url http://127.0.0.1:7071]`
import { formatMoney } from '@ct/contracts';
import { generatePayments } from './generator';
import { parseTrafficArgs, sendPayment, TRAFFIC_USAGE, type Outcome } from './send';

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

  const payments = generatePayments(args.seed, args.count, { scenario: args.scenario, start: args.start });
  console.log(
    `Sending ${payments.length} synthetic payment(s) to ${args.url}/payments ` +
      `(seed ${args.seed}, rate ${args.rate || 'unlimited'}/s${args.scenario ? `, scenario ${args.scenario}` : ''})`,
  );

  const counts: Record<Outcome, number> = { accepted: 0, duplicate: 0, error: 0 };
  const intervalMs = args.rate > 0 ? 1000 / args.rate : 0;
  const t0 = Date.now();
  let refused = 0;
  for (const [i, p] of payments.entries()) {
    const due = t0 + i * intervalMs;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const r = await sendPayment(args.url, p);
    counts[r.outcome]++;
    const label = `${p.body.corridor} ${formatMoney(p.body.amount)} ${p.body.debtor.name} -> ${p.body.creditor.name}`;
    const extra = r.outcome === 'error' ? ` ${r.status ?? ''} ${r.detail ?? ''}`.trimEnd() : r.paymentId ? ` ${r.paymentId}` : '';
    console.log(`  #${p.index} ${r.outcome.padEnd(9)} ${label}${extra}`);
    if (r.detail?.startsWith('connection refused') && ++refused >= 3 && counts.accepted + counts.duplicate === 0) {
      console.error(`\nThe Payment API at ${args.url} is not reachable. Is "npm start" running?`);
      break;
    }
  }

  console.log(`\nSummary: ${counts.accepted} accepted, ${counts.duplicate} duplicate(s), ${counts.error} error(s)`);
  process.exit(counts.error > 0 ? 1 : 0);
}

void main();
