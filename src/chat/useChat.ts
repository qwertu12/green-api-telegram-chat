import { useEffect, useReducer, useRef, useState } from 'react';
import { ApiError, normalizePhone } from '../api/greenApi';
import { NotificationPump } from '../api/notificationPump';
import type { ConnectionStatus } from '../api/notificationPump';
import type { TelegramClient } from '../api/types';
import { chatReducer, initialState, parseNotification } from './model';

export interface Session {
  client: TelegramClient;
  pump: NotificationPump;
  demo: boolean;
}
export function useChat(session: Session) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [connectionError, setConnectionError] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const lifetime = useRef(new AbortController());
  const createLock = useRef(false),
    sendLock = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const stop = session.pump.start(
      (notification) => {
        const action = parseNotification(notification.body);
        if (action) dispatch(action);
        if (
          notification.body.typeWebhook === 'outgoingMessageStatus' &&
          ['failed', 'noAccount', 'notInGroup'].includes(String(notification.body.status))
        ) {
          setError('Telegram не доставил сообщение. Проверьте получателя и ограничения аккаунта.');
        }
      },
      (status, reason) => {
        if (controller.signal.aborted) return;
        setConnection(status);
        setConnectionError(reason ?? '');
      },
    );
    return () => {
      controller.abort();
      stop();
    };
  }, [session]);

  async function createChat(value: string): Promise<boolean> {
    if (createLock.current) return false;
    setError('');
    let phone: string;
    try {
      phone = normalizePhone(value);
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    }
    const existing = state.chats.find((chat) => chat.phone === phone);
    if (existing) {
      dispatch({ type: 'select', id: existing.id });
      return true;
    }
    createLock.current = true;
    setCreating(true);
    const signal = lifetime.current.signal;
    try {
      const id = await session.client.checkAccount(phone, signal);
      if (signal.aborted) return false;
      dispatch({ type: 'open', id, phone });
      return true;
    } catch (reason) {
      if (!signal.aborted)
        setError(reason instanceof Error ? reason.message : 'Не удалось создать чат.');
      return false;
    } finally {
      createLock.current = false;
      if (!signal.aborted) setCreating(false);
    }
  }

  async function send(text: string): Promise<boolean> {
    if (!state.activeId || sendLock.current || !text.trim() || connection === 'stopped')
      return false;
    const chatId = state.activeId,
      localId = crypto.randomUUID(),
      signal = lifetime.current.signal;
    sendLock.current = true;
    setSending(true);
    setError('');
    dispatch({
      type: 'append',
      chatId,
      message: {
        id: localId,
        text,
        timestamp: Date.now(),
        direction: 'outgoing',
        status: 'sending',
      },
    });
    try {
      const remoteId = await session.client.sendMessage(chatId, text, signal);
      if (signal.aborted) return false;
      dispatch({ type: 'sent', chatId, localId, remoteId });
      return true;
    } catch (reason) {
      if (!signal.aborted) {
        const uncertain = reason instanceof ApiError && reason.uncertain;
        dispatch({ type: 'failed', chatId, localId, uncertain });
        setError(
          uncertain
            ? 'Ответ на отправку не получен. Сообщение могло уйти: проверьте Telegram перед повторной отправкой.'
            : reason instanceof Error
              ? reason.message
              : 'Не удалось отправить сообщение.',
        );
      }
      return false;
    } finally {
      sendLock.current = false;
      if (!signal.aborted) setSending(false);
    }
  }

  return {
    state,
    connection,
    connectionError,
    error,
    creating,
    sending,
    createChat,
    send,
    select: (id: string) => dispatch({ type: 'select', id }),
    dismissError: () => setError(''),
  };
}
