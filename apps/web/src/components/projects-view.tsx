'use client';

import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Spinner } from '@cpi/ui';
import { api } from '../lib/api';
import { getMessengerAdapter } from '../lib/messenger-adapter';
import type {
  ProjectApplicationItem,
  ProjectContextItem,
  ProjectInviteeItem,
  ProjectsContextResponse,
} from '../lib/types';
import { ArrowIcon, CheckIcon, CloseIcon, ProjectIcon, SearchIcon, UserIcon } from './icons';
import { EntityActionDock, EntityBackButton } from './entity-action-dock';

const statusLabels: Record<ProjectContextItem['status'], string> = {
  IDEA: 'Идея',
  ACTIVE: 'В работе',
  PAUSED: 'На паузе',
  COMPLETED: 'Завершён',
  ARCHIVED: 'Архив',
};

const applicationLabels: Record<ProjectApplicationItem['status'], string> = {
  PENDING: 'На рассмотрении',
  APPROVED: 'Одобрена',
  REJECTED: 'Отклонена',
  CANCELLED: 'Отменена',
};

type Composer =
  | { kind: 'create' }
  | { kind: 'join'; project: ProjectContextItem }
  | { kind: 'invite'; project: ProjectContextItem };

export function ProjectsView() {
  const messenger = getMessengerAdapter();
  const [data, setData] = useState<ProjectsContextResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectContextItem | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [role, setRole] = useState('Участник');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [inviteQuery, setInviteQuery] = useState('');
  const [invitees, setInvitees] = useState<ProjectInviteeItem[]>([]);
  const [selectedInviteeId, setSelectedInviteeId] = useState('');
  const [inviteesLoading, setInviteesLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<ProjectsContextResponse>('/projects'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось загрузить проекты');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const matchesProject = useCallback(
    (project: ProjectContextItem) => {
      const needle = query.trim().toLocaleLowerCase('ru');
      if (!needle) return true;
      return [
        project.name,
        project.description,
        project.leadPersonName,
        ...(project.members ?? []).flatMap((member) => [member.name, member.role]),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase('ru').includes(needle));
    },
    [query],
  );
  const mine = useMemo(() => data?.mine.filter(matchesProject) ?? [], [data, matchesProject]);
  const catalog = useMemo(
    () =>
      data?.catalog.filter((project) => !project.membershipRole && matchesProject(project)) ?? [],
    [data, matchesProject],
  );

  useEffect(() => {
    if (composer?.kind !== 'invite') return;
    const normalizedQuery = inviteQuery.trim();
    if (normalizedQuery.length < 2) {
      setInvitees([]);
      setInviteesLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const parameters = new URLSearchParams({ limit: '30', q: normalizedQuery });
      setInviteesLoading(true);
      void api<{ items: ProjectInviteeItem[] }>(`/projects/invitees?${parameters}`)
        .then((result) => {
          if (!cancelled) setInvitees(result.items);
        })
        .catch((caught) => {
          if (!cancelled) {
            setError(caught instanceof Error ? caught.message : 'Не удалось найти участников');
          }
        })
        .finally(() => {
          if (!cancelled) setInviteesLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [composer, inviteQuery]);

  function openCreate() {
    setName('');
    setDescription('');
    setComposer({ kind: 'create' });
  }

  function openJoin(project: ProjectContextItem) {
    setSelectedProject(null);
    setRole('Участник');
    setMessage('');
    setComposer({ kind: 'join', project });
  }

  function openInvite(project: ProjectContextItem) {
    setSelectedProject(null);
    setRole('Участник');
    setInviteQuery('');
    setInvitees([]);
    setSelectedInviteeId('');
    setComposer({ kind: 'invite', project });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!composer) return;
    setSaving(true);
    try {
      if (composer.kind === 'invite') {
        if (!selectedInviteeId) throw new Error('Выберите участника');
        await api(`/projects/${composer.project.id}/invitations`, {
          method: 'POST',
          body: JSON.stringify({
            userId: selectedInviteeId,
            role: role.trim(),
          }),
        });
      } else {
        await api('/projects/applications', {
          method: 'POST',
          body: JSON.stringify(
            composer.kind === 'create'
              ? {
                  type: 'CREATE',
                  proposedName: name.trim(),
                  proposedDescription: description.trim() || undefined,
                }
              : {
                  type: 'JOIN',
                  projectId: composer.project.id,
                  requestedRole: role.trim(),
                  message: message.trim() || undefined,
                },
          ),
        });
      }
      setComposer(null);
      messenger?.notify('success');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось отправить заявку');
      messenger?.notify('error');
    } finally {
      setSaving(false);
    }
  }

  async function review(application: ProjectApplicationItem, decision: 'APPROVED' | 'REJECTED') {
    setReviewingId(application.id);
    try {
      await api(`/projects/applications/${application.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      messenger?.notify('success');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось обработать заявку');
      messenger?.notify('error');
    } finally {
      setReviewingId(null);
    }
  }

  return (
    <section className="wallet-screen projects-screen" aria-labelledby="projects-title">
      <header className="screen-header projects-hero">
        <p className="eyebrow">Команды и идеи</p>
        <h1 id="projects-title">Мои проекты</h1>
        <p>Смотрите свою роль, находите команды и отправляйте заявки.</p>
        <Button className="primary-button" type="button" onClick={openCreate}>
          <ProjectIcon /> Предложить проект
        </Button>
      </header>

      {error ? (
        <div className="notice error" role="alert">
          {error}{' '}
          <button type="button" onClick={() => void load()}>
            Повторить
          </button>
        </div>
      ) : null}
      {loading && !data ? <Spinner label="Загружаем проекты" /> : null}

      <label className="project-search">
        <SearchIcon />
        <input
          type="search"
          value={query}
          placeholder="Проект, участник, роль или владелец"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {data?.incomingApplications.length ? (
        <section className="project-section" aria-labelledby="incoming-projects-title">
          <div className="project-section-heading">
            <div>
              <span>Для руководителя</span>
              <h2 id="incoming-projects-title">Заявки в мои команды</h2>
            </div>
            <b>{data.incomingApplications.length}</b>
          </div>
          <div className="project-list">
            {data.incomingApplications.map((application) => (
              <Card className="project-application-card" key={application.id}>
                <div>
                  <span className="project-pill">{application.projectName}</span>
                  <h3>{application.applicantName}</h3>
                  <p>Желаемая роль: {application.requestedRole}</p>
                  {application.message ? <small>{application.message}</small> : null}
                </div>
                <div className="project-review-actions">
                  <Button
                    disabled={reviewingId === application.id}
                    type="button"
                    onClick={() => void review(application, 'APPROVED')}
                  >
                    <CheckIcon /> Принять
                  </Button>
                  <Button
                    className="secondary-button"
                    disabled={reviewingId === application.id}
                    type="button"
                    onClick={() => void review(application, 'REJECTED')}
                  >
                    Отклонить
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <section className="project-section" aria-labelledby="my-projects-title">
        <div className="project-section-heading">
          <div>
            <span>Участие</span>
            <h2 id="my-projects-title">Мои команды</h2>
          </div>
          <b>{mine.length}</b>
        </div>
        {mine.length ? (
          <div className="project-list">
            {mine.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => setSelectedProject(project)}
                {...(project.isLead ? { onInvite: () => openInvite(project) } : {})}
              />
            ))}
          </div>
        ) : !loading ? (
          <div className="project-empty">
            <ProjectIcon />
            <strong>Вы пока не состоите в проектах</strong>
            <p>Выберите команду ниже или предложите собственную идею.</p>
          </div>
        ) : null}
      </section>

      {data?.applications.length ? (
        <section className="project-section" aria-labelledby="applications-title">
          <div className="project-section-heading">
            <div>
              <span>История</span>
              <h2 id="applications-title">Мои заявки</h2>
            </div>
          </div>
          <div className="project-application-history">
            {data.applications.slice(0, 8).map((application) => (
              <div key={application.id}>
                <span
                  className={`project-application-status is-${application.status.toLowerCase()}`}
                >
                  {applicationLabels[application.status]}
                </span>
                <strong>
                  {application.type === 'CREATE'
                    ? application.proposedName
                    : application.projectName}
                </strong>
                {application.reviewComment ? <small>{application.reviewComment}</small> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="project-section" aria-labelledby="catalog-projects-title">
        <div className="project-section-heading">
          <div>
            <span>Каталог проектов</span>
            <h2 id="catalog-projects-title">Открытые проекты</h2>
          </div>
          <b>{catalog.length}</b>
        </div>
        {catalog.length ? (
          <div className="project-list">
            {catalog.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => setSelectedProject(project)}
                onJoin={() => openJoin(project)}
              />
            ))}
          </div>
        ) : !loading ? (
          <div className="project-empty compact">
            <strong>Новых проектов пока нет</strong>
            <p>В каталоге показываются только опубликованные проекты.</p>
          </div>
        ) : null}
      </section>

      {selectedProject ? (
        <div
          className="wallet-dialog-backdrop project-detail-backdrop"
          role="presentation"
          onMouseDown={() => setSelectedProject(null)}
        >
          <section
            className="wallet-dialog project-detail-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="wallet-dialog-handle" />
            <div className="project-detail-status">
              <span className="project-pill">{statusLabels[selectedProject.status]}</span>
              <span className="project-member-count">
                <UserIcon /> {selectedProject.memberCount}
              </span>
            </div>
            <p className="wallet-kicker">Проект</p>
            <h2 id="project-detail-title">{selectedProject.name}</h2>
            {selectedProject.description ? (
              <p className="project-detail-description">{selectedProject.description}</p>
            ) : null}
            <div className="project-detail-meta">
              <span>
                Руководитель
                <strong>{selectedProject.leadPersonName ?? 'не назначен'}</strong>
              </span>
              {selectedProject.membershipRole ? (
                <span>
                  Ваша роль
                  <strong>{selectedProject.membershipRole}</strong>
                </span>
              ) : null}
            </div>
            {(selectedProject.members ?? []).length ? (
              <div className="project-detail-team">
                <strong>Команда</strong>
                <div className="project-team" aria-label="Команда проекта">
                  {(selectedProject.members ?? []).map((member) => (
                    <span key={member.personId} className={member.isLead ? 'is-lead' : ''}>
                      <strong>{member.name}</strong>
                      <small>{member.isLead ? 'Владелец' : member.role}</small>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
            {!selectedProject.membershipRole ? (
              <Button
                className="wallet-primary-button project-detail-action"
                disabled={Boolean(selectedProject.pendingJoinApplicationId)}
                type="button"
                onClick={() => openJoin(selectedProject)}
              >
                {selectedProject.pendingJoinApplicationId
                  ? 'Заявка отправлена'
                  : 'Вступить в проект'}
              </Button>
            ) : selectedProject.isLead ? (
              <Button
                className="wallet-primary-button project-detail-action"
                type="button"
                onClick={() => openInvite(selectedProject)}
              >
                <UserIcon /> Пригласить участника
              </Button>
            ) : null}
          </section>
          <EntityBackButton
            className="entity-back-button--project"
            label="К проектам"
            onClick={() => setSelectedProject(null)}
          />
          {!selectedProject.membershipRole ? (
            <EntityActionDock
              className="entity-action-dock--project"
              label="Проект"
              detail={selectedProject.name}
            >
              <Button
                className="entity-action-dock__primary"
                disabled={Boolean(selectedProject.pendingJoinApplicationId)}
                type="button"
                onClick={() => openJoin(selectedProject)}
              >
                {selectedProject.pendingJoinApplicationId
                  ? 'Заявка отправлена'
                  : 'Вступить в проект'}
              </Button>
            </EntityActionDock>
          ) : selectedProject.isLead ? (
            <EntityActionDock
              className="entity-action-dock--project"
              label="Проект"
              detail={selectedProject.name}
            >
              <Button
                className="entity-action-dock__primary"
                type="button"
                onClick={() => openInvite(selectedProject)}
              >
                <UserIcon /> Пригласить
              </Button>
            </EntityActionDock>
          ) : null}
        </div>
      ) : null}

      {composer ? (
        <div
          className="sheet-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="project-form-title"
        >
          <section className="bottom-sheet project-sheet">
            <div className="sheet-handle" />
            <button
              className="icon-button sheet-close"
              type="button"
              aria-label="Закрыть"
              disabled={saving}
              onClick={() => setComposer(null)}
            >
              <CloseIcon />
            </button>
            <div className="sheet-heading">
              <span className="event-code">
                {composer.kind === 'invite' ? 'Управление командой' : 'Заявка на проект'}
              </span>
              <h2 id="project-form-title">
                {composer.kind === 'create'
                  ? 'Предложить проект'
                  : composer.kind === 'invite'
                    ? 'Пригласить участника'
                    : 'Вступить в проект'}
              </h2>
              <p>
                {composer.kind === 'create' ? 'Опишите идею для команды' : composer.project.name}
              </p>
            </div>
            <form className="form-stack project-form" onSubmit={submit}>
              {composer.kind === 'create' ? (
                <>
                  <label>
                    <span>Название *</span>
                    <input
                      autoFocus
                      maxLength={500}
                      required
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Описание</span>
                    <textarea
                      maxLength={10_000}
                      rows={5}
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </label>
                </>
              ) : composer.kind === 'join' ? (
                <>
                  <label>
                    <span>Желаемая роль *</span>
                    <input
                      autoFocus
                      maxLength={500}
                      required
                      value={role}
                      onChange={(event) => setRole(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Сообщение руководителю</span>
                    <textarea
                      maxLength={5_000}
                      rows={4}
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    <span>Найти участника</span>
                    <input
                      autoFocus
                      type="search"
                      placeholder="ФИО, @username или организация"
                      minLength={2}
                      value={inviteQuery}
                      onChange={(event) => setInviteQuery(event.target.value)}
                    />
                    <small>Введите минимум 2 символа</small>
                  </label>
                  <label>
                    <span>Участник *</span>
                    <select
                      required
                      value={selectedInviteeId}
                      onChange={(event) => setSelectedInviteeId(event.target.value)}
                    >
                      <option value="">{inviteesLoading ? 'Ищем…' : 'Выберите участника'}</option>
                      {invitees.map((invitee) => (
                        <option key={invitee.id} value={invitee.id}>
                          {invitee.fullName || invitee.telegramUsername || invitee.id}
                          {invitee.telegramUsername ? ` (@${invitee.telegramUsername})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Роль в проекте *</span>
                    <input
                      maxLength={500}
                      required
                      value={role}
                      onChange={(event) => setRole(event.target.value)}
                    />
                  </label>
                </>
              )}
              <Button className="primary-button" disabled={saving} type="submit">
                {saving
                  ? 'Сохраняем…'
                  : composer.kind === 'invite'
                    ? 'Добавить в команду'
                    : 'Отправить заявку'}{' '}
                <ArrowIcon />
              </Button>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function ProjectCard({
  project,
  onOpen,
  onJoin,
  onInvite,
}: {
  project: ProjectContextItem;
  onOpen: () => void;
  onJoin?: () => void;
  onInvite?: () => void;
}) {
  return (
    <Card className="project-card">
      <div className="project-card-top">
        <span className="project-pill">{statusLabels[project.status]}</span>
        <span className="project-member-count">
          <UserIcon /> {project.memberCount}
        </span>
      </div>
      <button className="project-card-open" type="button" onClick={onOpen}>
        <h3>{project.name}</h3>
        <span>
          Подробнее <ArrowIcon />
        </span>
      </button>
      {project.description ? <p>{project.description}</p> : null}
      <div className="project-card-meta">
        <span>
          Руководитель: <strong>{project.leadPersonName ?? 'не назначен'}</strong>
        </span>
        {project.membershipRole ? (
          <span>
            Ваша роль: <strong>{project.membershipRole}</strong>
          </span>
        ) : null}
      </div>
      {(project.members ?? []).length ? (
        <div className="project-team" aria-label="Команда проекта">
          {(project.members ?? []).map((member) => (
            <span key={member.personId} className={member.isLead ? 'is-lead' : ''}>
              <strong>{member.name}</strong>
              <small>{member.isLead ? 'Владелец' : member.role}</small>
            </span>
          ))}
        </div>
      ) : null}
      {onJoin ? (
        <Button
          className="project-join-button"
          disabled={Boolean(project.pendingJoinApplicationId)}
          type="button"
          onClick={onJoin}
        >
          {project.pendingJoinApplicationId ? 'Заявка отправлена' : 'Вступить в проект'}
        </Button>
      ) : onInvite ? (
        <Button className="project-join-button" type="button" onClick={onInvite}>
          <UserIcon /> Пригласить участника
        </Button>
      ) : project.isLead ? (
        <span className="project-lead-label">Вы владелец проекта</span>
      ) : null}
    </Card>
  );
}
