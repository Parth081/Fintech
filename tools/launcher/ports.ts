// Port availability helpers used before any service is started.
import net from 'node:net';

/** Resolves true if `port` can be bound on `host` right now (and releases it again). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
      else reject(err);
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export interface PortRequest {
  name: string;
  port: number;
}

/** Returns the requested ports that are busy (empty array = all free). */
export async function findBusyPorts(requests: readonly PortRequest[], host = '127.0.0.1'): Promise<PortRequest[]> {
  const busy: PortRequest[] = [];
  for (const r of requests) {
    if (!(await isPortFree(r.port, host))) busy.push(r);
  }
  return busy;
}

export function busyPortsMessage(busy: readonly PortRequest[], host = '127.0.0.1'): string {
  const lines = busy.map((b) => `  - ${b.name}: ${host}:${b.port} is already in use`);
  const findCmd =
    process.platform === 'win32'
      ? `netstat -ano | findstr :${busy[0]?.port ?? ''}   (then: taskkill /PID <pid> /F)`
      : `lsof -i :${busy[0]?.port ?? ''}   (then: kill <pid>)`;
  return [
    'Cannot start: port(s) busy.',
    ...lines,
    'Is another copy of the Control Tower still running? Stop it first, or find the process with:',
    `  ${findCmd}`,
    'Or pick other ports, e.g. npm start -- --broker-port 7170 --api-port 7171 --gateway-port 7172',
  ].join('\n');
}
