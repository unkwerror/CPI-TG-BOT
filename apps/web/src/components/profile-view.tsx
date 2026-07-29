'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Card } from '@cpi/ui';
import { api } from '../lib/api';
import { useSession } from './session-provider';

export function ProfileView({ required = false }: { required?: boolean }) {
  const { user, refreshUser } = useSession();
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [organization, setOrganization] = useState(user?.organization ?? '');
  const [position, setPosition] = useState(user?.position ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [consent, setConsent] = useState(Boolean(user?.consentAt));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setFullName(user?.fullName ?? '');
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
      await api('/me', {
        method: 'PATCH',
        body: JSON.stringify({ fullName, organization, position, phone, consent }),
      });
      await refreshUser();
      setMessage('Профиль сохранён');
      window.Telegram?.WebApp.HapticFeedback?.notificationOccurred('success');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Не удалось сохранить профиль');
    } finally {
      setSaving(false);
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
      <Card>
        <form className="form-stack" onSubmit={save}>
          <label>
            <span>ФИО *</span>
            <input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              required
              minLength={2}
              maxLength={200}
              autoComplete="name"
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
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              required
            />
            <span>Согласен(на) на обработку данных для сбора материалов мероприятия *</span>
          </label>
          {message ? (
            <div className={`notice ${message === 'Профиль сохранён' ? 'success' : 'error'}`}>
              {message}
            </div>
          ) : null}
          <Button className="primary-button" type="submit" disabled={saving || !consent}>
            {saving ? 'Сохраняем…' : 'Сохранить профиль'}
          </Button>
        </form>
      </Card>
    </section>
  );
}
