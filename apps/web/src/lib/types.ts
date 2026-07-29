import type {
  ArtifactStatus,
  EventFormat,
  EventStatus,
  ExportKind,
  ExportStatus,
  RoleName,
  SubmissionStatus,
} from '@cpi/shared';

export interface CurrentUser {
  id: string;
  telegramUserId: string;
  telegramUsername: string | null;
  fullName: string | null;
  organization: string | null;
  position: string | null;
  phone: string | null;
  consentAt: string | null;
  roles: RoleName[];
  profileComplete: boolean;
}

export interface EventItem {
  id: string;
  title: string;
  slug: string;
  shortCode: string;
  description: string | null;
  organizer: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  venue: string | null;
  city: string | null;
  format: EventFormat;
  status: EventStatus;
  tags: string[];
  coverUrl: string | null;
  acceptUploadsFrom: string;
  acceptUploadsUntil: string;
  maxFileSizeBytes: number;
  allowedMimeTypes: string[];
  blockedExtensions: string[];
  directAccessEnabled: boolean;
  acceptsUploads: boolean;
}

export interface ArtifactItem {
  id: string;
  submissionId: string;
  eventId: string;
  userId: string;
  kind: string;
  originalName: string;
  displayName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  actualSizeBytes: number | null;
  checksumSha256: string | null;
  status: ArtifactStatus;
  statusReason: string | null;
  createdAt: string;
}

export interface SubmissionItem {
  id: string;
  eventId: string;
  userId: string;
  title: string | null;
  text: string | null;
  link: string | null;
  status: SubmissionStatus;
  createdAt: string;
  artifactCount?: number;
  event?: EventItem;
  artifacts?: ArtifactItem[];
}

export interface ExportJob {
  id: string;
  eventId: string;
  kind: ExportKind;
  status: ExportStatus;
  progress: number;
  sizeBytes: number | null;
  errorMessage: string | null;
  createdAt: string;
  expiresAt: string | null;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        initDataUnsafe?: {
          start_param?: string;
        };
        colorScheme: 'light' | 'dark';
        ready(): void;
        expand(): void;
        close(): void;
        openLink?(url: string, options?: { try_instant_view?: boolean }): void;
        requestContact?(callback?: (shared: boolean) => void): void;
        enableClosingConfirmation?(): void;
        disableClosingConfirmation?(): void;
        HapticFeedback?: {
          notificationOccurred(type: 'error' | 'success' | 'warning'): void;
        };
      };
    };
  }
}
