import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Eye, EyeOff, LoaderCircle, LockKeyhole, Send } from 'lucide-react';
import { createGreenApiClient, DEFAULT_API_URL } from '../api/greenApi';
import { createDemoClient } from '../api/demoClient';
import { NotificationPump } from '../api/notificationPump';
import type { Session } from '../chat/useChat';

export default function Login({ onConnect }: { onConnect: (session: Session) => void }) {
  const [id, setId] = useState(''),
    [token, setToken] = useState(''),
    [url, setUrl] = useState(DEFAULT_API_URL);
  const [showToken, setShowToken] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null),
    lock = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    const request = new AbortController();
    controller.current = request;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const client = createGreenApiClient({ idInstance: id, apiTokenInstance: token, apiUrl: url });
      const state = await client.getState(request.signal);
      if (state !== 'authorized')
        throw new Error('Инстанс не авторизован. Подключите Telegram в личном кабинете GREEN-API.');
      const settings = await client.getSettings(request.signal);
      if (settings.typeInstance && settings.typeInstance !== 'telegram')
        throw new Error(
          'Нужен инстанс GREEN-API для Telegram. Проверьте выбранный инстанс в личном кабинете.',
        );
      if (settings.incomingWebhook !== 'yes' || settings.webhookUrl) {
        throw new Error(
          'В настройках инстанса включите входящие уведомления (incomingWebhook: yes) и очистите webhookUrl. После применения настроек войдите снова.',
        );
      }
      if (!request.signal.aborted)
        onConnect({ client, pump: new NotificationPump(client), demo: false });
    } catch (reason) {
      if (!request.signal.aborted)
        setError(reason instanceof Error ? reason.message : 'Не удалось подключиться.');
    } finally {
      lock.current = false;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-top">
        <span className="green-wordmark">
          <span className="green-mark">G</span> GREEN-API
        </span>
        <span className="integration-label">Telegram</span>
      </div>
      <section className="login-card" aria-labelledby="login-title">
        <div className="telegram-mark">
          <Send size={36} fill="currentColor" strokeWidth={1.5} aria-hidden="true" />
        </div>
        <h1 id="login-title">Войти в чат</h1>
        <p className="login-intro">
          Подключите ваш Telegram
          <br />с помощью GREEN-API
        </p>
        <form onSubmit={connect}>
          <label htmlFor="instance">idInstance</label>
          <input
            id="instance"
            name="instance"
            inputMode="numeric"
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="Из личного кабинета"
            required
            pattern="[0-9]+"
            maxLength={24}
            disabled={busy}
            autoComplete="off"
          />
          <label htmlFor="token">apiTokenInstance</label>
          <div className="password-field">
            <input
              id="token"
              name="token"
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Ключ доступа к инстансу"
              required
              maxLength={256}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <button
              className="icon-button"
              type="button"
              onClick={() => setShowToken(!showToken)}
              aria-label={showToken ? 'Скрыть ключ' : 'Показать ключ'}
              aria-pressed={showToken}
            >
              {showToken ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <details className="api-details">
            <summary>Настроить API URL</summary>
            <label htmlFor="api-url">API URL из личного кабинета</label>
            <input
              id="api-url"
              name="api-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              disabled={busy}
            />
          </details>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy && <LoaderCircle className="spin" size={19} />}
            {busy ? 'Подключаемся…' : 'Подключить Telegram'}
          </button>
        </form>
        <div className="privacy-note">
          <LockKeyhole size={15} aria-hidden="true" />
          <span>Ключ хранится только в памяти этой страницы</span>
        </div>
        <button
          className="demo-button"
          disabled={busy}
          onClick={() => {
            const client = createDemoClient();
            onConnect({ client, pump: new NotificationPump(client), demo: true });
          }}
        >
          Посмотреть демо без подключения
        </button>
      </section>
      <p className="login-help">
        Нет инстанса?{' '}
        <a href="https://console.green-api.com/" target="_blank" rel="noreferrer">
          Открыть личный кабинет
        </a>
      </p>
      <footer className="login-footer">Текстовые сообщения · React + GREEN-API</footer>
    </main>
  );
}
