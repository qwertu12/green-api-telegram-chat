export type MessageStatus = 'sending' | 'queued' | 'delivered' | 'read' | 'failed' | 'uncertain';
export interface Message {
  id: string;
  remoteId?: string;
  text: string;
  timestamp: number;
  direction: 'incoming' | 'outgoing';
  status?: MessageStatus;
}
export interface Chat {
  id: string;
  name: string;
  phone?: string;
  messages: Message[];
  unread: number;
}
export interface ChatState {
  chats: Chat[];
  activeId: string | null;
  statuses: Record<string, MessageStatus>;
}
export type ChatAction =
  | { type: 'open'; id: string; phone?: string }
  | { type: 'select'; id: string }
  | { type: 'incoming'; chatId: string; name: string; message: Message }
  | { type: 'append'; chatId: string; message: Message }
  | { type: 'sent'; chatId: string; localId: string; remoteId: string }
  | { type: 'failed'; chatId: string; localId: string; uncertain: boolean }
  | { type: 'status'; remoteId: string; status: MessageStatus };

export const initialState: ChatState = { chats: [], activeId: null, statuses: {} };
const rank: Record<MessageStatus, number> = {
  sending: 0,
  queued: 1,
  uncertain: 1,
  delivered: 2,
  read: 3,
  failed: 4,
};
function advance(previous: MessageStatus | undefined, next: MessageStatus): MessageStatus {
  return previous && rank[previous] > rank[next] ? previous : next;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'select':
      return {
        ...state,
        activeId: action.id,
        chats: state.chats.map((chat) => (chat.id === action.id ? { ...chat, unread: 0 } : chat)),
      };
    case 'open': {
      const existing = state.chats.some((chat) => chat.id === action.id);
      const chats = existing
        ? state.chats.map((chat) =>
            chat.id === action.id
              ? { ...chat, unread: 0, phone: action.phone ?? chat.phone }
              : chat,
          )
        : [
            {
              id: action.id,
              name: action.phone ? `+${action.phone}` : action.id,
              phone: action.phone,
              messages: [],
              unread: 0,
            },
            ...state.chats,
          ];
      return { ...state, chats, activeId: action.id };
    }
    case 'incoming': {
      const chat = state.chats.find((item) => item.id === action.chatId);
      if (chat?.messages.some((message) => message.remoteId === action.message.remoteId))
        return state;
      const updated: Chat = chat
        ? {
            ...chat,
            name: action.name || chat.name,
            messages: [...chat.messages, action.message].sort((a, b) => a.timestamp - b.timestamp),
            unread: state.activeId === chat.id ? 0 : chat.unread + 1,
          }
        : {
            id: action.chatId,
            name: action.name || action.chatId,
            messages: [action.message],
            unread: 1,
          };
      return {
        ...state,
        chats: [updated, ...state.chats.filter((item) => item.id !== action.chatId)],
      };
    }
    case 'append':
      return {
        ...state,
        chats: state.chats.map((chat) =>
          chat.id === action.chatId
            ? { ...chat, messages: [...chat.messages, action.message] }
            : chat,
        ),
      };
    case 'sent':
      return {
        ...state,
        chats: state.chats.map((chat) =>
          chat.id === action.chatId
            ? {
                ...chat,
                messages: chat.messages.map((message) =>
                  message.id === action.localId
                    ? {
                        ...message,
                        remoteId: action.remoteId,
                        status: state.statuses[action.remoteId] ?? 'queued',
                      }
                    : message,
                ),
              }
            : chat,
        ),
      };
    case 'failed':
      return {
        ...state,
        chats: state.chats.map((chat) =>
          chat.id === action.chatId
            ? {
                ...chat,
                messages: chat.messages.map((message) =>
                  message.id === action.localId
                    ? { ...message, status: action.uncertain ? 'uncertain' : 'failed' }
                    : message,
                ),
              }
            : chat,
        ),
      };
    case 'status': {
      const status = advance(state.statuses[action.remoteId], action.status);
      return {
        ...state,
        statuses: { ...state.statuses, [action.remoteId]: status },
        chats: state.chats.map((chat) => ({
          ...chat,
          messages: chat.messages.map((message) =>
            message.remoteId === action.remoteId
              ? { ...message, status: advance(message.status, status) }
              : message,
          ),
        })),
      };
    }
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
export function parseNotification(body: Record<string, unknown>): ChatAction | null {
  if (body.typeWebhook === 'outgoingMessageStatus' && typeof body.idMessage === 'string') {
    const status =
      body.status === 'read'
        ? 'read'
        : body.status === 'delivered'
          ? 'delivered'
          : ['failed', 'noAccount', 'notInGroup'].includes(String(body.status))
            ? 'failed'
            : null;
    return status ? { type: 'status', remoteId: body.idMessage, status } : null;
  }
  if (body.typeWebhook !== 'incomingMessageReceived') return null;
  const sender = record(body.senderData),
    data = record(body.messageData);
  if (
    typeof sender.chatId !== 'string' ||
    !/^\d+$/.test(sender.chatId) ||
    typeof body.idMessage !== 'string'
  )
    return null;
  const text =
    data.typeMessage === 'textMessage'
      ? record(data.textMessageData).textMessage
      : ['extendedTextMessage', 'quotedMessage'].includes(String(data.typeMessage))
        ? record(data.extendedTextMessageData).text
        : null;
  if (typeof text !== 'string') return null;
  return {
    type: 'incoming',
    chatId: sender.chatId,
    name: typeof sender.senderName === 'string' ? sender.senderName : '',
    message: {
      id: body.idMessage,
      remoteId: body.idMessage,
      text,
      direction: 'incoming',
      timestamp: typeof body.timestamp === 'number' ? body.timestamp * 1000 : Date.now(),
    },
  };
}
