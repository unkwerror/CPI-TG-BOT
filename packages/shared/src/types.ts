import { z } from 'zod';

import { FULL_NAME_HINT, normalizeFullNameInput, parseRussianFullName } from './full-name';

export const userStatuses = ['active', 'blocked'] as const;
export const roleNames = ['participant', 'admin', 'superadmin'] as const;
export const eventStatuses = ['draft', 'published', 'running', 'finished', 'archived'] as const;
export const eventFormats = ['offline', 'online', 'hybrid'] as const;
export const submissionStatuses = ['draft', 'processing', 'ready', 'failed', 'deleted'] as const;
export const artifactStatuses = [
  'created',
  'uploading',
  'uploaded',
  'verifying',
  'ready',
  'failed',
  'quarantined',
  'deleted',
] as const;
export const artifactKinds = ['file', 'image', 'document', 'audio', 'video', 'archive'] as const;
export const exportStatuses = ['queued', 'processing', 'ready', 'failed', 'expired'] as const;
export const exportKinds = ['csv', 'xlsx', 'zip'] as const;

export type UserStatus = (typeof userStatuses)[number];
export type RoleName = (typeof roleNames)[number];
export type EventStatus = (typeof eventStatuses)[number];
export type EventFormat = (typeof eventFormats)[number];
export type SubmissionStatus = (typeof submissionStatuses)[number];
export type ArtifactStatus = (typeof artifactStatuses)[number];
export type ArtifactKind = (typeof artifactKinds)[number];
export type ExportStatus = (typeof exportStatuses)[number];
export type ExportKind = (typeof exportKinds)[number];

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value));

export const telegramAuthSchema = z.object({
  initData: z.string().min(1).max(16_384),
});

export const maxAuthSchema = z.object({
  initData: z.string().min(1).max(16_384),
});

const requiredFullNameSchema = z
  .string()
  .trim()
  .min(5)
  .max(200)
  .transform(normalizeFullNameInput)
  .refine((value) => parseRussianFullName(value) !== null, { message: FULL_NAME_HINT });

export const profileUpdateSchema = z.object({
  fullName: requiredFullNameSchema,
  organization: nullableText(200),
  position: nullableText(200),
  phone: nullableText(100),
  consent: z.literal(true),
});

const eventFieldsSchema = z.object({
  title: z.string().trim().min(2).max(300),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  shortCode: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((value) => value.toUpperCase()),
  description: nullableText(100_000),
  descriptionFormat: z.enum(['text', 'html']).default('text'),
  cardHtml: nullableText(100_000),
  organizer: z.string().trim().min(2).max(300),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(64).default('Asia/Novosibirsk'),
  venue: nullableText(300),
  city: nullableText(120),
  format: z.enum(eventFormats),
  status: z.enum(eventStatuses),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  coverUrl: z.url().max(2_000).nullable().optional(),
  acceptUploadsFrom: z.iso.datetime({ offset: true }),
  acceptUploadsUntil: z.iso.datetime({ offset: true }),
  maxFileSizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 ** 3)
    .default(500 * 1024 ** 2),
  allowedMimeTypes: z.array(z.string().max(200)).max(100).default([]),
  blockedExtensions: z.array(z.string().max(30)).max(100).default([]),
  directAccessEnabled: z.boolean().default(true),
  leaderIdEventId: z.number().int().positive().safe().nullable().default(null),
  leaderIdRegistrationActive: z.boolean().default(false),
  leaderIdRequiredForSubscription: z.boolean().default(true),
  leaderIdRegistrationOpen: z.boolean().default(true),
  leaderIdSortOrder: z.number().int().min(0).max(10_000).default(0),
  leaderIdRequiresQuestionnaire: z.boolean().default(false),
});

export const eventCreateSchema = eventFieldsSchema.superRefine((value, context) => {
  if (new Date(value.endsAt) <= new Date(value.startsAt)) {
    context.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'Дата окончания должна быть позже даты начала',
    });
  }
  if (new Date(value.acceptUploadsUntil) <= new Date(value.acceptUploadsFrom)) {
    context.addIssue({
      code: 'custom',
      path: ['acceptUploadsUntil'],
      message: 'Окончание приёма должно быть позже начала',
    });
  }
  if (value.leaderIdRegistrationActive && value.leaderIdEventId === null) {
    context.addIssue({
      code: 'custom',
      path: ['leaderIdEventId'],
      message: 'Для активной регистрации укажите ID мероприятия Leader-ID',
    });
  }
});

export const eventUpdateSchema = eventFieldsSchema.partial().superRefine((value, context) => {
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) {
    context.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'Дата окончания должна быть позже даты начала',
    });
  }
  if (
    value.acceptUploadsFrom &&
    value.acceptUploadsUntil &&
    new Date(value.acceptUploadsUntil) <= new Date(value.acceptUploadsFrom)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['acceptUploadsUntil'],
      message: 'Окончание приёма должно быть позже начала',
    });
  }
  if (value.leaderIdRegistrationActive === true && value.leaderIdEventId === null) {
    context.addIssue({
      code: 'custom',
      path: ['leaderIdEventId'],
      message: 'Для активной регистрации укажите ID мероприятия Leader-ID',
    });
  }
});

export const submissionCreateSchema = z
  .object({
    title: nullableText(300),
    text: nullableText(50_000),
    link: z.url().max(2_000).nullable().optional(),
    hasFiles: z.boolean().default(false),
  })
  .refine((value) => Boolean(value.title || value.text || value.link || value.hasFiles), {
    message: 'Добавьте название, текст, ссылку или файл',
  });

export const uploadInitSchema = z.object({
  submissionId: z.uuid(),
  fileName: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(200),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 ** 3),
  lastModified: z.number().int().nonnegative().optional(),
});

export const uploadCompleteSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z.string().trim().min(1).max(500),
      }),
    )
    .max(10_000)
    .default([]),
});

export const exportCreateSchema = z
  .object({
    eventId: z.uuid().optional(),
    kind: z.enum(exportKinds),
    scope: z.enum(['event', 'quick_answers', 'users']).default('event'),
  })
  .refine(
    (value) =>
      value.scope === 'users' ? !value.eventId && value.kind === 'xlsx' : Boolean(value.eventId),
    {
      message:
        'Выберите мероприятие; выгрузка пользователей доступна только в XLSX без мероприятия',
    },
  )
  .refine((value) => value.scope !== 'quick_answers' || value.kind === 'xlsx', {
    message: 'Ответы на быстрый вопрос выгружаются в XLSX',
  });

export const quickAnswerSchema = z.object({ answer: z.string().trim().min(1).max(10_000) });

export const eventListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  format: z.enum(eventFormats).optional(),
  status: z.enum(eventStatuses).optional(),
  dateFrom: z.iso.datetime({ offset: true }).optional(),
  dateTo: z.iso.datetime({ offset: true }).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const paginationQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const adminEventSorts = [
  'created_desc',
  'starts_desc',
  'starts_asc',
  'title_asc',
  'title_desc',
] as const;
export const adminEventPeriods = ['all', 'upcoming', 'ongoing', 'accepting', 'past'] as const;
export type AdminEventSort = (typeof adminEventSorts)[number];
export type AdminEventPeriod = (typeof adminEventPeriods)[number];

export const adminEventListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(eventStatuses).optional(),
    period: z.enum(adminEventPeriods).default('all'),
    sort: z.enum(adminEventSorts).default('created_desc'),
    page: z.coerce.number().int().min(1).max(100_000).optional(),
  })
  .refine((query) => !query.cursor || (query.page === undefined && query.sort === 'created_desc'), {
    message: 'Для сортировки используйте номер страницы, без курсора',
  });

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

export interface AuthResponse {
  user: {
    id: string;
    telegramUserId: string | null;
    messengerProvider: 'telegram' | 'max';
    messengerUserId: string;
    fullName: string | null;
    roles: RoleName[];
    profileComplete: boolean;
  };
  csrfToken: string;
  sessionToken: string;
}

export interface UploadInitResponse {
  artifactId: string;
  uploadType: 'simple' | 'multipart';
  uploadUrl?: string;
  partSize?: number;
  expiresInSeconds: number;
  alreadyCompleted?: boolean;
}

export interface PartUrlResponse {
  url: string;
  partNumber: number;
  expiresInSeconds: number;
}
