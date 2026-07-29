import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { once } from 'node:events';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import archiver from 'archiver';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import {
  artifacts,
  eventParticipants,
  events,
  exportJobs,
  submissions,
  users,
} from '@cpi/db';
import { safeZipSegment } from '@cpi/shared';
import type { WorkerContext } from './context';

type ParticipantRow = Awaited<ReturnType<typeof loadParticipants>>[number];
type ArtifactRow = Awaited<ReturnType<typeof loadArtifacts>>[number];
type SubmissionRow = Awaited<ReturnType<typeof loadSubmissions>>[number];

async function loadParticipants(context: WorkerContext, eventId: string) {
  const output: Array<{
    id: string;
    fullName: string | null;
    username: string | null;
    telegramUserId: string;
    organization: string | null;
    position: string | null;
    phone: string | null;
    joinedAt: Date;
    lastSeenAt: Date;
    submissionCount: number;
    artifactCount: number;
    totalBytes: number;
  }> = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await context.db
      .select({
        id: users.id,
        fullName: users.fullName,
        username: users.telegramUsername,
        telegramUserId: users.telegramUserId,
        organization: users.organization,
        position: users.position,
        phone: users.phone,
        joinedAt: eventParticipants.joinedAt,
        lastSeenAt: users.lastSeenAt,
        submissionCount: sql<number>`(
          select count(*)::int from submissions s
          where s.event_id = ${eventId} and s.user_id = ${users.id} and s.deleted_at is null
        )`,
        artifactCount: sql<number>`(
          select count(*)::int from artifacts a
          where a.event_id = ${eventId} and a.user_id = ${users.id} and a.deleted_at is null
        )`,
        totalBytes: sql<number>`(
          select coalesce(sum(coalesce(a.actual_size_bytes, a.size_bytes)), 0)::bigint
          from artifacts a
          where a.event_id = ${eventId} and a.user_id = ${users.id} and a.deleted_at is null
        )`,
      })
      .from(eventParticipants)
      .innerJoin(users, eq(users.id, eventParticipants.userId))
      .where(
        and(
          eq(eventParticipants.eventId, eventId),
          cursor ? gt(users.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(users.id))
      .limit(500);
    output.push(
      ...rows.map((row) => ({
        ...row,
        telegramUserId: row.telegramUserId.toString(),
        submissionCount: Number(row.submissionCount),
        artifactCount: Number(row.artifactCount),
        totalBytes: Number(row.totalBytes),
      })),
    );
    if (rows.length < 500) break;
    cursor = rows.at(-1)!.id;
  }
  return output;
}

async function loadArtifacts(context: WorkerContext, eventId: string) {
  const output: Array<{
    id: string;
    submissionId: string;
    userId: string;
    fullName: string | null;
    telegramUserId: string;
    title: string | null;
    text: string | null;
    link: string | null;
    originalName: string;
    displayName: string;
    mimeType: string;
    sizeBytes: number;
    checksum: string | null;
    status: string;
    bucket: string;
    objectKey: string;
    createdAt: Date;
  }> = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await context.db
      .select({
        id: artifacts.id,
        submissionId: artifacts.submissionId,
        userId: artifacts.userId,
        fullName: users.fullName,
        telegramUserId: users.telegramUserId,
        title: submissions.title,
        text: submissions.text,
        link: submissions.link,
        originalName: artifacts.originalName,
        displayName: artifacts.displayName,
        mimeType: artifacts.mimeType,
        sizeBytes: artifacts.sizeBytes,
        checksum: artifacts.checksumSha256,
        status: artifacts.status,
        bucket: artifacts.bucket,
        objectKey: artifacts.objectKey,
        createdAt: artifacts.createdAt,
      })
      .from(artifacts)
      .innerJoin(users, eq(users.id, artifacts.userId))
      .innerJoin(submissions, eq(submissions.id, artifacts.submissionId))
      .where(
        and(
          eq(artifacts.eventId, eventId),
          isNull(artifacts.deletedAt),
          cursor ? gt(artifacts.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(artifacts.id))
      .limit(500);
    output.push(
      ...rows.map((row) => ({
        ...row,
        telegramUserId: row.telegramUserId.toString(),
        sizeBytes: Number(row.sizeBytes),
      })),
    );
    if (rows.length < 500) break;
    cursor = rows.at(-1)!.id;
  }
  return output;
}

async function loadSubmissions(context: WorkerContext, eventId: string) {
  const output: Array<{
    id: string;
    userId: string;
    fullName: string | null;
    telegramUserId: string;
    title: string | null;
    text: string | null;
    link: string | null;
    status: string;
    createdAt: Date;
  }> = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await context.db
      .select({
        id: submissions.id,
        userId: submissions.userId,
        fullName: users.fullName,
        telegramUserId: users.telegramUserId,
        title: submissions.title,
        text: submissions.text,
        link: submissions.link,
        status: submissions.status,
        createdAt: submissions.createdAt,
      })
      .from(submissions)
      .innerJoin(users, eq(users.id, submissions.userId))
      .where(
        and(
          eq(submissions.eventId, eventId),
          isNull(submissions.deletedAt),
          cursor ? gt(submissions.id, cursor) : undefined,
        ),
      )
      .orderBy(asc(submissions.id))
      .limit(500);
    output.push(
      ...rows.map((row) => ({
        ...row,
        telegramUserId: row.telegramUserId.toString(),
      })),
    );
    if (rows.length < 500) break;
    cursor = rows.at(-1)!.id;
  }
  return output;
}

function participantColumns(): Partial<ExcelJS.Column>[] {
  return [
    { header: 'ФИО', key: 'fullName', width: 30 },
    { header: 'Telegram username', key: 'username', width: 22 },
    { header: 'Telegram ID', key: 'telegramUserId', width: 18 },
    { header: 'Организация', key: 'organization', width: 28 },
    { header: 'Должность', key: 'position', width: 24 },
    { header: 'Контакт', key: 'phone', width: 20 },
    { header: 'Первое открытие', key: 'joinedAt', width: 22 },
    { header: 'Последняя активность', key: 'lastSeenAt', width: 22 },
    { header: 'Отправок', key: 'submissionCount', width: 12 },
    { header: 'Файлов', key: 'artifactCount', width: 12 },
    { header: 'Объём, байт', key: 'totalBytes', width: 16 },
  ];
}

function artifactColumns(): Partial<ExcelJS.Column>[] {
  return [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'Отправка', key: 'submissionId', width: 38 },
    { header: 'Автор', key: 'fullName', width: 30 },
    { header: 'Telegram ID', key: 'telegramUserId', width: 18 },
    { header: 'Название отправки', key: 'title', width: 30 },
    { header: 'Имя файла', key: 'originalName', width: 35 },
    { header: 'MIME-type', key: 'mimeType', width: 28 },
    { header: 'Размер, байт', key: 'sizeBytes', width: 16 },
    { header: 'Статус', key: 'status', width: 15 },
    { header: 'SHA-256', key: 'checksum', width: 66 },
    { header: 'Дата', key: 'createdAt', width: 22 },
    { header: 'Ссылка', key: 'link', width: 35 },
    { header: 'Текст', key: 'text', width: 50 },
  ];
}

async function writeParticipantsWorkbook(filePath: string, rows: ParticipantRow[]): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: false,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet('Участники');
  sheet.columns = participantColumns();
  for (const row of rows) sheet.addRow(row).commit();
  sheet.commit();
  await workbook.commit();
}

async function writeArtifactsWorkbook(filePath: string, rows: ArtifactRow[]): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: false,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet('Артефакты');
  sheet.columns = artifactColumns();
  for (const row of rows) sheet.addRow(row).commit();
  sheet.commit();
  await workbook.commit();
}

async function writeCombinedWorkbook(
  filePath: string,
  participantRows: ParticipantRow[],
  artifactRows: ArtifactRow[],
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: false,
    useSharedStrings: false,
  });
  const participantSheet = workbook.addWorksheet('Участники');
  participantSheet.columns = participantColumns();
  for (const row of participantRows) participantSheet.addRow(row).commit();
  participantSheet.commit();
  const artifactSheet = workbook.addWorksheet('Артефакты');
  artifactSheet.columns = artifactColumns();
  for (const row of artifactRows) artifactSheet.addRow(row).commit();
  artifactSheet.commit();
  await workbook.commit();
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeCsv(
  filePath: string,
  participantRows: ParticipantRow[],
  artifactRows: ArtifactRow[],
): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  stream.write('\uFEFF');
  stream.write(
    [
      'Тип записи',
      'ФИО',
      'Telegram ID',
      'Организация',
      'Должность',
      'Отправка',
      'Имя файла',
      'MIME-type',
      'Размер',
      'Статус',
      'SHA-256',
      'Дата',
    ]
      .map(csvCell)
      .join(',') + '\r\n',
  );
  for (const row of participantRows) {
    stream.write(
      [
        'участник',
        row.fullName,
        row.telegramUserId,
        row.organization,
        row.position,
        null,
        null,
        null,
        row.totalBytes,
        null,
        null,
        row.joinedAt,
      ]
        .map(csvCell)
        .join(',') + '\r\n',
    );
  }
  for (const row of artifactRows) {
    stream.write(
      [
        'артефакт',
        row.fullName,
        row.telegramUserId,
        null,
        null,
        row.submissionId,
        row.originalName,
        row.mimeType,
        row.sizeBytes,
        row.status,
        row.checksum,
        row.createdAt,
      ]
        .map(csvCell)
        .join(',') + '\r\n',
    );
  }
  stream.end();
  await once(stream, 'finish');
}

async function uploadFile(
  context: WorkerContext,
  sourcePath: string,
  objectKey: string,
  contentType: string,
): Promise<number> {
  const fileStat = await stat(sourcePath);
  const upload = new Upload({
    client: context.s3,
    params: {
      Bucket: context.config.S3_EXPORT_BUCKET,
      Key: objectKey,
      Body: createReadStream(sourcePath),
      ContentLength: fileStat.size,
      ContentType: contentType,
    },
    queueSize: 2,
    partSize: 10 * 1024 ** 2,
  });
  await upload.done();
  return fileStat.size;
}

async function appendReadable(
  archive: archiver.Archiver,
  stream: Readable,
  name: string,
): Promise<void> {
  const ended = Promise.race([
    once(stream, 'end'),
    once(stream, 'error').then(([error]) => Promise.reject(error as Error)),
  ]);
  archive.append(stream, { name });
  await ended;
}

async function buildZip(
  context: WorkerContext,
  input: {
    event: typeof events.$inferSelect;
    participantRows: ParticipantRow[];
    artifactRows: ArtifactRow[];
    submissionRows: SubmissionRow[];
    participantWorkbookPath: string;
    artifactWorkbookPath: string;
    objectKey: string;
    onProgress: (progress: number) => Promise<void>;
  },
): Promise<number> {
  const output = new PassThrough();
  let bytes = 0;
  output.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  const upload = new Upload({
    client: context.s3,
    params: {
      Bucket: context.config.S3_EXPORT_BUCKET,
      Key: input.objectKey,
      Body: output,
      ContentType: 'application/zip',
    },
    queueSize: 2,
    partSize: 10 * 1024 ** 2,
  });
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('warning', (error) => context.logger.warn({ error }, 'ZIP warning'));
  archive.pipe(output);

  const root = safeZipSegment(input.event.title);
  await appendReadable(
    archive,
    createReadStream(input.participantWorkbookPath),
    `${root}/Реестр_участников.xlsx`,
  );
  await appendReadable(
    archive,
    createReadStream(input.artifactWorkbookPath),
    `${root}/Реестр_артефактов.xlsx`,
  );

  const submissionDirectories = new Map<string, string>();
  for (const submission of input.submissionRows) {
    const person = safeZipSegment(
      `${submission.fullName ?? 'Без имени'}_${submission.telegramUserId}`,
      submission.telegramUserId,
    );
    const stamp = submission.createdAt.toISOString().replaceAll(':', '-');
    const directory = `${root}/Артефакты/${person}/submission_${stamp}_${submission.id.slice(0, 8)}`;
    submissionDirectories.set(submission.id, directory);
    if (submission.text) {
      archive.append(Buffer.from(submission.text, 'utf8'), {
        name: `${directory}/text.txt`,
      });
    }
    archive.append(
      Buffer.from(
        JSON.stringify(
          {
            submissionId: submission.id,
            title: submission.title,
            text: submission.text,
            link: submission.link,
            status: submission.status,
            userId: submission.userId,
            telegramUserId: submission.telegramUserId,
            createdAt: submission.createdAt.toISOString(),
          },
          null,
          2,
        ),
        'utf8',
      ),
      { name: `${directory}/metadata.json` },
    );
  }

  for (const [index, artifact] of input.artifactRows.entries()) {
    const submissionDirectory = submissionDirectories.get(artifact.submissionId);
    if (!submissionDirectory) {
      context.logger.warn(
        { artifactId: artifact.id, submissionId: artifact.submissionId },
        'Artifact has no exportable submission',
      );
      continue;
    }
    if (artifact.status === 'ready') {
      const object = await context.s3.send(
        new GetObjectCommand({ Bucket: artifact.bucket, Key: artifact.objectKey }),
      );
      if (object.Body && Symbol.asyncIterator in object.Body) {
        const readable = Readable.from(object.Body as AsyncIterable<Uint8Array>);
        await appendReadable(
          archive,
          readable,
          `${submissionDirectory}/${safeZipSegment(artifact.displayName, 'file')}`,
        );
      }
    }
    if (index % 10 === 0) {
      await input.onProgress(
        20 + Math.floor(((index + 1) / Math.max(input.artifactRows.length, 1)) * 70),
      );
    }
  }

  await archive.finalize();
  await upload.done();
  return bytes;
}

export async function buildExport(
  context: WorkerContext,
  exportJobId: string,
): Promise<void> {
  const [jobContext] = await context.db
    .select({ job: exportJobs, event: events })
    .from(exportJobs)
    .innerJoin(events, eq(events.id, exportJobs.eventId))
    .where(eq(exportJobs.id, exportJobId))
    .limit(1);
  if (!jobContext || jobContext.job.status === 'ready') return;

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), `cpi-export-${exportJobId}-`));
  const participantPath = path.join(temporaryDirectory, 'participants.xlsx');
  const artifactPath = path.join(temporaryDirectory, 'artifacts.xlsx');
  const outputPath = path.join(temporaryDirectory, `export.${jobContext.job.kind}`);
  const objectKey = `${jobContext.event.id}/${jobContext.job.id}.${jobContext.job.kind}`;
  const updateProgress = async (progress: number) => {
    await context.db
      .update(exportJobs)
      .set({ progress })
      .where(eq(exportJobs.id, exportJobId));
  };

  await context.db
    .update(exportJobs)
    .set({ status: 'processing', progress: 1, startedAt: new Date(), errorMessage: null })
    .where(eq(exportJobs.id, exportJobId));

  try {
    const [participantRows, artifactRows, submissionRows] = await Promise.all([
      loadParticipants(context, jobContext.event.id),
      loadArtifacts(context, jobContext.event.id),
      loadSubmissions(context, jobContext.event.id),
    ]);
    await updateProgress(10);

    let sizeBytes: number;
    if (jobContext.job.kind === 'csv') {
      await writeCsv(outputPath, participantRows, artifactRows);
      await updateProgress(80);
      sizeBytes = await uploadFile(context, outputPath, objectKey, 'text/csv; charset=utf-8');
    } else if (jobContext.job.kind === 'xlsx') {
      await writeCombinedWorkbook(outputPath, participantRows, artifactRows);
      await updateProgress(80);
      sizeBytes = await uploadFile(
        context,
        outputPath,
        objectKey,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    } else {
      await Promise.all([
        writeParticipantsWorkbook(participantPath, participantRows),
        writeArtifactsWorkbook(artifactPath, artifactRows),
      ]);
      await updateProgress(20);
      sizeBytes = await buildZip(context, {
        event: jobContext.event,
        participantRows,
        artifactRows,
        submissionRows,
        participantWorkbookPath: participantPath,
        artifactWorkbookPath: artifactPath,
        objectKey,
        onProgress: updateProgress,
      });
    }

    const expiresAt = new Date(
      Date.now() + context.config.EXPORT_RETENTION_HOURS * 60 * 60 * 1000,
    );
    await context.db
      .update(exportJobs)
      .set({
        status: 'ready',
        progress: 100,
        bucket: context.config.S3_EXPORT_BUCKET,
        objectKey,
        sizeBytes,
        completedAt: new Date(),
        expiresAt,
      })
      .where(eq(exportJobs.id, exportJobId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.db
      .update(exportJobs)
      .set({ status: 'failed', errorMessage: message.slice(0, 2_000) })
      .where(eq(exportJobs.id, exportJobId));
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
