import type { artifacts, events, exportJobs, submissions, users } from '@cpi/db';
import { sanitizeRichContent, sanitizeRichHtml } from './rich-content';

type EventRow = typeof events.$inferSelect;
type UserRow = typeof users.$inferSelect;
type SubmissionRow = typeof submissions.$inferSelect;
type ArtifactRow = typeof artifacts.$inferSelect;
type ExportRow = typeof exportJobs.$inferSelect;

export function serializeEvent(event: EventRow) {
  const { searchText, ...publicEvent } = event;
  void searchText;
  const now = new Date();
  const acceptsUploads =
    event.deletedAt == null &&
    ['published', 'running'].includes(event.status) &&
    now >= event.acceptUploadsFrom &&
    now <= event.acceptUploadsUntil;
  return {
    ...publicEvent,
    cardPackageId: null,
    description: event.description
      ? sanitizeRichContent(event.description, event.descriptionFormat)
      : null,
    cardHtml: event.cardHtml ? sanitizeRichHtml(event.cardHtml) : null,
    originatedFromCrm: event.managedByCrm || event.tags.includes('CRM'),
    maxFileSizeBytes: Number(event.maxFileSizeBytes),
    acceptsUploads,
  };
}

export function serializeUser(user: UserRow) {
  return {
    ...user,
    telegramUserId: user.telegramUserId?.toString() ?? null,
  };
}

export function serializeSubmission(submission: SubmissionRow) {
  return submission;
}

export function serializeArtifact(artifact: ArtifactRow) {
  const { storageDeletedAt, ...publicArtifact } = artifact;
  void storageDeletedAt;
  return {
    ...publicArtifact,
    sizeBytes: Number(artifact.sizeBytes),
    actualSizeBytes: artifact.actualSizeBytes === null ? null : Number(artifact.actualSizeBytes),
  };
}

export function serializeExportJob(job: ExportRow) {
  return {
    ...job,
    sizeBytes: job.sizeBytes === null ? null : Number(job.sizeBytes),
  };
}
