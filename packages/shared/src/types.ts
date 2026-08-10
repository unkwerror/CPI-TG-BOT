import { z } from 'zod';

export const userStatuses = ['active', 'blocked'] as const;
export const userSources = ['bot', 'miniapp', 'import'] as const;
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
/** Запрос из бота: человек описал задачу словами, команда разбирает его вручную. */
export const eventRequestStatuses = ['new', 'in_progress', 'closed'] as const;

export type UserStatus = (typeof userStatuses)[number];
export type UserSource = (typeof userSources)[number];
export type RoleName = (typeof roleNames)[number];
export type EventStatus = (typeof eventStatuses)[number];
export type EventFormat = (typeof eventFormats)[number];
export type SubmissionStatus = (typeof submissionStatuses)[number];
export type ArtifactStatus = (typeof artifactStatuses)[number];
export type ArtifactKind = (typeof artifactKinds)[number];
export type ExportStatus = (typeof exportStatuses)[number];
export type ExportKind = (typeof exportKinds)[number];
export type EventRequestStatus = (typeof eventRequestStatuses)[number];

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

const requiredFullNameSchema = z
  .string()
  .trim()
  .min(5)
  .max(200)
  .transform((value) => value.replace(/\s+/g, ' '))
  .refine((value) => value.split(' ').filter(Boolean).length >= 3, {
    message: 'Укажите фамилию, имя и отчество',
  });

export const profileUpdateSchema = z.object({
  fullName: requiredFullNameSchema,
  organization: nullableText(200),
  position: nullableText(200),
  phone: nullableText(100),
  consent: z.literal(true),
});

export const eventFieldsSchema = z.object({
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
  description: nullableText(10_000),
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
  /** Мероприятие показывается в боте кнопкой «Выбрать событие» только с этим флагом. */
  acceptsRequests: z.boolean().default(false),
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
});

/**
 * `.partial()` не снимает `.default()`, поэтому PATCH без поля молча записывал в базу
 * дефолт вместо сохранённого значения: например, «Скрыть» сбрасывало приём запросов.
 * Для обновления дефолты снимаем — отсутствующее поле должно остаться undefined.
 */
function optionalWithoutDefaults<Shape extends z.ZodRawShape>(shape: Shape) {
  const entries: [string, z.ZodOptional<z.ZodType>][] = Object.entries(shape).map(
    ([key, schema]) => {
      const inner = (schema instanceof z.ZodDefault ? schema.def.innerType : schema) as z.ZodType;
      return [key, inner.optional()];
    },
  );
  return Object.fromEntries(entries) as {
    [Key in keyof Shape]: Shape[Key] extends z.ZodDefault<infer Inner extends z.ZodType>
      ? z.ZodOptional<Inner>
      : Shape[Key] extends z.ZodType
        ? z.ZodOptional<Shape[Key]>
        : never;
  };
}

export const eventUpdateSchema = z
  .object(optionalWithoutDefaults(eventFieldsSchema.shape))
  .superRefine((value, context) => {
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

export const exportCreateSchema = z.object({
  eventId: z.uuid(),
  kind: z.enum(exportKinds),
});

export const eventListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  format: z.enum(eventFormats).optional(),
  status: z.enum(eventStatuses).optional(),
  dateFrom: z.iso.datetime({ offset: true }).optional(),
  dateTo: z.iso.datetime({ offset: true }).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Прошедшие мероприятия скрыты: они мешают найти то, куда ещё можно успеть. */
  includePast: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(false),
});

export const paginationQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Отклик на сообщение рассылки. Значения совпадают с контрактом CRM. */
export const campaignReplyActions = ['INTERESTED', 'MORE_INFO', 'UNSUBSCRIBED'] as const;
export type CampaignReplyAction = (typeof campaignReplyActions)[number];

export const audienceFilters = [
  'all',
  'bot',
  'unregistered',
  'registered',
  'participants',
  'crm_pending',
] as const;
export type AudienceFilter = (typeof audienceFilters)[number];

/**
 * Текст запроса пишут в чате одним сообщением, поэтому нижняя граница мягкая:
 * «нужна помощь с заявкой» — уже осмысленный запрос.
 */
export const eventRequestTextSchema = z
  .string()
  .trim()
  .min(3, 'Опишите запрос чуть подробнее')
  .max(4_000);

export const eventRequestListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(eventRequestStatuses).optional(),
  eventId: z.uuid().optional(),
  /** Составной курсор «createdAt|id»: свежие запросы идут первыми. */
  cursor: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const eventRequestUpdateSchema = z
  .object({
    status: z.enum(eventRequestStatuses).optional(),
    /** null снимает ответственного, отсутствие поля оставляет как было. */
    assignedTo: z.uuid().nullable().optional(),
  })
  .refine((value) => value.status !== undefined || value.assignedTo !== undefined, {
    message: 'Нечего менять',
  });

export const audienceQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  filter: z.enum(audienceFilters).default('all'),
  eventId: z.uuid().optional(),
  /** Составной курсор «createdAt|id»: сортировка идёт по дате, а не по id. */
  cursor: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
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
    telegramUserId: string;
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
