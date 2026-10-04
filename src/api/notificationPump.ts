import { ApiError } from './greenApi';
import type { TelegramClient, Notification } from './types';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'stopped';
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export class NotificationPump {
  private running: Promise<void> = Promise.resolve();
  private controller?: AbortController;

  constructor(private readonly client: TelegramClient) {}

  start(
    onNotification: (notification: Notification) => void,
    onStatus: (status: ConnectionStatus, error?: string) => void,
  ): () => void {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    // Новый цикл ждёт завершения старого, в том числе при перезапуске StrictMode.
    this.running = this.running.then(() => this.run(controller.signal, onNotification, onStatus));
    return () => controller.abort();
  }

  private async run(
    signal: AbortSignal,
    onNotification: (notification: Notification) => void,
    onStatus: (status: ConnectionStatus, error?: string) => void,
  ): Promise<void> {
    let pending: Notification | null = null;
    let failures = 0;
    if (signal.aborted) return;
    onStatus('connecting');
    while (!signal.aborted) {
      try {
        if (!pending) {
          pending = await this.client.receive(signal);
          if (signal.aborted) return;
          onStatus('connected');
          if (pending) onNotification(pending);
        }
        if (pending) {
          // При сбое DELETE повторяем подтверждение, а не обработку сообщения.
          await this.client.acknowledge(pending.receiptId, signal);
          pending = null;
        } else {
          await abortableDelay(1000, signal);
        }
        failures = 0;
        if (!signal.aborted) onStatus('connected');
      } catch (error) {
        if (signal.aborted) return;
        const message = error instanceof Error ? error.message : 'Ошибка получения сообщений.';
        if (error instanceof ApiError && [401, 403].includes(error.status ?? 0)) {
          onStatus('stopped', message);
          return;
        }
        onStatus('reconnecting', message);
        await abortableDelay(Math.min(1000 * 2 ** failures++, 15_000), signal);
      }
    }
  }
}
