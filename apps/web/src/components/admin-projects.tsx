'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api } from '../lib/api';
import type {
  AdminProjectDetail,
  AdminProjectItem,
  AdminProjectMember,
  CurrentUser,
} from '../lib/types';

const projectStatusLabels: Record<AdminProjectItem['status'], string> = {
  IDEA: 'Идея',
  ACTIVE: 'В работе',
  PAUSED: 'На паузе',
  COMPLETED: 'Завершён',
  ARCHIVED: 'Архив',
};

export function AdminProjects() {
  const [items, setItems] = useState<AdminProjectItem[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const parameters = new URLSearchParams({ limit: '100' });
    if (query.trim()) parameters.set('q', query.trim());
    setLoading(true);
    try {
      const result = await api<{ items: AdminProjectItem[] }>(`/admin/projects?${parameters}`);
      setItems(result.items);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить проекты');
    } finally {
      setLoading(false);
    }
  }, [query]);

  const loadDetail = useCallback(async (projectId: string) => {
    setLoading(true);
    try {
      setDetail(await api<AdminProjectDetail>(`/admin/projects/${projectId}`));
      setSelectedId(projectId);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось открыть проект');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), 250);
    return () => window.clearTimeout(timer);
  }, [loadList]);

  async function saveProject(values: {
    name: string;
    description: string;
    status: AdminProjectItem['status'];
    visibleInBot: boolean;
    leadPersonId: string;
  }) {
    if (!detail) return;
    setSaving(true);
    setMessage(null);
    try {
      await api(`/admin/projects/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: detail.version,
          name: values.name.trim(),
          description: values.description.trim() || null,
          status: values.status,
          visibleInBot: values.visibleInBot,
          leadPersonId: values.leadPersonId || null,
        }),
      });
      setMessage('Проект сохранён и сразу доступен в пользовательском боте');
      await Promise.all([loadDetail(detail.id), loadList()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось сохранить проект');
    } finally {
      setSaving(false);
    }
  }

  async function archiveProject() {
    if (!detail) return;
    setSaving(true);
    try {
      await api(`/admin/projects/${detail.id}`, { method: 'DELETE' });
      setDetail(null);
      setSelectedId(null);
      setMessage('Проект перенесён в архив и скрыт из пользовательского бота');
      await loadList();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось архивировать проект');
    } finally {
      setSaving(false);
    }
  }

  if (detail) {
    return (
      <ProjectEditor
        detail={detail}
        saving={saving}
        message={message}
        error={error}
        onBack={() => {
          setDetail(null);
          setSelectedId(null);
          setError(null);
          setMessage(null);
        }}
        onSave={saveProject}
        onArchive={archiveProject}
        onReload={() => loadDetail(detail.id)}
      />
    );
  }

  return (
    <>
      <div className="admin-toolbar admin-project-toolbar">
        <label className="admin-search-field">
          <span>Поиск проектов</span>
          <input
            type="search"
            value={query}
            placeholder="Название, описание, владелец или участник"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p>{items.length} проектов из CRM</p>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}
      {loading && !items.length ? <Spinner label="Загружаем проекты" /> : null}
      <div className="admin-card-grid admin-project-grid">
        {items.map((project) => (
          <Card className="admin-project-card" key={project.id}>
            <div className="admin-project-card-top">
              <span className={`project-admin-status is-${project.status.toLowerCase()}`}>
                {projectStatusLabels[project.status]}
              </span>
              <span>{project.visibleInBot ? 'Виден в боте' : 'Скрыт'}</span>
            </div>
            <h2>{project.name}</h2>
            {project.description ? <p>{project.description}</p> : null}
            <dl>
              <div>
                <dt>Владелец</dt>
                <dd>{project.leadPersonName ?? 'не назначен'}</dd>
              </div>
              <div>
                <dt>Участники</dt>
                <dd>{project.memberCount}</dd>
              </div>
              <div>
                <dt>Мероприятия</dt>
                <dd>{project.eventCount}</dd>
              </div>
              <div>
                <dt>Артефакты</dt>
                <dd>{project.artifactCount}</dd>
              </div>
            </dl>
            <Button
              className="primary-button compact-button"
              type="button"
              disabled={loading && selectedId === project.id}
              onClick={() => void loadDetail(project.id)}
            >
              Открыть проект
            </Button>
          </Card>
        ))}
      </div>
      {!loading && !items.length ? (
        <Card className="admin-table-card">
          <p>По этому запросу проектов не найдено.</p>
        </Card>
      ) : null}
    </>
  );
}

function ProjectEditor({
  detail,
  saving,
  message,
  error,
  onBack,
  onSave,
  onArchive,
  onReload,
}: {
  detail: AdminProjectDetail;
  saving: boolean;
  message: string | null;
  error: string | null;
  onBack: () => void;
  onSave: (values: {
    name: string;
    description: string;
    status: AdminProjectItem['status'];
    visibleInBot: boolean;
    leadPersonId: string;
  }) => Promise<void>;
  onArchive: () => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description ?? '');
  const [status, setStatus] = useState(detail.status);
  const [visibleInBot, setVisibleInBot] = useState(detail.visibleInBot);
  const [leadPersonId, setLeadPersonId] = useState(detail.leadPersonId ?? '');
  const [archiveConfirm, setArchiveConfirm] = useState(false);

  useEffect(() => {
    setName(detail.name);
    setDescription(detail.description ?? '');
    setStatus(detail.status);
    setVisibleInBot(detail.visibleInBot);
    setLeadPersonId(detail.leadPersonId ?? '');
  }, [detail]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void onSave({ name, description, status, visibleInBot, leadPersonId });
  }

  return (
    <>
      <div className="admin-section-heading">
        <div>
          <button className="text-button" type="button" onClick={onBack}>
            ← Ко всем проектам
          </button>
          <h2>{detail.name}</h2>
        </div>
        <span>
          {detail.memberCount} участников · {detail.artifactCount} артефактов
        </span>
      </div>
      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice success">{message}</div> : null}
      <Card className="admin-form-card">
        <form className="admin-form" onSubmit={submit}>
          <label>
            <span>Название</span>
            <input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>Статус</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as AdminProjectItem['status'])}
            >
              {Object.entries(projectStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="admin-wide">
            <span>Описание</span>
            <textarea
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            <span>Владелец из участников</span>
            <select value={leadPersonId} onChange={(event) => setLeadPersonId(event.target.value)}>
              <option value="">Не назначен</option>
              {detail.members.map((member) => (
                <option key={member.personId} value={member.personId}>
                  {member.name} — {member.role}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={visibleInBot}
              onChange={(event) => setVisibleInBot(event.target.checked)}
            />
            <span>Показывать проект пользователям бота</span>
          </label>
          <Button className="primary-button admin-wide" type="submit" disabled={saving}>
            Сохранить проект
          </Button>
        </form>
      </Card>

      <ProjectMembers project={detail} saving={saving} onReload={onReload} />

      <Card className="event-delete-confirm project-archive-card">
        <div>
          <h2>Архивация проекта</h2>
          <p>
            Проект исчезнет из каталога бота, но участники, мероприятия и артефакты сохранятся в
            CRM.
          </p>
        </div>
        {archiveConfirm ? (
          <div className="row-actions">
            <Button type="button" disabled={saving} onClick={() => setArchiveConfirm(false)}>
              Отмена
            </Button>
            <Button
              className="danger-button"
              type="button"
              disabled={saving}
              onClick={() => void onArchive()}
            >
              Подтвердить архивацию
            </Button>
          </div>
        ) : (
          <Button
            className="danger-text-button"
            type="button"
            onClick={() => setArchiveConfirm(true)}
          >
            Архивировать проект
          </Button>
        )}
      </Card>
    </>
  );
}

function ProjectMembers({
  project,
  saving,
  onReload,
}: {
  project: AdminProjectDetail;
  saving: boolean;
  onReload: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<CurrentUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [role, setRole] = useState('Участник');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memberPersonIds = useMemo(
    () => new Set(project.members.map((member) => member.personId)),
    [project.members],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!query.trim()) {
        setCandidates([]);
        return;
      }
      const parameters = new URLSearchParams({ q: query.trim(), limit: '30' });
      void api<{ items: CurrentUser[] }>(`/admin/users?${parameters}`)
        .then((result) =>
          setCandidates(
            result.items.filter(
              (user) => user.crmPersonId && !memberPersonIds.has(user.crmPersonId),
            ),
          ),
        )
        .catch((caught) =>
          setError(caught instanceof Error ? caught.message : 'Не удалось найти участника'),
        );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, memberPersonIds]);

  async function addMember(event: FormEvent) {
    event.preventDefault();
    if (!selectedUserId) return;
    setWorking(true);
    setError(null);
    try {
      await api(`/admin/projects/${project.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId: selectedUserId, role }),
      });
      setQuery('');
      setCandidates([]);
      setSelectedUserId('');
      setRole('Участник');
      await onReload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось добавить участника');
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card className="admin-table-card admin-project-members">
      <div className="admin-section-heading">
        <h2>Команда и роли</h2>
        <span>{project.members.length}</span>
      </div>
      <form className="project-member-add" onSubmit={addMember}>
        <label>
          <span>Поиск пользователя бота</span>
          <input
            type="search"
            placeholder="ФИО или @username"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>Кого добавить</span>
          <select
            required
            value={selectedUserId}
            onChange={(event) => setSelectedUserId(event.target.value)}
          >
            <option value="">Выберите пользователя</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.fullName || candidate.telegramUsername || candidate.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Роль</span>
          <input required value={role} onChange={(event) => setRole(event.target.value)} />
        </label>
        <Button className="primary-button" type="submit" disabled={working || saving}>
          Добавить
        </Button>
      </form>
      {error ? <div className="notice error">{error}</div> : null}
      <div className="project-member-list">
        {project.members.map((member) => (
          <ProjectMemberRow
            key={member.personId}
            projectId={project.id}
            member={member}
            disabled={working || saving}
            onReload={onReload}
          />
        ))}
      </div>
    </Card>
  );
}

function ProjectMemberRow({
  projectId,
  member,
  disabled,
  onReload,
}: {
  projectId: string;
  member: AdminProjectMember;
  disabled: boolean;
  onReload: () => Promise<void>;
}) {
  const [role, setRole] = useState(member.role);
  const [working, setWorking] = useState(false);

  useEffect(() => setRole(member.role), [member.role]);

  async function updateRole() {
    setWorking(true);
    try {
      await api(`/admin/projects/${projectId}/members/${member.personId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      await onReload();
    } finally {
      setWorking(false);
    }
  }

  async function remove() {
    setWorking(true);
    try {
      await api(`/admin/projects/${projectId}/members/${member.personId}`, {
        method: 'DELETE',
      });
      await onReload();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="project-member-row">
      <div>
        <strong>{member.name}</strong>
        {member.isLead ? <span>Владелец</span> : null}
      </div>
      <input
        value={role}
        disabled={disabled || working}
        onChange={(event) => setRole(event.target.value)}
        aria-label={`Роль: ${member.name}`}
      />
      <Button
        type="button"
        disabled={disabled || working || role.trim() === member.role}
        onClick={() => void updateRole()}
      >
        Сохранить роль
      </Button>
      <Button
        className="danger-text-button"
        type="button"
        disabled={disabled || working || member.isLead}
        title={member.isLead ? 'Сначала назначьте другого владельца' : undefined}
        onClick={() => void remove()}
      >
        Убрать
      </Button>
    </div>
  );
}
