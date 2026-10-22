import { serviceConfig, type ServiceConfig } from '@ct/contracts';
import type { EventBus } from './types';
import { InMemoryBus } from './memory-bus';

export * from './types';
export { InMemoryBus } from './memory-bus';

/**
 * Create the bus selected by config (env BUS). Every service uses this; none should construct
 * a specific implementation directly except tests.
 */
export async function createBus(config: ServiceConfig = serviceConfig(), clientId = 'ct'): Promise<EventBus> {
  switch (config.bus) {
    case 'memory':
      return new InMemoryBus();
    case 'local': {
      const { LocalBrokerBus } = await import('./local-broker-bus');
      return LocalBrokerBus.connect(config.brokerUrl, clientId);
    }
    case 'kafka': {
      const { KafkaBus } = await import('./kafka-bus');
      return KafkaBus.connect(config.kafkaBrokers, clientId);
    }
    default:
      throw new Error(`Unknown BUS "${String(config.bus)}"`);
  }
}
