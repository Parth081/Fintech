import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLauncherArgs } from './args';
import { assertSafeToDelete, banner, prefixLine, PRESERVED_DATA_ENTRIES, RESET_SURVIVORS, SERVICE_NAMES, STAGES, stripOwnTag } from './launch';
import { busyPortsMessage, findBusyPorts, isPortFree } from './ports';

const defaults = {
  host: '127.0.0.1',
  brokerPort: 7070,
  paymentApiPort: 7071,
  gatewayPort: 7072,
  ledgerPort: 7073,
  orchestratorPort: 7074,
  opsPort: 7075,
  launcherControlPort: 7079,
  dataDir: '.data',
  stageDelayMs: 400,
  settlementDelayMs: 900,
} as unknown as Parameters<typeof parseLauncherArgs>[1];

describe('parseLauncherArgs', () => {
  it('uses defaults', () => {
    const a = parseLauncherArgs([], defaults);
    expect(a).toMatchObject({ reset: false, buildWeb: true, quiet: false, brokerPort: 7070, gatewayPort: 7072, dataDir: '.data' });
    expect(a).toMatchObject({ orchestratorPort: 7074, opsPort: 7075, controlPort: 7079 });
    if (!process.env.AMBIENT_RATE) expect(a.ambientRate).toBe(3); // npm start shows a living system
    expect(parseLauncherArgs(['--no-control'], defaults).controlPort).toBeNull();
    expect(parseLauncherArgs(['--ambient', '0'], defaults).ambientRate).toBe(0);
  });

  it('parses flags in both --flag value and --flag=value form', () => {
    const a = parseLauncherArgs(
      ['--reset', '--no-build', '--quiet', '--broker-port', '8070', '--api-port=8071', '--gateway-port', '8072', '--ledger-port=8073',
        '--data-dir', 'tmp/data', '--stage-delay', '0', '--settlement-delay=0', '--host', '0.0.0.0', '--timeout', '5000',
        '--orchestrator-port', '8074', '--ops-port', '8075', '--control-port=8079', '--ambient', '2.5'],
      defaults,
    );
    expect(a).toEqual({
      help: false, reset: true, buildWeb: false, quiet: true, host: '0.0.0.0', brokerPort: 8070, paymentApiPort: 8071,
      gatewayPort: 8072, ledgerPort: 8073, orchestratorPort: 8074, opsPort: 8075, assistantPort: 7076, boothPort: 7077, assistantLlm: 'auto',
      controlPort: 8079, ambientRate: 2.5,
      dataDir: 'tmp/data', stageDelayMs: 0, settlementDelayMs: 0, startupTimeoutMs: 5000,
    });
    expect(parseLauncherArgs(['-h'], defaults).help).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => parseLauncherArgs(['--nope'], defaults)).toThrow(/Unknown option/);
    expect(() => parseLauncherArgs(['--broker-port', '70000'], defaults)).toThrow(/port/);
    expect(() => parseLauncherArgs(['--broker-port'], defaults)).toThrow(/needs a value/);
    expect(() => parseLauncherArgs(['--stage-delay', 'abc'], defaults)).toThrow();
    expect(() => parseLauncherArgs(['--gateway-port', '7070'], defaults)).toThrow(/different/);
    expect(() => parseLauncherArgs(['--ledger-port', '7072'], defaults)).toThrow(/different/);
    expect(() => parseLauncherArgs(['--orchestrator-port', '7079'], defaults)).toThrow(/different/);
    expect(() => parseLauncherArgs(['--ops-port', '7074'], defaults)).toThrow(/different/);
    expect(() => parseLauncherArgs(['--ambient', '-1'], defaults)).toThrow(/ambient/);
    expect(() => parseLauncherArgs(['--ambient', '99'], defaults)).toThrow(/ambient/);
    expect(() => parseLauncherArgs(['--ambient'], defaults)).toThrow(/ambient/);
    expect(() => parseLauncherArgs(['--llm', 'maybe'], defaults)).toThrow(/--llm/);
    expect(() => parseLauncherArgs(['--booth-port', '7072'], defaults)).toThrow(/different/);
    expect(() => parseLauncherArgs(['--assistant-port', '7077'], defaults)).toThrow(/different/);
  });

  it('M5: assistant and booth ports, --llm (npm start defaults to auto, env ASSISTANT_LLM=off wins)', () => {
    const a = parseLauncherArgs(['--assistant-port', '8076', '--booth-port=8077', '--llm', 'off'], defaults);
    expect(a).toMatchObject({ assistantPort: 8076, boothPort: 8077, assistantLlm: 'off' });
    expect(parseLauncherArgs([], defaults).assistantLlm).toBe('auto');
    expect(parseLauncherArgs([], { ...defaults, assistantLlm: 'off' } as typeof defaults).assistantLlm).toBe('off');
    expect(parseLauncherArgs(['--llm=auto'], { ...defaults, assistantLlm: 'off' } as typeof defaults).assistantLlm).toBe('auto');
  });
});

describe('port check', () => {
  it('detects a busy port and a free one', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await isPortFree(port)).toBe(false);
      const busy = await findBusyPorts([{ name: 'gateway', port }]);
      expect(busy).toEqual([{ name: 'gateway', port }]);
      expect(busyPortsMessage(busy)).toMatch(new RegExp(`gateway: 127\\.0\\.0\\.1:${port} is already in use`));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(await isPortFree(port)).toBe(true);
    expect(await findBusyPorts([{ name: 'gateway', port }])).toEqual([]);
  });
});

describe('launcher helpers', () => {
  it('refuses to --reset the repo root or its parents', () => {
    const root = path.join(os.tmpdir(), 'ct-root');
    expect(() => assertSafeToDelete(root, root)).toThrow(/Refusing/);
    expect(() => assertSafeToDelete(os.tmpdir(), root)).toThrow(/Refusing/);
    expect(() => assertSafeToDelete(path.parse(root).root, root)).toThrow(/Refusing/);
    expect(() => assertSafeToDelete(path.join(root, '.data'), root)).not.toThrow();
    expect(() => assertSafeToDelete(path.join(os.tmpdir(), 'other-data'), root)).not.toThrow();
  });

  it('prefixes log lines and prints the banner', () => {
    expect(prefixLine('fx', 'hello', false)).toBe(`${'[fx]'.padEnd(17)}hello`);
    expect(prefixLine('fx', 'hello', true)).toContain('\x1b[');
    const b = banner('http://127.0.0.1:7072');
    expect(b).toContain('http://127.0.0.1:7072');
    expect(b).toContain('Simulation · synthetic data · runs offline');
  });
});

describe('stripOwnTag', () => {
  it('drops a duplicate service tag only', () => {
    expect(stripOwnTag('fx', '[fx] ready (bus=local)')).toBe('ready (bus=local)');
    expect(stripOwnTag('fx', '[bus:stage-fx] reconnecting')).toBe('[bus:stage-fx] reconnecting');
  });
});

describe('service list (M2, M3, M5)', () => {
  it('runs the ledger, orchestrator, assistant and booth as their own services, not as stage processes', () => {
    expect(STAGES).not.toContain('ledger');
    expect(SERVICE_NAMES).toEqual([
      'broker', 'payment-api', 'screening', 'risk', 'fx', 'routing', 'settlement', 'reconciliation', 'ledger', 'orchestrator',
      'ops', 'assistant', 'booth', 'gateway',
    ]);
  });

  it('keeps the booth (visitor leads) through a reset', () => {
    expect(RESET_SURVIVORS).toEqual(['booth']);
    expect(PRESERVED_DATA_ENTRIES).toContain('booth');
  });
});
