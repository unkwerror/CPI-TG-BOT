import type { Metadata } from 'next';
import { StartupStudioLogo } from '../../../components/startup-studio-logo';
import { resolveLeaderIdCompletionResult } from '../../../lib/leader-id-completion';
import styles from './leader-id-completion.module.css';

export const metadata: Metadata = {
  title: 'Подключение Leader-ID — Catalyst',
  description: 'Результат подключения Leader-ID к программе Catalyst',
  robots: { index: false, follow: false },
};

const completionCopy = {
  linked: {
    title: 'Leader-ID подключён',
    description: 'Подтверждение завершено. Catalyst уже сохранил привязку вашего профиля.',
    nextStep:
      'Вернитесь в Telegram или MAX — карточка Leader-ID обновится автоматически. Эту страницу можно закрыть.',
    detailsTitle: 'Если статус не обновился',
    details:
      'Откройте карточку Leader-ID в Catalyst и нажмите «Проверить подключение». Повторно регистрироваться в Leader-ID не нужно.',
  },
  error: {
    title: 'Не удалось подключить Leader-ID',
    description:
      'Подтверждение было отменено, ссылка устарела или Leader-ID не завершил авторизацию.',
    nextStep: 'Вернитесь в Telegram или MAX, откройте Catalyst и нажмите «Подтвердить» ещё раз.',
    detailsTitle: 'Что можно проверить',
    details:
      'Убедитесь, что входите в тот профиль, номер которого указали в Catalyst, и разрешите запрошенный доступ Leader-ID.',
  },
} as const;

function StatusIcon({ linked }: { linked: boolean }) {
  return (
    <span className={styles.statusIcon} data-tone={linked ? 'success' : 'error'} aria-hidden="true">
      {linked ? (
        <svg viewBox="0 0 24 24">
          <path d="m5 12.5 4.2 4.2L19 7" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24">
          <path d="M7 7l10 10M17 7 7 17" />
        </svg>
      )}
    </span>
  );
}

export default async function LeaderIdCompletionPage({
  searchParams,
}: {
  searchParams: Promise<{ leaderId?: string | string[] }>;
}) {
  const parameters = await searchParams;
  const result = resolveLeaderIdCompletionResult(parameters.leaderId);
  const linked = result === 'linked';
  const copy = completionCopy[result];

  return (
    <main className={styles.page} data-leader-id-result={result}>
      <section
        className={styles.card}
        aria-labelledby="leader-id-completion-title"
        role={linked ? 'status' : 'alert'}
      >
        <header className={styles.brand}>
          <StartupStudioLogo priority />
          <span>CATALYST</span>
        </header>

        <div className={styles.result}>
          <StatusIcon linked={linked} />
          <div>
            <h1 id="leader-id-completion-title">{copy.title}</h1>
            <p>{copy.description}</p>
          </div>
        </div>

        <div className={styles.nextStep}>
          <strong>Что дальше</strong>
          <p>{copy.nextStep}</p>
        </div>

        <details className={styles.details}>
          <summary>{copy.detailsTitle}</summary>
          <p>{copy.details}</p>
        </details>

        <footer>
          <span aria-hidden="true">ID</span>
          <p>
            Аккаунт Leader-ID создаётся один раз. Заявки на события Catalyst отправляются из Mini
            App.
          </p>
        </footer>
      </section>
    </main>
  );
}
