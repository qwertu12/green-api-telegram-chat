import { describe, expect, it } from 'vitest';
import { chatReducer, initialState, parseNotification } from './model';
import type { ChatAction, ChatState, Message } from './model';

const incoming = (chatId = '123456789', remoteId = 'incoming-1', timestamp = 1000): ChatAction => ({
  type: 'incoming',
  chatId,
  name: 'Алексей',
  message: { id: remoteId, remoteId, text: 'Привет', timestamp, direction: 'incoming' },
});
const outgoing: Message = {
  id: 'local-1',
  text: 'Сообщение',
  timestamp: 1000,
  direction: 'outgoing',
  status: 'sending',
};
const withOutgoing = (): ChatState =>
  chatReducer(chatReducer(initialState, { type: 'open', id: '123456789' }), {
    type: 'append',
    chatId: '123456789',
    message: outgoing,
  });

describe('parseNotification', () => {
  it.each([
    ['textMessage', { textMessageData: { textMessage: 'Обычный текст' } }, 'Обычный текст'],
    [
      'extendedTextMessage',
      { extendedTextMessageData: { text: 'Текст со ссылкой' } },
      'Текст со ссылкой',
    ],
    [
      'quotedMessage',
      {
        extendedTextMessageData: { text: 'Ответ на сообщение' },
        quotedMessage: { textMessage: 'Цитата' },
      },
      'Ответ на сообщение',
    ],
  ])('parses an incoming %s notification', (typeMessage, data, text) => {
    const action = parseNotification({
      typeWebhook: 'incomingMessageReceived',
      idMessage: 'remote-1',
      timestamp: 1720000000,
      senderData: { chatId: '123456789', senderName: 'Алексей' },
      messageData: { typeMessage, ...data },
    });
    expect(action).toEqual({
      type: 'incoming',
      chatId: '123456789',
      name: 'Алексей',
      message: {
        id: 'remote-1',
        remoteId: 'remote-1',
        text,
        timestamp: 1720000000000,
        direction: 'incoming',
      },
    });
  });

  it.each([
    {},
    { typeWebhook: 'stateInstanceChanged' },
    { typeWebhook: 'incomingMessageReceived', idMessage: 'm', senderData: null, messageData: null },
    {
      typeWebhook: 'incomingMessageReceived',
      idMessage: 'm',
      senderData: { chatId: '-123' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'group' } },
    },
    {
      typeWebhook: 'incomingMessageReceived',
      idMessage: 'm',
      senderData: { chatId: '123' },
      messageData: { typeMessage: 'imageMessage' },
    },
    {
      typeWebhook: 'incomingMessageReceived',
      idMessage: 'm',
      senderData: { chatId: '123' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 42 } },
    },
  ])('ignores unsupported or malformed notifications', (body) => {
    expect(parseNotification(body)).toBeNull();
  });

  it.each([
    ['delivered', 'delivered'],
    ['read', 'read'],
    ['failed', 'failed'],
    ['noAccount', 'failed'],
    ['notInGroup', 'failed'],
  ])('maps outgoing status %s', (status, expected) => {
    expect(
      parseNotification({ typeWebhook: 'outgoingMessageStatus', idMessage: 'remote-1', status }),
    ).toEqual({ type: 'status', remoteId: 'remote-1', status: expected });
  });
});

describe('chatReducer', () => {
  it('deduplicates repeated notifications without increasing unread', () => {
    const first = chatReducer(initialState, incoming());
    const duplicate = chatReducer(first, incoming());
    expect(duplicate).toBe(first);
    expect(duplicate.chats[0].messages).toHaveLength(1);
    expect(duplicate.chats[0].unread).toBe(1);
  });

  it('keeps an inactive incoming chat unread without changing the selected chat', () => {
    const opened = chatReducer(initialState, { type: 'open', id: '111111' });
    const state = chatReducer(
      chatReducer(opened, incoming()),
      incoming('123456789', 'incoming-2', 2000),
    );
    expect(state.activeId).toBe('111111');
    expect(state.chats.map((chat) => chat.id)).toEqual(['123456789', '111111']);
    expect(state.chats[0].unread).toBe(2);
    const selected = chatReducer(state, { type: 'select', id: '123456789' });
    expect(selected.chats[0].unread).toBe(0);
    expect(chatReducer(selected, incoming('123456789', 'incoming-3')).chats[0].unread).toBe(0);
  });

  it('orders incoming messages by server timestamp', () => {
    const state = chatReducer(
      chatReducer(initialState, incoming('123456789', 'newer', 2000)),
      incoming('123456789', 'older', 1000),
    );
    expect(state.chats[0].messages.map((message) => message.remoteId)).toEqual(['older', 'newer']);
  });

  it('preserves a status received before the send response supplies its remote id', () => {
    const acknowledged = chatReducer(withOutgoing(), {
      type: 'status',
      remoteId: 'remote-1',
      status: 'read',
    });
    expect(acknowledged.chats[0].messages[0].status).toBe('sending');
    const sent = chatReducer(acknowledged, {
      type: 'sent',
      chatId: '123456789',
      localId: 'local-1',
      remoteId: 'remote-1',
    });
    expect(sent.chats[0].messages[0]).toMatchObject({ remoteId: 'remote-1', status: 'read' });
  });

  it('does not downgrade read after out-of-order delivery statuses', () => {
    let state = chatReducer(withOutgoing(), {
      type: 'sent',
      chatId: '123456789',
      localId: 'local-1',
      remoteId: 'remote-1',
    });
    state = chatReducer(state, { type: 'status', remoteId: 'remote-1', status: 'read' });
    state = chatReducer(state, { type: 'status', remoteId: 'remote-1', status: 'delivered' });
    state = chatReducer(state, { type: 'status', remoteId: 'remote-1', status: 'queued' });
    expect(state.chats[0].messages[0].status).toBe('read');
    expect(state.statuses['remote-1']).toBe('read');
  });

  it('updates only the outgoing message with the matching remote id', () => {
    let state = chatReducer(withOutgoing(), {
      type: 'append',
      chatId: '123456789',
      message: { ...outgoing, id: 'local-2' },
    });
    state = chatReducer(state, {
      type: 'sent',
      chatId: '123456789',
      localId: 'local-1',
      remoteId: 'remote-1',
    });
    state = chatReducer(state, { type: 'status', remoteId: 'remote-1', status: 'delivered' });
    expect(state.chats[0].messages.map((message) => message.status)).toEqual([
      'delivered',
      'sending',
    ]);
  });

  it.each([true, false])(
    'distinguishes uncertain network sends from definite rejection (%s)',
    (uncertain) => {
      const failed = chatReducer(withOutgoing(), {
        type: 'failed',
        chatId: '123456789',
        localId: 'local-1',
        uncertain,
      });
      expect(failed.chats[0].messages[0].status).toBe(uncertain ? 'uncertain' : 'failed');
    },
  );
});
