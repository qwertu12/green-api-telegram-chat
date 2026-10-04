import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCheck,
  CircleHelp,
  Clock3,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Plus,
  Send,
  X,
} from 'lucide-react';
import { MESSAGE_LIMIT } from '../api/greenApi';
import { useChat } from '../chat/useChat';
import type { Session } from '../chat/useChat';
import type { MessageStatus } from '../chat/model';

const statusLabels: Record<MessageStatus, string> = {
  sending: 'Отправляется',
  queued: 'Принято GREEN-API',
  delivered: 'Доставлено',
  read: 'Прочитано',
  failed: 'Не доставлено',
  uncertain: 'Отправка не подтверждена',
};
const connectionLabels = {
  connecting: 'Подключение…',
  connected: 'Соединение активно',
  reconnecting: 'Восстанавливаем соединение…',
  stopped: 'Соединение остановлено',
};
const time = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const date = (timestamp: number) =>
  new Date(timestamp).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const initials = (name: string) =>
  name.startsWith('+')
    ? name.slice(-2)
    : name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase();

function StatusIcon({ status }: { status: MessageStatus }) {
  return (
    <span
      className={`message-status status-${status}`}
      aria-label={statusLabels[status]}
      title={statusLabels[status]}
    >
      {status === 'sending' ? (
        <Clock3 size={14} />
      ) : status === 'queued' ? (
        <Check size={16} />
      ) : ['delivered', 'read'].includes(status) ? (
        <CheckCheck size={17} />
      ) : (
        <CircleHelp size={15} />
      )}
    </span>
  );
}

export default function ChatWorkspace({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const chat = useChat(session);
  const [newChat, setNewChat] = useState(true),
    [phone, setPhone] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [mobileChat, setMobileChat] = useState(false);
  const history = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null),
    nearBottom = useRef(true);
  const active = chat.state.chats.find((item) => item.id === chat.state.activeId);
  const draft = active ? (drafts[active.id] ?? '') : '';
  const lastMessage = active?.messages.at(-1);

  useEffect(() => {
    if (history.current && nearBottom.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [active?.messages.length, lastMessage?.status]);
  useEffect(() => {
    nearBottom.current = true;
    if (history.current) history.current.scrollTop = history.current.scrollHeight;
    composer.current?.focus();
  }, [active?.id]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (await chat.createChat(phone)) {
      setNewChat(false);
      setPhone('');
      setMobileChat(true);
    }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!active || !draft.trim() || draft.length > MESSAGE_LIMIT || chat.sending) return;
    const id = active.id,
      text = draft;
    nearBottom.current = true;
    setDrafts((previous) => ({ ...previous, [id]: '' }));
    await chat.send(text);
    composer.current?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <main className={`chat-app ${mobileChat ? 'mobile-chat-open' : ''}`}>
      <aside className="sidebar" aria-label="Список чатов">
        <header className="sidebar-header">
          <div className="app-title">
            <div className="small-telegram-mark">
              <Send size={21} fill="currentColor" strokeWidth={1.5} />
            </div>
            <h1>Telegram</h1>
          </div>
          <button
            className="icon-button"
            onClick={onLogout}
            title="Выйти"
            aria-label="Выйти из аккаунта"
          >
            <LogOut size={20} />
          </button>
        </header>
        {session.demo && (
          <div className="demo-banner">Демо · сообщения не отправляются в Telegram</div>
        )}
        <div className="chat-list-heading">
          <h2>Чаты</h2>
          <button
            className="text-button"
            onClick={() => setNewChat(!newChat)}
            aria-expanded={newChat}
          >
            <Plus size={18} />
            Новый чат
          </button>
        </div>
        {newChat && (
          <form className="new-chat-form" onSubmit={create}>
            <label htmlFor="recipient">Номер получателя</label>
            <input
              id="recipient"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+7 (999) 123-45-67"
              autoComplete="off"
              required
              disabled={chat.creating}
              maxLength={32}
            />
            <p>В международном формате, с кодом страны</p>
            <button
              className="primary-button"
              disabled={chat.creating || chat.connection === 'stopped'}
            >
              {chat.creating ? (
                <>
                  <LoaderCircle className="spin" size={18} />
                  Ищем получателя…
                </>
              ) : (
                'Создать чат'
              )}
            </button>
          </form>
        )}
        <nav className="chat-list" aria-label="Чаты">
          {chat.state.chats.length === 0 ? (
            <div className="sidebar-empty">
              <MessageCircle size={29} strokeWidth={1.5} />
              <p>Здесь будут ваши чаты</p>
              <span>Добавьте первого получателя</span>
            </div>
          ) : (
            chat.state.chats.map((item) => (
              <button
                key={item.id}
                className={`chat-item ${item.id === active?.id ? 'selected' : ''}`}
                aria-current={item.id === active?.id ? 'true' : undefined}
                onClick={() => {
                  chat.select(item.id);
                  setMobileChat(true);
                }}
              >
                <span className="avatar">{initials(item.name)}</span>
                <span className="chat-item-copy">
                  <span className="chat-item-top">
                    <strong>{item.name}</strong>
                    {item.messages.length > 0 && (
                      <time>{time(item.messages.at(-1)!.timestamp)}</time>
                    )}
                  </span>
                  <span className="chat-preview">
                    {item.messages.at(-1)?.text ?? 'Начните переписку'}
                  </span>
                </span>
                {item.unread > 0 && (
                  <span className="unread" aria-label={`${item.unread} непрочитанных`}>
                    {item.unread}
                  </span>
                )}
              </button>
            ))
          )}
        </nav>
        <footer className="sidebar-footer">
          <div className={`connection connection-${chat.connection}`} role="status">
            <span className="connection-dot" />
            {connectionLabels[chat.connection]}
          </div>
          <span className="powered-by">через GREEN-API</span>
        </footer>
      </aside>
      <section className="conversation" aria-label="Переписка">
        {active ? (
          <>
            <header className="conversation-header">
              <button
                className="icon-button back-button"
                onClick={() => setMobileChat(false)}
                aria-label="Вернуться к списку чатов"
              >
                <ArrowLeft size={22} />
              </button>
              <span className="avatar small-avatar">{initials(active.name)}</span>
              <div>
                <h2>{active.name}</h2>
                <p>{active.phone ? `+${active.phone} · Telegram` : 'Telegram'}</p>
              </div>
              <span className="text-only-label">Текстовые сообщения</span>
            </header>
            <div
              className="message-history"
              ref={history}
              role="log"
              aria-label="История сообщений"
              aria-live="polite"
              aria-relevant="additions"
              onScroll={() => {
                const element = history.current;
                if (element)
                  nearBottom.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 100;
              }}
            >
              <div className="messages-inner">
                {active.messages.length === 0 ? (
                  <div className="chat-start-hint">Отправьте первое сообщение</div>
                ) : (
                  active.messages.map((message, index) => (
                    <div key={message.id}>
                      {(index === 0 ||
                        date(message.timestamp) !== date(active.messages[index - 1].timestamp)) && (
                        <div className="date-divider">{date(message.timestamp)}</div>
                      )}
                      <div className={`message-row ${message.direction}`}>
                        <article
                          className={`message-bubble ${message.status === 'failed' || message.status === 'uncertain' ? 'message-problem' : ''}`}
                          aria-label={
                            message.direction === 'incoming'
                              ? 'Полученное сообщение'
                              : 'Ваше сообщение'
                          }
                        >
                          <p>{message.text}</p>
                          <div className="message-meta">
                            <time dateTime={new Date(message.timestamp).toISOString()}>
                              {time(message.timestamp)}
                            </time>
                            {message.status && <StatusIcon status={message.status} />}
                          </div>
                          {(message.status === 'failed' || message.status === 'uncertain') && (
                            <span className="message-problem-label">
                              {statusLabels[message.status]}
                            </span>
                          )}
                        </article>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="composer-area">
              <form className="composer" onSubmit={send}>
                <label className="visually-hidden" htmlFor="message">
                  Сообщение
                </label>
                <textarea
                  ref={composer}
                  id="message"
                  value={draft}
                  onChange={(event) =>
                    setDrafts((previous) => ({ ...previous, [active.id]: event.target.value }))
                  }
                  onKeyDown={onKeyDown}
                  placeholder="Написать сообщение…"
                  rows={1}
                  maxLength={MESSAGE_LIMIT}
                  disabled={chat.connection === 'stopped'}
                />
                <button
                  className="send-button"
                  type="submit"
                  aria-label="Отправить сообщение"
                  disabled={!draft.trim() || chat.sending || chat.connection === 'stopped'}
                >
                  {chat.sending ? (
                    <LoaderCircle className="spin" size={23} />
                  ) : (
                    <Send size={23} fill="currentColor" strokeWidth={1.4} />
                  )}
                </button>
              </form>
              <div className="composer-hint">
                <span>Enter — отправить · Shift + Enter — новая строка</span>
                <span>
                  {draft.length > 0 ? `${draft.length} / ${MESSAGE_LIMIT}` : 'Только текст'}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="conversation-empty">
            <div className="empty-chat-icon">
              <MessageCircle size={43} strokeWidth={1.5} />
            </div>
            <h2>Начните общение</h2>
            <p>
              Создайте чат по номеру телефона,
              <br />
              чтобы отправлять и получать сообщения
            </p>
            <span className="empty-chat-label">Telegram + GREEN-API</span>
          </div>
        )}
      </section>
      {(chat.error || chat.connectionError) && (
        <div className="chat-error" role="alert">
          <span>{chat.error || chat.connectionError}</span>
          {chat.error && (
            <button className="icon-button" aria-label="Закрыть ошибку" onClick={chat.dismissError}>
              <X size={18} />
            </button>
          )}
        </div>
      )}
    </main>
  );
}
