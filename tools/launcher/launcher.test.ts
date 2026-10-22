import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLauncherArgs } from './args';
import { assertSafeToDelete, banner, prefixLine, stripOwnTag } from './launch';
import { busyPortsMessage, findBusyPorts, isPortFree } from './ports';

const defaults = {
  host: '127.0.0.1',
  brokerPort: 7070,
  paymentApiPort: 7071,
  gatewayPort: 7072,
  dataDir: '.data',
  stageDelayMs: 400,
  settlementDelayMs: 900,
} as unknown as Parameters<typeof parseLauncherArgs>[1];

describe('parseLauncherArgs', () => {
  it('uses defaults', () => {
    const a = parseLauncherArgs([], defaults);
    expect(a).toMatchObject({ reset: false, buildWeb: true, quiet: false, brokerPort: 7070, gatewayPort: 7072, dataDir: '.data' });
  });

  it('parses flags in both --flag value and --flag=value form', () => {
    const a = parseLauncherArgs(
      ['--reset', '--no-build', '--quiet', '--broker-port', '8070', '--api-port=8071', '--gateway-port', '8072',
        '--data-dir', 'tmp/data', '--stage-delay', '0', '--settlement-delay=0', '--host', '0.0.0.0', '--timeout', '5000'],
      defaults,
    );
    expect(a).toEqual({
      help: false, reset: true, buildWeb: false, quiet: true, host: '0.0.0.0', brokerPort: 8070, paymentApiPort: 8071,
      gatewayPort: 8072, dataDir: 'tmp/data', stageDelayMs: 0, settlementDelayMs: 0, startupTimeoutMs: 5000,
    });
    expect(parseLauncherArgs(['-h'], defaults).help).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => parseLauncherArgs(['--nope'], defaults)).toThrow(/Unknown option/);
    expect(() => parseLauncherArgs(['--broker-port', '70000'], defaults)).toThrow(/port/);
    expect(() => parseLauncherArgs(['--broker-port'], defaults)).toThrow(/needs a value/);
    expect(() => parseLauncherArgs(['--stage-delay', 'abc'], defaults)).toThrow();
    expect(() => parseLauncherArgs(['--gateway-port', '7070'], defaults)).toThrow(/different/);
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
