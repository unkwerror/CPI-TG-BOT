'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card } from '@cpi/ui';
import { api } from '../lib/api';
import { combineFullName, splitFullName } from '../lib/profile-name';
import { CatAssistant } from './cat-assistant';
import { PhoneIcon } from './icons';
import { useSession } from './session-provider';
import type { CurrentUser } from '../lib/types';

type NoticeTone = 'success' | 'error' | 'info';

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export function ProfileView({ required = false }: { required?: boolean }) {
  const { user, refreshUser } = useSession();
  const initialName = splitFullName(user?.fullName);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [firstName, setFirstName] = useState(initialName.firstName);
  const [middleName, setMiddleName] = useState(initialName.middleName);
  const [organization, setOrganization] = useState(user?.organization ?? '');
  const [position, setPosition] = useState(user?.position ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [consent, setConsent] = useState(Boolean(user?.consentAt));
  const [saving, setSaving] = useState(false);
  const [requestingPhone, setRequestingPhone] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<NoticeTone>('info');

  useEffect(() => {
    const name = splitFullName(user?.fullName);
    setLastName(name.lastName);
    setFirstName(name.firstName);
    setMiddleName(name.middleName);
    setOrganization(user?.organization ?? '');
    setPosition(user?.position ?? '');
    setPhone(user?.phone ?? '');
    setConsent(Boolean(user?.consentAt));
  }, [user]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const fullName = combineFullName({ lastName, firstName, middleName });
      await api('/me', {
        method: 'PATCH',
        body: JSON.stringify({ fullName, organization, position, phone, consent }),
      });
      await refreshUser();
      setMessage('Профиль сохранён');
      setMessageTone('success');
      window.Telegram?.WebApp.HapticFeedback?.notificationOccurred('success');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось сохранить профиль');
      setMessageTone('error');
    } finally {
      setSaving(false);
    }
  };

  const syncSharedPhone = async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await api<CurrentUser>('/me');
      if (current.phone) {
        // Refreshing the whole user here would overwrite unsaved registration fields.
        setPhone(current.phone);
        setMessage('Номер Telegram добавлен в профиль');
        setMessageTone('success');
        window.Telegram?.WebApp.HapticFeedback?.notificationOccurred('success');
        return;
      }
      await wait(500);
    }
    setMessage('Номер отправлен боту. Если поле не заполнилось, попробуйте ещё раз.');
    setMessageTone('info');
  };

  const requestTelegramPhone = () => {
    const telegram = window.Telegram?.WebApp;
    if (!telegram?.requestContact) {
      setMessage('Эта версия Telegram не поддерживает передачу номера. Введите его вручную.');
      setMessageTone('info');
      return;
    }
    setRequestingPhone(true);
    setMessage(null);
    try {
      telegram.requestContact((shared) => {
        if (!shared) {
          setRequestingPhone(false);
          setMessage('Передача номера отменена — его можно ввести вручную.');
          setMessageTone('info');
          return;
        }
        void syncSharedPhone()
          .catch((caught) => {
            setMessage(caught instanceof Error ? caught.message : 'Не удалось получить номер');
            setMessageTone('error');
          })
          .finally(() => setRequestingPhone(false));
      });
    } catch (caught) {
      setRequestingPhone(false);
      setMessage(caught instanceof Error ? caught.message : 'Не удалось запросить номер');
      setMessageTone('error');
    }
  };

  return (
    <section className="screen profile-screen" aria-labelledby="profile-title">
      <header className="screen-header">
        <p className="eyebrow">{required ? 'Первый вход' : 'Ваши данные'}</p>
        <h1 id="profile-title">{required ? 'Заполните профиль' : 'Профиль'}</h1>
        <p>
          {required
            ? 'Это нужно, чтобы организатор правильно связал материалы с вами.'
            : 'Данные видны только администраторам мероприятий.'}
        </p>
      </header>
      <CatAssistant
        mood={required ? 'talk' : message && messageTone === 'success' ? 'success' : 'idle'}
        compact
        live
        message={
          required
            ? 'Давайте познакомимся. Укажите фамилию, имя и отчество — остальные данные можно заполнить позже.'
            : message && messageTone === 'success'
              ? 'Готово, я запомнил изменения.'
              : 'Если данные изменились, поправьте их здесь — организатор увидит актуальную версию.'
        }
      />
      <Card>
        <form className="form-stack" onSubmit={save}>
          <label>
            <span>Фамилия *</span>
            <input
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              required
              maxLength={64}
              autoComplete="family-name"
            />
          </label>
          <label>
            <span>Имя *</span>
            <input
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
              maxLength={64}
              autoComplete="given-name"
            />
          </label>
          <label>
            <span>Отчество *</span>
            <input
              value={middleName}
              onChange={(event) => setMiddleName(event.target.value)}
              required
              maxLength={64}
              autoComplete="additional-name"
            />
          </label>
          <label>
            <span>Организация</span>
            <input
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
              maxLength={200}
              autoComplete="organization"
            />
          </label>
          <label>
            <span>Должность или роль</span>
            <input
              value={position}
              onChange={(event) => setPosition(event.target.value)}
              maxLength={200}
              autoComplete="organization-title"
            />
          </label>
          <label>
            <span>Телефон или другой контакт</span>
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              maxLength={100}
              autoComplete="tel"
            />
          </label>
          <Button
            className="telegram-contact-button"
            type="button"
            disabled={requestingPhone}
            onClick={requestTelegramPhone}
          >
            <PhoneIcon />
            {requestingPhone ? 'Получаем номер…' : 'Поделиться номером из Telegram'}
          </Button>
          <p className="contact-hint">
            Telegram сначала попросит подтверждение. Номер можно не передавать и заполнить поле
            вручную.
          </p>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              required
            />
            <span>Согласен(на) на обработку данных для сбора материалов мероприятия *</span>
          </label>
          {message ? <div className={`notice ${messageTone}`}>{message}</div> : null}
          <Button className="primary-button" type="submit" disabled={saving || !consent}>
            {saving ? 'Сохраняем…' : 'Сохранить профиль'}
          </Button>
        </form>
      </Card>
    </section>
  );
}
