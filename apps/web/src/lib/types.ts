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
  telegramUserId: string | null;
  messengerProvider: 'telegram' | 'max';
  messengerUserId: string;
  telegramUsername: string | null;
  fullName: string | null;
  organization: string | null;
  position: string | null;
  phone: string | null;
  crmPersonId: string | null;
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
  descriptionFormat: 'text' | 'html';
  cardHtml: string | null;
  cardPackageId: string | null;
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
  managedByCrm: boolean;
  originatedFromCrm: boolean;
  acceptsUploads: boolean;
  acceptsRequests: boolean;
  leaderIdEventId: number | null;
  leaderIdRegistrationActive: boolean;
  leaderIdRequiredForSubscription: boolean;
  leaderIdRegistrationOpen: boolean;
  leaderIdSortOrder: number;
  leaderIdRequiresQuestionnaire: boolean;
  isParticipant?: boolean;
}

export type EventArtifactFieldKind =
  'text' | 'checkbox' | 'link' | 'file' | 'image' | 'document' | 'audio' | 'video' | 'archive';

export interface EventArtifactField {
  id: string;
  formVersionId: string;
  code: string;
  kind: EventArtifactFieldKind;
  label: string;
  description: string | null;
  required: boolean;
  minItems: number;
  maxItems: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  maxFileSizeBytes: number | null;
  sortOrder: number;
  config: { minLength?: number; maxLength?: number; placeholder?: string };
}

export interface EventArtifactForm {
  id: string;
  eventId: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  title: string;
  instructions: string | null;
  submitButtonLabel: string;
  fields: EventArtifactField[];
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

export interface ProjectContextItem {
  id: string;
  name: string;
  description: string | null;
  status: 'IDEA' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';
  visibleInBot: boolean;
  leadPersonId: string | null;
  leadPersonName: string | null;
  membershipRole: string | null;
  isLead: boolean;
  memberCount: number;
  members: ProjectMemberItem[];
  pendingJoinApplicationId: string | null;
}

export interface ProjectMemberItem {
  personId: string;
  name: string;
  role: string;
  isLead: boolean;
}

export interface ProjectInviteeItem {
  id: string;
  fullName: string | null;
  telegramUsername: string | null;
  organization: string | null;
}

export interface AdminProjectItem {
  id: string;
  name: string;
  description: string | null;
  status: ProjectContextItem['status'];
  visibleInBot: boolean;
  leadPersonId: string | null;
  leadPersonName: string | null;
  memberCount: number;
  artifactCount: number;
  eventCount: number;
  version: number;
}

export interface AdminProjectMember extends ProjectMemberItem {
  membershipId: string;
  joinedAt: string;
  version: number;
}

export interface AdminProjectDetail extends AdminProjectItem {
  members: AdminProjectMember[];
}

export interface ProjectApplicationItem {
  id: string;
  type: 'CREATE' | 'JOIN';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  applicantPersonId: string;
  applicantName: string;
  projectId: string | null;
  projectName: string | null;
  proposedName: string | null;
  proposedDescription: string | null;
  requestedRole: string;
  message: string | null;
  reviewComment: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  createdProjectId: string | null;
  createdProjectName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectsContextResponse {
  schemaVersion: 1;
  personId: string;
  catalog: ProjectContextItem[];
  mine: ProjectContextItem[];
  applications: ProjectApplicationItem[];
  incomingApplications: ProjectApplicationItem[];
}

export interface ExportJob {
  id: string;
  eventId: string | null;
  scope: 'event' | 'quick_answers' | 'users';
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
    WebApp?: {
      initData: string;
      initDataUnsafe?: {
        start_param?: string;
      };
      platform?: 'ios' | 'android' | 'desktop' | 'web';
      version?: string;
      deviceName?: string;
      getViewportSize?(): Promise<{ height: string; width: string }>;
      openLink?(url: string): void;
      openMaxLink?(url: string): void;
      downloadFile?(url: string, fileName: string): void;
      enableClosingConfirmation?(): void;
      disableClosingConfirmation?(): void;
      requestContact?(): Promise<{
        phone: string;
        authDate: string;
        hash: string;
      }>;
      openCodeReader?(fileSelect?: boolean): Promise<string>;
      BackButton?: {
        isVisible: boolean;
        show(): void;
        hide(): void;
        onClick(callback: () => void): void;
        offClick(callback: () => void): void;
      };
      HapticFeedback?: {
        notificationOccurred(
          type: 'error' | 'success' | 'warning',
          disableVibrationFallback?: boolean,
        ): void;
      };
    };
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
        setHeaderColor?(color: string): void;
        setBackgroundColor?(color: string): void;
        setBottomBarColor?(color: string): void;
        isVerticalSwipesEnabled?: boolean;
        enableVerticalSwipes?(): void;
        disableVerticalSwipes?(): void;
        openLink?(url: string, options?: { try_instant_view?: boolean }): void;
        openTelegramLink?(url: string): void;
        requestContact?(callback?: (shared: boolean) => void): void;
        showScanQrPopup?(
          parameters: { text?: string },
          callback?: (data: string) => boolean | void,
        ): void;
        closeScanQrPopup?(): void;
        enableClosingConfirmation?(): void;
        disableClosingConfirmation?(): void;
        HapticFeedback?: {
          notificationOccurred(type: 'error' | 'success' | 'warning'): void;
        };
      };
    };
  }
}
