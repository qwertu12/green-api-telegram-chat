import { abortableDelay } from './notificationPump';
import type { TelegramClient, Notification } from './types';

export function createDemoClient(): TelegramClient {
  const notifications: Notification[] = [];
  let receiptId = 0;
  const enqueue = (body: Record<string, unknown>) =>
    notifications.push({ receiptId: ++receiptId, body });
  return {
    async getState() {
      return 'authorized';
    },
    async getSettings() {
      return { typeInstance: 'telegram', incomingWebhook: 'yes', webhookUrl: '' };
    },
    async checkAccount() {
      return '123456789';
    },
    async sendMessage(chatId, text, signal) {
      await abortableDelay(350, signal ?? new AbortController().signal);
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const idMessage = crypto.randomUUID();
      enqueue({ typeWebhook: 'outgoingMessageStatus', idMessage, status: 'delivered' });
      enqueue({
        typeWebhook: 'incomingMessageReceived',
        idMessage: crypto.randomUUID(),
        timestamp: Date.now() / 1000,
        senderData: { chatId, senderName: 'Демо-контакт' },
        messageData: {
          typeMessage: 'textMessage',
          textMessageData: {
            textMessage: `Демо-ответ: «${text}»\n\nЭто локальный пример. Для настоящей переписки подключите GREEN-API.`,
          },
        },
      });
      return idMessage;
    },
    async receive(signal) {
      await abortableDelay(800, signal);
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return notifications[0] ?? null;
    },
    async acknowledge(id) {
      if (notifications[0]?.receiptId === id) notifications.shift();
    },
  };
}
