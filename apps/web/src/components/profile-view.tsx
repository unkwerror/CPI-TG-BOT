'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card } from '@cpi/ui';
import { isCrmReadyFullName, type AuthResponse } from '@cpi/shared';
import { api, saveAuthSession } from '../lib/api';
import { getMessengerAdapter } from '../lib/messenger-adapter';
import { combineFullName, splitFullName, validateFullName } from '../lib/profile-name';
import { CatAssistant } from './cat-assistant';
import { LeaderIdCard } from './leader-id-card';
import { PhoneIcon, UserIcon } from './icons';
import { useSession } from './session-provider';
import type { CurrentUser } from '../lib/types';

type NoticeTone = 'success' | 'error' | 'info';

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export function ProfileView({
  required = false,
  onBack,
}: {
  required?: boolean;
  onBack?: () => void;
}) {
  const { user, refreshUser } = useSession();
  const messenger = getMessengerAdapter(user?.messengerProvider);
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

  const nameError = validateFullName({ lastName, firstName, middleName });
  /** Профиль был заполнен по старым правилам — короткого имени больше не хватает. */
  const needsFullNameFix = Boolean(user?.fullName) && !isCrmReadyFullName(user?.fullName);
  const profileInitials =
    [firstName, lastName]
      .map((part) => part.trim()[0]?.toUpperCase())
      .filter(Boolean)
      .join('') || 'Я';
  const messengerName = user?.messengerProvider === 'max' ? 'MAX' : 'Telegram';
  const messengerLabel =
    user?.messengerProvider === 'telegram' && user.telegramUsername
      ? `@${user.telegramUsername}`
      : `${messengerName} подключён`;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (nameError) {
      setMessage(nameError);
      setMessageTone('error');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const fullName = combineFullName({ lastName, firstName, middleName });
      await api('/me', {
        method: 'PATCH',
        body: JSON.stringify({
          fullName,
          organization,
          position,
          phone,
          consent,
        }),
      });
      await refreshUser();
      setMessage('Профиль сохранён');
      setMessageTone('success');
      messenger?.notify('success');
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
        setMessage(`Номер ${messengerName} добавлен в профиль`);
        setMessageTone('success');
        messenger?.notify('success');
        return;
      }
      await wait(500);
    }
    setMessage('Номер отправлен боту. Если поле не заполнилось, попробуйте ещё раз.');
    setMessageTone('info');
  };

  const requestMessengerPhone = async () => {
    if (!messenger) {
      setMessage('Мессенджер не поддерживает передачу номера. Введите его вручную.');
      setMessageTone('info');
      return;
    }
    setRequestingPhone(true);
    setMessage(null);
    try {
      const shared = await messenger.requestContact();
      if (shared.mode === 'bot') {
        if (!shared.shared) {
          setMessage('Передача номера отменена — его можно ввести вручную.');
          setMessageTone('info');
          return;
        }
        await syncSharedPhone();
        return;
      }
      const result = await api<AuthResponse & { linked: boolean; phone: string }>(
        '/me/max-contact',
        {
          method: 'POST',
          body: JSON.stringify(shared.contact),
        },
      );
      saveAuthSession(result);
      setPhone(result.phone);
      await refreshUser();
      setMessage(
        result.linked
          ? 'Номер подтверждён, ваши профили Telegram и MAX связаны'
          : 'Номер MAX добавлен в профиль',
      );
      setMessageTone('success');
      messenger.notify('success');
    } catch (caught) {
      setMessage(
        caught instanceof Error
          ? caught.message
          : 'Передача номера отменена — его можно ввести вручную.',
      );
      setMessageTone(caught instanceof Error ? 'error' : 'info');
    } finally {
      setRequestingPhone(false);
    }
  };

  return (
    <section
      className={`screen profile-screen${required ? ' profile-screen--required' : ''}`}
      aria-labelledby="profile-title"
    >
      {onBack ? (
        <button className="profile-back-button" type="button" onClick={onBack}>
          <span aria-hidden="true">←</span>
          Назад
        </button>
      ) : null}
      <header className="profile-hero">
        <div className="profile-hero__identity">
          <div>
            <p className="profile-kicker">
              <i aria-hidden="true" />
              {required ? (needsFullNameFix ? 'Нужно уточнение' : 'Первый вход') : 'Ваши данные'}
            </p>
            <span className="profile-telegram">{messengerLabel}</span>
          </div>
          <span className="profile-avatar" aria-hidden="true">
            {profileInitials}
          </span>
        </div>
        <h1 id="profile-title">
          {required
            ? needsFullNameFix
              ? 'Уточните ФИО'
              : 'Заполните профиль'
            : 'Редактирование профиля'}
        </h1>
        <p>
          {required
            ? needsFullNameFix
              ? 'Раньше хватало короткого имени, теперь для связи материалов с вами нужны фамилия, имя и отчество.'
              : 'Это нужно, чтобы организатор правильно связал материалы с вами.'
            : 'Данные видны только администраторам мероприятий.'}
        </p>
      </header>
      <CatAssistant
        mood={required ? 'talk' : message && messageTone === 'success' ? 'success' : 'idle'}
        compact
        live
        className="profile-assistant"
        title="Помощник профиля"
        message={
          required
            ? needsFullNameFix
              ? 'Допишите, пожалуйста, полное ФИО — так организатор точно найдёт ваши материалы.'
              : 'Давайте познакомимся. Укажите фамилию, имя и отчество — остальные данные можно заполнить позже.'
            : message && messageTone === 'success'
              ? 'Готово, я запомнил изменения.'
              : 'Если данные изменились, поправьте их здесь — организатор увидит актуальную версию.'
        }
      />
      {!required ? (
        <div id="leader-id-catalyst" tabIndex={-1}>
          <LeaderIdCard
            openAuthorization={(url) => {
              getMessengerAdapter()?.openLink(url);
            }}
          />
        </div>
      ) : null}
      <Card className="profile-form-card">
        <form className="form-stack" onSubmit={save}>
          <section className="profile-form-section" aria-labelledby="profile-name-heading">
            <header>
              <span className="profile-section-icon" aria-hidden="true">
                <UserIcon />
              </span>
              <div>
                <h2 id="profile-name-heading">Как вас представить</h2>
                <p>Полное имя помогает без ошибок связать вас с проектами и артефактами.</p>
              </div>
            </header>
            <div className="profile-fields-grid profile-name-grid">
              <label>
                <span>Фамилия *</span>
                <input
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  required
                  maxLength={64}
                  autoComplete="family-name"
                  placeholder="Иванов"
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
                  placeholder="Иван"
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
                  placeholder="Иванович"
                />
              </label>
            </div>
            {nameError && (lastName || firstName || middleName) ? (
              <div className="notice error" role="alert">
                {nameError}
              </div>
            ) : null}
          </section>

          <section className="profile-form-section" aria-labelledby="profile-contact-heading">
            <header>
              <span className="profile-section-icon" aria-hidden="true">
                <PhoneIcon />
              </span>
              <div>
                <h2 id="profile-contact-heading">Работа и контакты</h2>
                <p>Эти данные доступны только организаторам и администраторам.</p>
              </div>
            </header>
            <div className="profile-fields-grid">
              <label>
                <span>Организация</span>
                <input
                  value={organization}
                  onChange={(event) => setOrganization(event.target.value)}
                  maxLength={200}
                  autoComplete="organization"
                  placeholder="Компания или команда"
                />
              </label>
              <label>
                <span>Должность или роль</span>
                <input
                  value={position}
                  onChange={(event) => setPosition(event.target.value)}
                  maxLength={200}
                  autoComplete="organization-title"
                  placeholder="Основатель, эксперт, участник"
                />
              </label>
              <label className="profile-field--wide">
                <span>Телефон или другой контакт</span>
                <input
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  maxLength={100}
                  autoComplete="tel"
                  placeholder="+7 999 000-00-00"
                />
              </label>
            </div>
            <Button
              className="telegram-contact-button"
              type="button"
              disabled={requestingPhone}
              onClick={() => void requestMessengerPhone()}
            >
              <PhoneIcon />
              {requestingPhone ? 'Получаем номер…' : `Поделиться номером из ${messengerName}`}
            </Button>
            <p className="contact-hint">
              {messengerName} сначала попросит подтверждение. Номер также можно ввести вручную.
            </p>
          </section>

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              required
            />
            <span>Согласен(на) на обработку данных для сбора материалов мероприятия *</span>
          </label>
          <div className="profile-save-area">
            {message ? (
              <div
                className={`notice ${messageTone}`}
                role={messageTone === 'error' ? 'alert' : 'status'}
              >
                {message}
              </div>
            ) : null}
            <Button
              className="primary-button"
              type="submit"
              disabled={saving || !consent || Boolean(nameError)}
            >
              {saving ? 'Сохраняем…' : 'Сохранить профиль'}
            </Button>
          </div>
        </form>
      </Card>
    </section>
  );
}
