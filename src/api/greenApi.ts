import type { Credentials, TelegramClient, Notification, Settings } from './types';

export const DEFAULT_API_URL = 'https://api.green-api.com';
export const MESSAGE_LIMIT = 4096;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly uncertain = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function validateApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Проверьте API URL из личного кабинета GREEN-API.');
  }
  if (
    url.protocol !== 'https:' ||
    !/^(api|\d+\.api)\.green-api\.com$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !['/'].includes(url.pathname)
  ) {
    throw new Error(
      'Допустим только HTTPS-адрес API GREEN-API, например https://4100.api.green-api.com.',
    );
  }
  return value.replace(/\/+$/, '');
}

export function normalizePhone(value: string): string {
  if (!/^\+?[\d\s()-]+$/.test(value.trim()))
    throw new Error('Введите номер телефона в международном формате.');
  const digits = value.replace(/\D/g, '');
  if (!/^[1-9]\d{6,14}$/.test(digits)) {
    throw new Error('Введите международный номер: код страны и номер, от 7 до 15 цифр.');
  }
  return digits;
}

function httpError(status: number, sending: boolean): ApiError {
  const message =
    status === 401 || status === 403
      ? 'Доступ запрещён. Проверьте ключ, состояние инстанса и ограничения аккаунта.'
      : status === 429
        ? 'Слишком много запросов. Подождите и повторите позже.'
        : status === 400
          ? 'GREEN-API отклонил запрос. Проверьте получателя и текст сообщения.'
          : status >= 500
            ? 'GREEN-API временно недоступен.'
            : `Ошибка GREEN-API (${status}).`;
  return new ApiError(message, status, sending && status >= 500);
}

export function createGreenApiClient(credentials: Credentials): TelegramClient {
  const base = validateApiUrl(credentials.apiUrl);
  const id = credentials.idInstance.trim();
  const token = credentials.apiTokenInstance.trim();
  if (!/^\d+$/.test(id) || !/^[a-zA-Z0-9_-]+$/.test(token))
    throw new Error('Проверьте idInstance и apiTokenInstance.');

  async function request<T>(
    method: string,
    options: { body?: unknown; signal?: AbortSignal; receipt?: number; polling?: boolean } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, options.polling ? 70_000 : 20_000);
    const suffix = options.receipt === undefined ? '' : `/${options.receipt}`;
    const query = options.polling ? '?receiveTimeout=30' : '';
    const sending = method === 'sendMessage';
    try {
      const response = await fetch(`${base}/waInstance${id}/${method}/${token}${suffix}${query}`, {
        method:
          options.receipt !== undefined ? 'DELETE' : options.body === undefined ? 'GET' : 'POST',
        headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      if (!response.ok) throw httpError(response.status, sending);
      const text = await response.text();
      return (options.polling && !text.trim() ? null : JSON.parse(text)) as T;
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (error instanceof ApiError) throw error;
      // URL запроса содержит токен, поэтому не показываем исходную ошибку.
      throw new ApiError(
        controller.signal.aborted
          ? 'Сервер не ответил вовремя.'
          : 'Не удалось связаться с GREEN-API. Проверьте сеть и API URL.',
        undefined,
        sending,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  return {
    async getState(signal) {
      const result = await request<{ stateInstance: string }>('getStateInstance', { signal });
      if (typeof result.stateInstance !== 'string')
        throw new ApiError('Неожиданный ответ GREEN-API.');
      return result.stateInstance;
    },
    getSettings: (signal) => request<Settings>('getSettings', { signal }),
    async checkAccount(phone, signal) {
      const result = await request<{ exist?: boolean; chatId?: string; status?: boolean }>(
        'checkAccount',
        { body: { phoneNumber: Number(normalizePhone(phone)) }, signal },
      );
      if (result.status === false)
        throw new ApiError(
          'Проверка получателя недоступна. Проверьте авторизацию инстанса и лимиты.',
        );
      if (!result.exist)
        throw new ApiError(
          'Аккаунт Telegram не найден или поиск по номеру ограничен настройками получателя.',
        );
      if (typeof result.chatId !== 'string' || !/^\d+$/.test(result.chatId))
        throw new ApiError('GREEN-API не вернул идентификатор личного чата.');
      return result.chatId;
    },
    async sendMessage(chatId, text, signal) {
      if (!text.trim() || text.length > MESSAGE_LIMIT)
        throw new ApiError('Сообщение должно содержать от 1 до 4096 символов.');
      const result = await request<{ idMessage: string }>('sendMessage', {
        body: { chatId, message: text },
        signal,
      });
      if (typeof result.idMessage !== 'string' || !result.idMessage)
        throw new ApiError('Не удалось подтвердить приём сообщения сервером.', undefined, true);
      return result.idMessage;
    },
    receive: (signal) =>
      request<Notification | null>('receiveNotification', { signal, polling: true }),
    async acknowledge(receiptId, signal) {
      const result = await request<{ result: boolean }>('deleteNotification', {
        receipt: receiptId,
        signal,
      });
      if (typeof result.result !== 'boolean')
        throw new ApiError('Не удалось подтвердить получение уведомления.');
    },
  };
}
