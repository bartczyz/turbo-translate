import { browser } from 'wxt/browser';
import type { Envelope, MessageMap, MessageType, Reply } from './types';

/** Send a typed request to the background service worker. Throws on error replies. */
export async function send<T extends MessageType>(type: T, payload: MessageMap[T]['req']): Promise<MessageMap[T]['res']> {
  const reply = (await browser.runtime.sendMessage({ type, payload } satisfies Envelope<T>)) as Reply<MessageMap[T]['res']>;
  if (!reply) throw new Error('No response from TurboTranslate background worker.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

type Sender = { tab?: { id?: number } };
type Handlers = { [T in MessageType]: (payload: MessageMap[T]['req'], sender: Sender) => Promise<MessageMap[T]['res']> };

/** Register background handlers. Uses sendResponse + `return true` for broad browser support. */
export function handleMessages(handlers: Handlers): void {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const msg = message as Envelope;
    const handler = handlers[msg?.type] as ((p: unknown, s: Sender) => Promise<unknown>) | undefined;
    if (!handler) return false;
    handler(msg.payload, sender).then(
      (data) => sendResponse({ ok: true, data }),
      (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
}
