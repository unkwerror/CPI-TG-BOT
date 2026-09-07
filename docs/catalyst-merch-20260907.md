# Catalyst merch release — 2026-09-07

Release: `catalyst-merch-20260907-r1`.

## Storefront

Seven native designs: team ticket, T-shirt poster, notebook grid, blue shopper,
access-card frame, sticker sheet and writing tools. No ZIP packages are loaded for these lots.
The approved user PNGs from `Downloads/Catalyst_catalog_all_6` were converted only:
six 1200×1200 WebP assets total 438,204 bytes, originals untouched.
Use `node scripts/prepare-merch-assets.mjs /path/to/catalog` to prepare a new checkout;
the script refuses to overwrite existing versioned outputs.

## Prices and availability

| Product                 | Points | Stock at publication                                                   |
| ----------------------- | -----: | ---------------------------------------------------------------------- |
| Startup-lynch team pass |   2500 | Informational lot; organisers approve team funding and one of 3 places |
| Catalyst T-shirt        |   1000 | Existing 9 preserved; per-user limit preserved                         |
| Spiral notebook         |    800 | 50 new units                                                           |
| Shopper                 |    700 | 50 new units                                                           |
| Cardholder              |    250 | Unconfirmed: 0, checkout disabled                                      |
| Stickers                |    200 | Unconfirmed: 0, checkout disabled                                      |
| Pen / pencil            |    150 | Unconfirmed: 0, checkout disabled                                      |

Pen/pencil is one product: the selected single-item variant goes into the order comment.
Existing T-shirt colour/size and idempotent retry behaviour remain supported.
There is no team-wallet subsystem: the pass opens the verified Catalyst group for agreement.
It never charges a personal wallet, even via direct API checkout
(`TEAM_FUNDING_REQUIRED`). Opening the group does not reserve a place.
Do not increase ticket inventory to simulate team checkout.

Physical merch uses the existing checkout and pickup-request form in “Мои заявки”.
Unknown inventory must be confirmed and entered through the existing admin stock adjustment.

## Catalogue import

Manifest: `scripts/catalog/catalyst-20260907.json`.
Script: `scripts/sync-catalyst-merch-20260907.cjs`.

The default invocation is a read-only dry run. Apply requires `--apply /path/to/backup.json`,
runtime `DATABASE_URL` and HTTPS `WEB_ORIGIN` or `WEB_APP_URL`.
It backs up previous product/media/inventory metadata, applies one transaction,
records audit entries and uses a release-level idempotency marker.
Existing inventory, reservations, paid-order prices and wallet balances are not reset.
Only newly inserted inventory receives the two explicitly supplied initial quantities.
The script must be copied with its `catalog/catalyst-20260907.json` sibling directory;
the runtime user needs read/traverse permission for that directory.

Deploy the API team-funding guard before publishing the catalogue.

## Deployment and recovery

Production: `https://artifacts.62-113-105-225.sslip.io`.
Server source: `/opt/CPI-TG-BOT`.
Build source: `/opt/CPI-TG-BOT-releases/catalyst-merch-20260907-r1`.
Private backups: `/opt/CPI-TG-BOT/backups/catalyst-merch-20260907-r1`.

Backups include the database dump, previous source, environment, image identifiers
and the pre-import catalogue. These are private server files, not repository content.
Only API and web services were recreated. Bot, worker and database were not restarted.

New images:

- API: `sha256:f1a350176e6f871cc6c33247bb68ffadf7c1e4a3f53075cdbc5245f4dc170fef`.
- Web: `sha256:84fa1655897b2a9658412dfd0e95db56035f8a97f96afa00641545ccc27689b6`.

Previous web image: `cpi-artifacts-web:startup-resilience-20260907-r1`.
Previous API image: `cpi-artifacts-api:native-studio-bb58916`.
They are retained for a service-only rollback. Do not blindly restore the database dump
after new orders: it would erase intervening activity. Catalogue reversions must be
targeted against the recorded audit snapshots while preserving current orders/inventory.

## Verification

- 313 unit tests passed; 2 existing integration tests skipped.
- Web and API builds, TypeScript and changed-source ESLint passed.
- 28 local browser tests passed: catalogue at 320/390/1440 px, Telegram/MAX,
  variant retries, unavailable products, team-pass protection, startup timeout recovery,
  Leader-ID, coworking and existing checkout.
- Public web health, all 10 merchandise photos and all 13 referenced JS/CSS assets returned 200.
- Both production containers healthy; new API bundle contains the team-funding guard.
- Catalogue import replay returned “Already applied; no changes.”
- All 5 public-build browser scenarios passed; the 320 px test needed one retry after
  Chromium reported `ERR_NETWORK_CHANGED` before page navigation. API calls in these
  browser tests were mocked: no test orders or point debits were created on production.
