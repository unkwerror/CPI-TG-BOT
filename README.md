# CPI Artifacts — Telegram Mini App для материалов мероприятий

Рабочий MVP собирает текст, ссылки и несколько файлов участников, проверяет Telegram
авторизацию на сервере, загружает файлы напрямую в приватный S3/MinIO и предоставляет
администраторам поиск, статусы, аудит, CSV/XLSX и полный ZIP.

## Быстрый локальный запуск

Нужны Docker Compose 2.30+ и около 4 ГБ свободной памяти.

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Откройте `http://localhost:8080`. В `.env.example` включён явно маркированный dev-вход:
он создаёт пользователя `999000111` с ролью superadmin. Этот путь физически недоступен,
если `NODE_ENV=production`.

Полезные адреса:

- приложение: `http://localhost:8080`;
- админ-панель: `http://localhost:8080/admin`;
- Swagger UI: `http://localhost:8080/documentation`;
- MinIO API: `http://localhost:9000`;
- MinIO console: `http://localhost:9001`.

Команды:

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e

docker compose logs -f api worker bot
docker compose run --rm migrate
docker compose run --rm seed
docker compose down
```

`docker compose down` сохраняет именованные volume'ы. Не добавляйте `-v`, если данные
нужно сохранить.

## Создание Telegram-бота

1. Откройте `@BotFather`, выполните `/newbot` и сохраните токен только в secret manager
   или production `.env`.
2. Задайте `TELEGRAM_BOT_TOKEN`.
3. Укажите числовой Telegram ID первого владельца в
   `SUPERADMIN_TELEGRAM_IDS` (несколько ID — через запятую).
4. Через `/setmenubutton` задайте кнопку «Открыть приложение» и HTTPS URL Mini App.
5. Через `/setdomain` разрешите домен Mini App.
6. В production задайте `BOT_MODE=webhook`, случайный `BOT_WEBHOOK_SECRET` длиной от
   16 символов и публичный `WEB_APP_URL`.

При старте bot сам вызывает `setWebhook` для `${WEB_APP_URL}/telegram/webhook` и
устанавливает команды. Проверка:

```bash
docker compose logs bot
curl -fsS http://localhost:8080/health/api/live
```

Deep link имеет вид:

```text
https://t.me/<bot_username>?start=event_DEMO2026
```

Бот открывает Mini App сразу на мероприятии с этим коротким кодом.

## Production-конфигурация

Создайте `.env` отдельно от Git. Значения `CHANGE_ME` недопустимы. Секреты можно
сгенерировать так:

```bash
openssl rand -base64 36
openssl rand -hex 32
```

Критические переменные:

| Переменная                             | Назначение                                 |
| -------------------------------------- | ------------------------------------------ |
| `ARTIFACTS_DOMAIN`                     | домен web/API с TLS                        |
| `ARTIFACTS_S3_DOMAIN`                  | домен приватного S3 API с TLS              |
| `TELEGRAM_BOT_TOKEN`                   | токен BotFather                            |
| `SUPERADMIN_TELEGRAM_IDS`              | allowlist первого/первых superadmin        |
| `BOT_WEBHOOK_SECRET`                   | проверка webhook-запросов Telegram         |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | владелец схемы и ограниченный runtime user |
| `REDIS_PASSWORD`                       | сессии, rate limit и очередь               |
| `MINIO_ROOT_PASSWORD`                  | только инициализация MinIO                 |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY`       | ограниченный прикладной S3 user            |
| `WEB_ORIGIN`, `WEB_APP_URL`            | единственный разрешённый origin            |
| `S3_PUBLIC_ENDPOINT`                   | адрес, который открывает браузер           |
| `FILE_VERIFICATION_MODE`               | `metadata-only` или `clamav`               |

Полный список и безопасные пояснения находятся в [.env.example](.env.example).

Production Compose:

```bash
docker compose \
  --env-file infra/server/.env \
  -f infra/server/docker-compose.yml \
  up -d --build
```

Он не публикует служебные порты и подключает `web`, `api`, `bot` и `minio` к внешней
Caddy-сети `cpi-crm-production_frontend`. Блоки reverse proxy находятся в
`infra/server/Caddyfile.fragment`. Если на хосте используется отдельный Nginx, можно
адаптировать `infra/nginx/nginx.conf`.

### HTTPS и Telegram

Telegram Mini App и webhook требуют публичный HTTPS. Caddy получает сертификаты
автоматически после того, как оба домена указывают на сервер. Для доменов `sslip.io`
IP уже кодируется в имени; для собственного домена создайте DNS A/AAAA записи.

Не устанавливайте `X-Frame-Options: DENY` на Mini App: Telegram Web открывает его во
frame. Next.js выставляет CSP `frame-ancestors` только для Telegram.

## Первый администратор

Рекомендуемый production-путь:

1. внесите Telegram ID владельца в `SUPERADMIN_TELEGRAM_IDS`;
2. перезапустите API;
3. владелец открывает Mini App из созданного бота;
4. API после валидной Telegram-подписи назначает `participant` и `superadmin`;
5. на вкладке «Профиль» появляется ссылка на `/admin`;
6. superadmin назначает и блокирует других администраторов в соответствующей вкладке.

Seed не создаёт тестового администратора в production без явного
`SEED_ADMIN_TELEGRAM_ID`.

## Работа с файлами

1. API создаёт отправку и метаданные артефакта.
2. До порога `MULTIPART_THRESHOLD_BYTES` выдаётся один presigned PUT.
3. Для больших файлов клиент режет файл на части по `MULTIPART_PART_SIZE_BYTES`,
   получает URL каждой части и хранит ETag.
4. После `/complete` worker сверяет объект, потоково вычисляет SHA-256 и переносит
   его из quarantine в private bucket.
5. Скачивание доступно владельцу или администратору только для `ready` и только по
   короткоживущей ссылке.

При `metadata-only` обычные файлы проверяются по метаданным и checksum, а исполняемые
типы остаются в карантине. Для ClamAV задайте:

```dotenv
FILE_VERIFICATION_MODE=clamav
CLAMAV_HOST=clamav
CLAMAV_PORT=3310
```

и подключите ClamAV-контейнер к backend-сети. Worker использует потоковый `INSTREAM`,
поэтому файл не загружается целиком в RAM.

## Экспорт

В админке выберите мероприятие и формат:

- CSV — единый реестр с типом строки;
- XLSX — листы «Участники» и «Артефакты»;
- ZIP — два XLSX-реестра, все готовые файлы, `text.txt` и `metadata.json`.

Задание исполняется BullMQ worker, показывает прогресс и выдаёт временную ссылку.
Реестры создаются потоково, ZIP сразу передаётся multipart-потоком в S3. Maintenance
удаляет экспорт после retention.

## Health, логи и эксплуатация

Endpoints:

- API: `/health/live`, `/health/ready`, `/metrics`;
- web: `/web-health`;
- worker: порт 3003 внутри backend-сети;
- bot: порт 3002 внутри Docker-сети.

Логи — JSON и не содержат токены, initData, cookie, CSRF или presigned URL.

Проверка production:

```bash
curl -fsS https://<domain>/web-health
curl -fsS https://<domain>/health/api/live
curl -fsS https://<domain>/health/api/ready
curl -fsSI https://<s3-domain>/minio/health/live
docker compose --env-file infra/server/.env -f infra/server/docker-compose.yml ps
```

### Резервное копирование

PostgreSQL:

```bash
docker compose --env-file infra/server/.env -f infra/server/docker-compose.yml \
  exec -T postgres pg_dump -U artifacts_owner -Fc artifacts > artifacts.dump
```

MinIO следует зеркалировать во второе S3/объектное хранилище и включить versioning/
lifecycle согласно политике организации. Проверяйте восстановление регулярно; один
backup без теста восстановления не считается рабочим.

## Тестирование

Реализованы Vitest-проверки:

- валидный, изменённый и просроченный Telegram `initData`;
- запрет доступа участника к чужому файлу и доступ администратора;
- период приёма и лимит размера;
- simple/multipart-план, возобновление отсутствующих частей;
- идемпотентное повторное завершение;
- выбор старых незавершённых загрузок для очистки;
- безопасные ZIP-пути;
- cursor pagination;
- уникальность Telegram-пользователя, участника мероприятия, idempotency и outbox в
  миграции.

Playwright содержит три обязательных сквозных сценария: участник, администратор и
повтор после обрыва PUT. Они запускаются против полного dev-стека.

## Структура

```text
apps/
  api/       Fastify API
  bot/       grammY
  web/       Next.js Mini App + admin
  worker/    BullMQ, проверка, экспорт, cleanup
packages/
  config/    env validation
  db/        Drizzle schema, migrations, seed
  shared/    DTO, Zod, policies
  ui/        shared accessible primitives
infra/
  docker/    multi-stage production Dockerfile
  minio/     private buckets and least-privilege policy
  nginx/     local reverse proxy
  postgres/  restricted runtime role
  server/    production Compose and Caddy fragment
```

Подробнее о границах компонентов, потоке загрузки и решениях безопасности:
[ARCHITECTURE.md](ARCHITECTURE.md). Статическая спецификация:
[docs/openapi.yaml](docs/openapi.yaml); актуальная runtime-версия доступна в Swagger UI.

## Ограничения MVP

- Серверная генерация thumbnail/preview для PDF и изображений не выполняется; браузер
  открывает защищённый временный URL.
- ClamAV не входит в малопамятный production Compose по умолчанию, но адаптер готов.
- Выбранные браузером `File` нельзя восстановить после полного закрытия WebView по
  модели безопасности браузера; текст, ссылка, мероприятие и idempotency keys
  сохраняются, а пользователь повторно выбирает файл.
- Отдельный поисковый движок и CDN не нужны для MVP; PostgreSQL `pg_trgm` и S3-интерфейс
  оставляют возможность подключить их без смены бизнес-модели.
