import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { Notification } from './api/types';

const token = 'test-token-not-a-real-key';
const canonicalChatId = '987654321';
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value));

function mockTransport(failSend = false) {
  const pending: { deliver: (notification: Notification) => void; signal: AbortSignal }[] = [];
  let activePolls = 0,
    maxActivePolls = 0;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, options) => {
    const method = new URL(String(input)).pathname.split('/')[2];
    switch (method) {
      case 'getStateInstance':
        return Promise.resolve(jsonResponse({ stateInstance: 'authorized' }));
      case 'getSettings':
        return Promise.resolve(
          jsonResponse({ incomingWebhook: 'yes', outgoingWebhook: 'yes', webhookUrl: '' }),
        );
      case 'checkAccount':
        return Promise.resolve(jsonResponse({ exist: true, chatId: canonicalChatId }));
      case 'sendMessage':
        return failSend
          ? Promise.reject(new TypeError(`Lost response: ${input}`))
          : Promise.resolve(jsonResponse({ idMessage: 'outgoing-remote-1' }));
      case 'deleteNotification':
        return Promise.resolve(jsonResponse({ result: true }));
      case 'receiveNotification':
        return new Promise((resolve, reject) => {
          const signal = options?.signal as AbortSignal;
          activePolls++;
          maxActivePolls = Math.max(maxActivePolls, activePolls);
          const finish = () => {
            activePolls--;
            signal.removeEventListener('abort', abort);
          };
          const abort = () => {
            finish();
            reject(new DOMException('Aborted', 'AbortError'));
          };
          signal.addEventListener('abort', abort, { once: true });
          pending.push({
            signal,
            deliver: (notification) => {
              finish();
              resolve(jsonResponse(notification));
            },
          });
        });
      default:
        throw new Error(`Unexpected test endpoint: ${method}`);
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    pending,
    getActivePolls: () => activePolls,
    getMaxActivePolls: () => maxActivePolls,
  };
}

async function connectAndCreateChat() {
  const user = userEvent.setup();
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await user.type(screen.getByLabelText('idInstance'), '4100000001');
  await user.type(screen.getByLabelText('apiTokenInstance'), token);
  await user.click(screen.getByRole('button', { name: 'Подключить Telegram' }));
  await user.type(await screen.findByLabelText('Номер получателя'), '+7 (999) 123-45-67');
  await user.click(screen.getByRole('button', { name: 'Создать чат' }));
  await screen.findByRole('textbox', { name: 'Сообщение' });
  return user;
}

describe('Telegram chat integration', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('connects, sends to the resolved chat, receives and ACKs, then cancels polling on logout', async () => {
    const transport = mockTransport();
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const user = await connectAndCreateChat();
    const history = screen.getByRole('log', { name: 'История сообщений' });
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Привет из теста');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    expect(await within(history).findByLabelText('Принято GREEN-API')).toBeInTheDocument();

    const sendCalls = transport.fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/sendMessage/'),
    );
    expect(sendCalls).toHaveLength(1);
    expect(JSON.parse(String(sendCalls[0][1]?.body))).toEqual({
      chatId: canonicalChatId,
      message: 'Привет из теста',
    });
    const checkCall = transport.fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/checkAccount/'),
    );
    expect(JSON.parse(String(checkCall?.[1]?.body))).toEqual({ phoneNumber: 79991234567 });

    await waitFor(() => expect(transport.pending).toHaveLength(1));
    await act(async () =>
      transport.pending[0].deliver({
        receiptId: 271,
        body: {
          typeWebhook: 'incomingMessageReceived',
          idMessage: 'incoming-remote-1',
          timestamp: 1720000000,
          senderData: { chatId: canonicalChatId, senderName: 'Алексей' },
          messageData: {
            typeMessage: 'textMessage',
            textMessageData: { textMessage: 'Ответ из Telegram' },
          },
        },
      }),
    );
    expect(await within(history).findByText('Ответ из Telegram')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        transport.fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/deleteNotification/' + token + '/271') &&
            init?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    expect(within(history).getAllByLabelText('Полученное сообщение')).toHaveLength(1);
    expect(transport.getMaxActivePolls()).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }));
    expect(await screen.findByRole('heading', { name: 'Войти в чат' })).toBeInTheDocument();
    await waitFor(() => expect(transport.getActivePolls()).toBe(0));
    expect(transport.pending.at(-1)?.signal.aborted).toBe(true);
    expect(screen.getByLabelText('apiTokenInstance')).toHaveValue('');
    expect(storageWrite).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps an uncertain send visible and does not submit it again automatically', async () => {
    const transport = mockTransport(true);
    const user = await connectAndCreateChat();
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Потерянный ответ');
    await user.click(screen.getByRole('button', { name: 'Отправить сообщение' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Сообщение могло уйти');
    expect(alert).not.toHaveTextContent(token);
    expect(within(screen.getByRole('log')).getByLabelText('Ваше сообщение')).toHaveTextContent(
      'Отправка не подтверждена',
    );
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();
    expect(
      transport.fetchMock.mock.calls.filter(([url]) => String(url).includes('/sendMessage/')),
    ).toHaveLength(1);
  });
});
