import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createGreenApiClient, normalizePhone, validateApiUrl } from './greenApi';
import type { Credentials } from './types';

const credentials: Credentials = {
  apiUrl: 'https://4100.api.green-api.com',
  idInstance: '4100000001',
  apiTokenInstance: 'test-token-not-a-real-key',
};
const endpoint = (method: string) =>
  `${credentials.apiUrl}/waInstance${credentials.idInstance}/${method}/${credentials.apiTokenInstance}`;
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('normalizePhone', () => {
  it.each([
    ['+7 (999) 123-45-67', '79991234567'],
    ['  +44 7700 900123  ', '447700900123'],
    ['1234567', '1234567'],
    ['+123456789012345', '123456789012345'],
  ])('normalizes international phone %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each([
    '',
    '123456',
    '0123456789',
    '1234567890123456',
    '@username',
    '+7 999 123 доб. 4',
    '7.999.123.4567',
    '++79991234567',
    '7+9991234567',
  ])('rejects %s', (input) => {
    expect(() => normalizePhone(input)).toThrow();
  });
});

describe('validateApiUrl', () => {
  it.each([
    ['https://api.green-api.com', 'https://api.green-api.com'],
    ['https://4100.api.green-api.com/', 'https://4100.api.green-api.com'],
  ])('allows official endpoint %s', (input, expected) => {
    expect(validateApiUrl(input)).toBe(expected);
  });

  it.each([
    'http://api.green-api.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://api.green-api.com.evil.example',
    'https://evil-api.green-api.com',
    'https://www.green-api.com',
    'https://api.green-api.com@evil.example',
    'https://user:password@api.green-api.com',
    'https://4100.api.green-api.com:8443',
    'https://api.green-api.com/v3',
    'https://api.green-api.com?token=secret',
    'https://api.green-api.com#fragment',
    'not a URL',
  ])('rejects an untrusted endpoint %s', (input) => {
    expect(() => validateApiUrl(input)).toThrow();
  });
});

describe('GREEN-API transport', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the Telegram API endpoints and expected request bodies', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ stateInstance: 'authorized' }))
      .mockResolvedValueOnce(jsonResponse({ incomingWebhook: 'yes' }))
      .mockResolvedValueOnce(jsonResponse({ exist: true, chatId: '123456789' }))
      .mockResolvedValueOnce(jsonResponse({ idMessage: 'remote-message' }));
    const client = createGreenApiClient(credentials);

    expect(await client.getState()).toBe('authorized');
    expect(await client.getSettings()).toEqual({ incomingWebhook: 'yes' });
    expect(await client.checkAccount('+7 (999) 123-45-67')).toBe('123456789');
    expect(await client.sendMessage('123456789', 'Привет, Telegram!')).toBe('remote-message');

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [endpoint('getStateInstance'), 'GET', undefined],
      [endpoint('getSettings'), 'GET', undefined],
      [endpoint('checkAccount'), 'POST', JSON.stringify({ phoneNumber: 79991234567 })],
      [
        endpoint('sendMessage'),
        'POST',
        JSON.stringify({ chatId: '123456789', message: 'Привет, Telegram!' }),
      ],
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      endpoint('sendMessage'),
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      }),
    );
  });

  it('receives a receipt with GET and acknowledges it with DELETE', async () => {
    const notification = { receiptId: 271, body: { typeWebhook: 'incomingMessageReceived' } };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(notification))
      .mockResolvedValueOnce(jsonResponse({ result: true }));
    const client = createGreenApiClient(credentials);
    const signal = new AbortController().signal;

    expect(await client.receive(signal)).toEqual(notification);
    await client.acknowledge(notification.receiptId, signal);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${endpoint('receiveNotification')}?receiveTimeout=30`,
      expect.objectContaining({ method: 'GET', body: undefined }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${endpoint('deleteNotification')}/271`,
      expect.objectContaining({ method: 'DELETE', body: undefined }),
    );
  });

  it('accepts an empty long-poll response and an already deleted receipt', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(jsonResponse({ result: false }));
    const client = createGreenApiClient(credentials);
    const signal = new AbortController().signal;
    expect(await client.receive(signal)).toBeNull();
    await expect(client.acknowledge(271, signal)).resolves.toBeUndefined();
  });

  it('does not accept a malformed ACK response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ result: 'true' }));
    await expect(
      createGreenApiClient(credentials).acknowledge(271, new AbortController().signal),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it.each(['network', 'invalid JSON', 'HTTP 403'] as const)(
    'does not expose credentials after %s failure',
    async (failure) => {
      if (failure === 'network')
        fetchMock.mockRejectedValueOnce(new Error(`Failed to fetch ${endpoint('getSettings')}`));
      if (failure === 'invalid JSON')
        fetchMock.mockResolvedValueOnce(new Response(`secret: ${credentials.apiTokenInstance}`));
      if (failure === 'HTTP 403')
        fetchMock.mockResolvedValueOnce(
          new Response(credentials.apiTokenInstance, { status: 403 }),
        );

      const error = await createGreenApiClient(credentials)
        .getSettings()
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(ApiError);
      expect(String(error)).not.toContain(credentials.apiTokenInstance);
      expect(String(error)).not.toContain(credentials.idInstance);
      expect(String(error)).not.toContain('https://');
    },
  );

  it('marks a network send failure uncertain and never retries the POST', async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError(`Network failure at ${endpoint('sendMessage')}`));
    const result = createGreenApiClient(credentials).sendMessage('123456789', 'Один раз');
    await expect(result).rejects.toMatchObject({ name: 'ApiError', uncertain: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
  });

  it('also treats a server error during send as uncertain', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'internal' }, 503));
    await expect(
      createGreenApiClient(credentials).sendMessage('123456789', 'Тест'),
    ).rejects.toMatchObject({ status: 503, uncertain: true });
  });

  it('aborts the fetch when the caller cancels the request', async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const result = createGreenApiClient(credentials).receive(controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
