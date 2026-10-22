/**
 * When a service is started by the launcher (CT_SUPERVISED=1), the launcher holds the write end of
 * the service's stdin. If the launcher dies for any reason, even a hard kill or closing the terminal
 * window on Windows where no signal reaches the children, that pipe closes and the service shuts
 * itself down instead of being left running and holding its port.
 */
export function exitWithSupervisor(shutdown: (reason: string) => unknown, graceMs = 5000): void {
  if (process.env.CT_SUPERVISED !== '1') return;
  let fired = false;
  const onGone = () => {
    if (fired) return;
    fired = true;
    setTimeout(() => process.exit(0), graceMs).unref();
    void Promise.resolve(shutdown('supervisor exited')).catch(() => process.exit(1));
  };
  process.stdin.on('end', onGone);
  process.stdin.on('close', onGone);
  process.stdin.on('error', onGone);
  process.stdin.resume();
}
