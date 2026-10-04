import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createGreenApiClient } from './greenApi';
import { abortableDelay, NotificationPump } from './notificationPump';
import type { Notification, TelegramClient } from './types';

const notification: Notification = {
  receiptId: 271,
  body: { typeWebhook: 'incomingMessageReceived', idMessage: 'message-1' },
};
const createClient = () => ({
  getState: vi.fn<TelegramClient['getState']>(),
  getSettings: vi.fn<TelegramClient['getSettings']>(),
  checkAccount: vi.fn<TelegramClient['checkAccount']>(),
  sendMessage: vi.fn<TelegramClient['sendMessage']>(),
  receive: vi.fn<TelegramClient['receive']>().mockResolvedValue(null),
  acknowledge: vi.fn<TelegramClient['acknowledge']>().mockResolvedValue(undefined),
});
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('NotificationPump', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('moves on when the retry finds a receipt already deleted after a lost DELETE response', async () => {
    const response = (body: unknown) => new Response(JSON.stringify(body));
    const nextNotification: Notification = {
      ...notification,
      receiptId: 272,
      body: { ...notification.body, idMessage: 'message-2' },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(notification))
      .mockRejectedValueOnce(new TypeError('DELETE response lost'))
      .mockResolvedValueOnce(response({ result: false }))
      .mockResolvedValueOnce(response(nextNotification))
      .mockResolvedValueOnce(response({ result: true }))
      .mockResolvedValue(response(null));
    vi.stubGlobal('fetch', fetchMock);
    const client = createGreenApiClient({
      apiUrl: 'https://api.green-api.com',
      idInstance: '4100000001',
      apiTokenInstance: 'test-token-not-a-real-key',
    });
    const onNotification = vi.fn();
    const stop = new NotificationPump(client).start(onNotification, vi.fn());
    await flush();
    expect(onNotification).toHaveBeenCalledExactlyOnceWith(notification);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onNotification.mock.calls.map(([receipt]) => receipt.receiptId)).toEqual([271, 272]);
    expect(
      fetchMock.mock.calls.map(([url, init]) => [
        new URL(String(url)).pathname.split('/')[2],
        init?.method,
      ]),
    ).toEqual([
      ['receiveNotification', 'GET'],
      ['deleteNotification', 'DELETE'],
      ['deleteNotification', 'DELETE'],
      ['receiveNotification', 'GET'],
      ['deleteNotification', 'DELETE'],
      ['receiveNotification', 'GET'],
    ]);
    stop();
    await flush();
  });

  it('retries the same ACK before receiving again without handling the message twice', async () => {
    const client = createClient();
    client.receive.mockResolvedValueOnce(notification);
    client.acknowledge.mockRejectedValueOnce(new ApiError('ACK unavailable', 503));
    const onNotification = vi.fn();
    const onStatus = vi.fn();
    const stop = new NotificationPump(client).start(onNotification, onStatus);
    await flush();

    expect(onNotification).toHaveBeenCalledExactlyOnceWith(notification);
    expect(client.receive).toHaveBeenCalledTimes(1);
    expect(client.acknowledge).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith('reconnecting', 'ACK unavailable');
    await vi.advanceTimersByTimeAsync(999);
    expect(client.acknowledge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(client.acknowledge).toHaveBeenCalledTimes(2);
    expect(client.acknowledge.mock.calls.map(([id]) => id)).toEqual([271, 271]);
    expect(client.receive).toHaveBeenCalledTimes(2);
    expect(onNotification).toHaveBeenCalledTimes(1);
    stop();
    await flush();
  });

  it('waits for an aborted poll to settle before starting the replacement', async () => {
    const client = createClient();
    let finishOldPoll!: (value: Notification | null) => void;
    client.receive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldPoll = resolve;
        }),
    );
    const pump = new NotificationPump(client);
    const oldHandler = vi.fn();
    const newHandler = vi.fn();
    const stopOld = pump.start(oldHandler, vi.fn());
    await flush();
    const oldSignal = client.receive.mock.calls[0][0];

    const stopNew = pump.start(newHandler, vi.fn());
    await flush();
    expect(oldSignal.aborted).toBe(true);
    expect(client.receive).toHaveBeenCalledTimes(1);
    finishOldPoll(notification);
    await flush();

    expect(client.receive).toHaveBeenCalledTimes(2);
    expect(client.receive.mock.calls[1][0].aborted).toBe(false);
    expect(oldHandler).not.toHaveBeenCalled();
    expect(newHandler).not.toHaveBeenCalled();
    expect(client.acknowledge).not.toHaveBeenCalled();
    stopOld();
    expect(client.receive.mock.calls[1][0].aborted).toBe(false);
    stopNew();
    await flush();
  });

  it('backs off receiving after network failures and stops immediately on cancellation', async () => {
    const client = createClient();
    client.receive.mockRejectedValue(new ApiError('Сеть недоступна'));
    const onStatus = vi.fn();
    const stop = new NotificationPump(client).start(vi.fn(), onStatus);
    await flush();
    expect(client.receive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.receive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(client.receive).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.receive).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.receive).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledWith('reconnecting', 'Сеть недоступна');
  });

  it.each([401, 403])('stops on HTTP %s without an endless retry loop', async (status) => {
    const client = createClient();
    client.receive.mockRejectedValue(new ApiError('Доступ запрещён', status));
    const onStatus = vi.fn();
    new NotificationPump(client).start(vi.fn(), onStatus);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenLastCalledWith('stopped', 'Доступ запрещён');
    expect(client.receive).toHaveBeenCalledTimes(1);
  });

  it('leaves no timer behind when a delay is cancelled', async () => {
    const controller = new AbortController();
    const delayed = abortableDelay(15_000, controller.signal);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await delayed;
    expect(vi.getTimerCount()).toBe(0);
  });
});
