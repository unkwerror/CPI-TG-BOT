# Архитектура CPI Artifacts

## Компоненты

Монорепозиторий разделён на четыре независимо масштабируемых приложения:

- `apps/web` — Next.js: Telegram Mini App и защищённая административная панель;
- `apps/api` — Fastify REST API `/api/v1`, OpenAPI, авторизация и выдача presigned URL;
- `apps/worker` — BullMQ worker: проверка файлов, SHA-256, экспорт и очистка;
- `apps/bot` — grammY webhook/polling и идемпотентные уведомления;
- `packages/db` — нормализованная Drizzle-схема, SQL-миграции и seed;
- `packages/shared` — DTO, Zod-валидация, политики доступа и загрузки;
- `packages/config` — строгая проверка переменных окружения;
- `packages/ui` — общие доступные UI-примитивы.

PostgreSQL хранит только метаданные. Redis хранит сессии, rate limit и BullMQ. MinIO
используется через S3 API; пользовательские bucket'ы приватны. В production Caddy
терминирует TLS, а локально ту же маршрутизацию выполняет Nginx.

## Поток авторизации

1. Web получает `Telegram.WebApp.initData`.
2. API строит `data_check_string`, проверяет HMAC-SHA-256 официальным алгоритмом,
   проверяет `auth_date` и только затем upsert'ит пользователя по `telegram_user_id`.
3. API создаёт случайную серверную сессию в Redis и secure/httpOnly/sameSite cookie.
4. Изменяющие запросы дополнительно требуют CSRF-токен из сессии.
5. Роли каждый раз читаются из PostgreSQL, поэтому блокировка и отзыв роли действуют
   без ожидания истечения сессии.

Dev-вход существует только при `NODE_ENV != production` и `DEV_AUTH_ENABLED=true`.

## Поток загрузки

```text
Mini App -> API: submission + /uploads/init
API -> PostgreSQL: artifact(status=uploading, случайный object_key)
API -> Mini App: presigned PUT либо multipart part URLs
Mini App -> MinIO: байты напрямую
Mini App -> API: /complete (идемпотентно)
API -> outbox + BullMQ: artifact.uploaded
Worker -> MinIO: HEAD, потоковое чтение, SHA-256, опциональный ClamAV
Worker -> MinIO: quarantine -> private, удаление исходного объекта
Worker -> PostgreSQL: artifact=ready, submission=ready
Worker -> outbox -> bot: одно подтверждение
```

API не проксирует файл. Для multipart клиент может повторно запросить URL части и
повторить только отсутствующие части. `(user_id, idempotency_key)` запрещает дубликаты
от повторных мобильных запросов. Завершение в состояниях `uploaded`, `verifying` и
`ready` является no-op.

Исполняемые форматы без ClamAV не становятся доступными: они остаются в quarantine.
Для обычных форматов режим `metadata-only` проверяет наличие, фактический размер,
Content-Type и вычисляет SHA-256. Production с повышенными требованиями переключается
на `FILE_VERIFICATION_MODE=clamav`.

## Экспорт

CSV/XLSX/ZIP создаются только в worker. Реестры пишутся потоковым ExcelJS writer.
ZIP передаётся multipart-потоком прямо в S3; бинарные артефакты читаются и добавляются
последовательно, архив целиком не находится в памяти. Временные файлы реестров живут
только в случайном каталоге `/tmp` на время задания.

ZIP содержит единственную папку мероприятия, два XLSX-реестра и каталог каждого
участника/отправки с исходными файлами, `text.txt` и `metadata.json`. Имена сегментов
нормализуются и не могут содержать path traversal.

## Надёжность

- Транзакционный `outbox_events` сохраняет намерение запустить проверку, экспорт или
  уведомление до обращения к Redis.
- Dispatcher повторяет доставку с backoff; BullMQ job ID совпадает с aggregate ID.
- Worker допускает безопасный повтор, а `notification_deliveries.deduplication_key`
  предотвращает повторные сообщения Telegram.
- Ежечасная maintenance-задача отменяет старые multipart-загрузки, физически очищает
  soft-deleted файлы после retention и удаляет истёкшие экспорты.
- Состояние находится в PostgreSQL/Redis/S3, поэтому API и worker можно масштабировать
  горизонтально.

## Безопасность

- Bucket'ы приватны, скачивание возможно только после проверки прав и только по
  короткоживущему URL.
- Исходное имя не участвует в object key; оно хранится как метаданные.
- API ограничивает origin, размер JSON, rate limit и выставляет security headers.
- Логи редактируют cookie, Authorization, CSRF, `initData` и presigned URL.
- Административные операции проверяют роль на сервере и пишутся в `audit_logs`.
- Runtime-пользователь PostgreSQL не владеет схемой, а S3-пользователь ограничен
  тремя bucket'ами.

## Масштабирование и границы MVP

Поиск сейчас использует PostgreSQL `pg_trgm` и keyset pagination. При росте его можно
заменить отдельным движком, не меняя DTO. S3-адаптер совместим с AWS S3. Встроенный
preview использует защищённый download URL; серверная генерация превью и распознавание
контента сознательно не входят в MVP. Резервное копирование выполняется средствами
инфраструктуры PostgreSQL/MinIO и описано в README.
