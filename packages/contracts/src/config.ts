// Default local addresses. Everything binds to 127.0.0.1 so the demo runs with Wi-Fi off.
// Every value can be overridden by the environment variable named in the comment.

export const DEFAULT_HOST = '127.0.0.1'; // HOST

export const PORTS = {
  broker: 7070, // BROKER_PORT
  paymentApi: 7071, // PAYMENT_API_PORT
  gateway: 7072, // GATEWAY_PORT
  ledger: 7073, // LEDGER_PORT
  webDev: 5173, // vite dev server (proxies /api and /ws to the gateway)
} as const;

export function env(name: string, fallback: string): string {
  const v = typeof process !== 'undefined' ? process.env[name] : undefined;
  return v === undefined || v === '' ? fallback : v;
}

export function envInt(name: string, fallback: number): number {
  const v = env(name, String(fallback));
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

export function serviceConfig() {
  const host = env('HOST', DEFAULT_HOST);
  const brokerPort = envInt('BROKER_PORT', PORTS.broker);
  const paymentApiPort = envInt('PAYMENT_API_PORT', PORTS.paymentApi);
  const gatewayPort = envInt('GATEWAY_PORT', PORTS.gateway);
  const ledgerPort = envInt('LEDGER_PORT', PORTS.ledger);
  return {
    host,
    brokerPort,
    paymentApiPort,
    gatewayPort,
    ledgerPort,
    /** 'local' (built-in broker, default), 'memory' (tests only, single process), 'kafka' (Redpanda/Kafka) */
    bus: env('BUS', 'local') as 'local' | 'memory' | 'kafka',
    brokerUrl: env('BROKER_URL', `ws://${host}:${brokerPort}`),
    kafkaBrokers: env('KAFKA_BROKERS', '127.0.0.1:9092').split(','),
    paymentApiUrl: env('PAYMENT_API_URL', `http://${host}:${paymentApiPort}`),
    gatewayUrl: env('GATEWAY_URL', `http://${host}:${gatewayPort}`),
    ledgerUrl: env('LEDGER_URL', `http://${host}:${ledgerPort}`),
    /** Postgres connection string. Empty = embedded PGlite stored under `${dataDir}/ledger` (offline default). */
    databaseUrl: env('DATABASE_URL', ''),
    /** Seed for simulated markets and provider behaviour; same seed = same rates and outcomes. */
    simSeed: env('SIM_SEED', 'control-tower'),
    /** Base probability a provider rejects an instruction (catalogue rates are scaled by this; 0 disables failures). */
    providerFailureScale: Number(env('PROVIDER_FAILURE_SCALE', '1')),
    dataDir: env('DATA_DIR', '.data'),
    /** Artificial per-stage delay so people can watch a payment move. 0 in tests. */
    stageDelayMs: envInt('STAGE_DELAY_MS', 400),
    settlementDelayMs: envInt('SETTLEMENT_DELAY_MS', 900),
  };
}

export type ServiceConfig = ReturnType<typeof serviceConfig>;
