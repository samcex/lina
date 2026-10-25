// The UI talks to an abstract backend with the exact shape of the shared LinaClient,
// so the dev fixture mode can stand in for a real daemon without touching components.
import type { LinaClient, LiveConnection, LiveHandlers } from '@shared/client';

export type LiveLike = Pick<LiveConnection, 'subscribe' | 'unsubscribe' | 'watchAll' | 'close'>;

export type ClientLike = Omit<LinaClient, 'opts' | 'connect'> & {
  connect(handlers: LiveHandlers): LiveLike;
};

export interface Backend {
  client: ClientLike;
  /** true when rendering handcrafted fixtures instead of a daemon. */
  fixture: boolean;
}
