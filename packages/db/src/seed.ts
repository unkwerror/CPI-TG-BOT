import { and, eq } from 'drizzle-orm';
import { createDatabase } from './client';
import { events, roles, userRoles, users } from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const { db, pool } = createDatabase(databaseUrl, { max: 2 });

try {
  await db
    .insert(roles)
    .values([
      { name: 'participant', description: 'Участник мероприятия' },
      { name: 'admin', description: 'Администратор мероприятий' },
      { name: 'superadmin', description: 'Управление администраторами' },
    ])
    .onConflictDoNothing();

  const explicitSeedAdmin = process.env.SEED_ADMIN_TELEGRAM_ID;
  const testSeedAdmin =
    process.env.NODE_ENV === 'production' ? undefined : (explicitSeedAdmin ?? '999000111');
  const seedTelegramId = explicitSeedAdmin ?? testSeedAdmin;

  if (seedTelegramId) {
    const [admin] = await db
      .insert(users)
      .values({
        telegramUserId: BigInt(seedTelegramId),
        telegramFirstName: 'Тестовый',
        telegramLastName: 'Администратор',
        fullName: 'Тестовый Администратор',
        consentAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.telegramUserId,
        set: { updatedAt: new Date() },
      })
      .returning();
    const [role] = await db.select().from(roles).where(eq(roles.name, 'superadmin')).limit(1);
    if (admin && role) {
      await db
        .insert(userRoles)
        .values({ userId: admin.id, roleId: role.id, assignedBy: admin.id })
        .onConflictDoNothing();
    }
  }

  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const yearAhead = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dayAfter = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  await db
    .insert(events)
    .values([
      {
        title: 'Сбор артефактов — демонстрационное мероприятие',
        slug: 'demo-artifacts',
        shortCode: 'DEMO2026',
        description:
          'Тестовое мероприятие для проверки отправки текста, ссылок и нескольких файлов.',
        organizer: 'ЦПИ',
        startsAt: now,
        endsAt: yearAhead,
        timezone: 'Asia/Novosibirsk',
        city: 'Новосибирск',
        venue: 'Онлайн',
        format: 'hybrid',
        status: 'running',
        tags: ['демо', 'артефакты'],
        acceptUploadsFrom: monthAgo,
        acceptUploadsUntil: yearAhead,
        maxFileSizeBytes: 500 * 1024 ** 2,
        blockedExtensions: ['exe', 'bat', 'cmd', 'msi'],
      },
      {
        title: 'Ближайшая проектная сессия',
        slug: 'project-session',
        shortCode: 'SESSION',
        description: 'Материалы проектной сессии.',
        organizer: 'ЦПИ',
        startsAt: tomorrow,
        endsAt: dayAfter,
        timezone: 'Asia/Novosibirsk',
        city: 'Новосибирск',
        format: 'offline',
        status: 'published',
        tags: ['проектная сессия'],
        acceptUploadsFrom: now,
        acceptUploadsUntil: yearAhead,
      },
    ])
    .onConflictDoNothing();

  const participantRole = await db.select().from(roles).where(eq(roles.name, 'participant')).limit(1);
  if (participantRole.length === 0) throw new Error('Seed roles were not created');

  // Exercise the role lookup during seed so a broken enum/migration fails loudly.
  await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(
      roles,
      and(eq(roles.id, userRoles.roleId), eq(roles.name, participantRole[0]!.name)),
    )
    .limit(1);

  process.stdout.write('Database seed completed\n');
} finally {
  await pool.end();
}
