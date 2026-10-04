export interface Credentials {
  idInstance: string;
  apiTokenInstance: string;
  apiUrl: string;
}
export interface Settings {
  typeInstance?: string;
  incomingWebhook?: string;
  outgoingWebhook?: string;
  webhookUrl?: string;
}
export interface Notification {
  receiptId: number;
  body: Record<string, unknown>;
}
export interface TelegramClient {
  getState(signal?: AbortSignal): Promise<string>;
  getSettings(signal?: AbortSignal): Promise<Settings>;
  checkAccount(phone: string, signal?: AbortSignal): Promise<string>;
  sendMessage(chatId: string, text: string, signal?: AbortSignal): Promise<string>;
  receive(signal: AbortSignal): Promise<Notification | null>;
  acknowledge(receiptId: number, signal: AbortSignal): Promise<void>;
}
