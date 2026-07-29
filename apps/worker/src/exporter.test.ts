import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerContext } from './context';

const uploadState = vi.hoisted(() => ({ bytes: new Uint8Array() }));

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    private readonly body: AsyncIterable<Uint8Array>;

    constructor(options: { params: { Body: AsyncIterable<Uint8Array> } }) {
      this.body = options.params.Body;
    }

    async done() {
      const chunks: Buffer[] = [];
      for await (const chunk of this.body) chunks.push(Buffer.from(chunk));
      uploadState.bytes = Buffer.concat(chunks);
      return {};
    }
  },
}));

import { buildZip } from './exporter';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  uploadState.bytes = new Uint8Array();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ZIP export streaming', () => {
  it('starts consuming the stream before finalizing and verifies the stored size', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cpi-export-test-'));
    temporaryDirectories.push(directory);
    const participants = path.join(directory, 'participants.xlsx');
    const artifacts = path.join(directory, 'artifacts.xlsx');
    await Promise.all([
      writeFile(participants, 'participants workbook'),
      writeFile(artifacts, 'artifacts workbook'),
    ]);

    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: uploadState.bytes.byteLength };
      }
      throw new Error('Unexpected S3 command');
    });
    const context = {
      config: { S3_EXPORT_BUCKET: 'exports' },
      s3: { send },
      logger: { warn: vi.fn() },
    } as unknown as WorkerContext;

    const size = await buildZip(context, {
      event: { title: 'Тестовое мероприятие' } as never,
      participantRows: [],
      artifactRows: [],
      submissionRows: [],
      participantWorkbookPath: participants,
      artifactWorkbookPath: artifacts,
      objectKey: 'event/export.zip',
      onProgress: vi.fn(async () => {}),
    });

    expect(size).toBeGreaterThan(0);
    expect(size).toBe(uploadState.bytes.byteLength);
    expect(Array.from(uploadState.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(Buffer.from(uploadState.bytes).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(
      true,
    );
  });
});
