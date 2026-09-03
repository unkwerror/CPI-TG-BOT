import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  type HeadObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { fileTypeFromBuffer } from 'file-type';
import * as yauzl from 'yauzl';
import type { CustomCardPackageFile } from '@cpi/db';
import { AppError } from '@cpi/shared';

export const CARD_PACKAGE_MAX_ZIP_BYTES = 30 * 1024 * 1024;
export const CARD_PACKAGE_MAX_UNCOMPRESSED_BYTES = 120 * 1024 * 1024;
export const CARD_PACKAGE_MAX_FILE_BYTES = 30 * 1024 * 1024;
export const CARD_PACKAGE_MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024;
export const CARD_PACKAGE_MAX_FILES = 200;
export const CARD_PACKAGE_UPLOAD_TTL_SECONDS = 300;

export type CardPackageEntityType = 'event' | 'product' | 'feed_post';

const contentTypesByExtension: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

const binaryMimeAliases: Record<string, string[]> = {
  'image/jpeg': ['image/jpeg'],
  'image/png': ['image/png'],
  'image/webp': ['image/webp'],
  'image/gif': ['image/gif'],
  'image/avif': ['image/avif'],
  'font/woff': ['font/woff', 'application/font-woff'],
  'font/woff2': ['font/woff2', 'application/font-woff'],
  'video/mp4': ['video/mp4'],
  'video/webm': ['video/webm'],
  'audio/mpeg': ['audio/mpeg'],
  'audio/ogg': ['audio/ogg'],
};

export interface ExtractedCardPackageFile {
  path: string;
  contentType: string;
  bytes: Buffer;
}

export interface ExtractedCardPackage {
  entryPath: string;
  entryHtml: string;
  files: ExtractedCardPackageFile[];
  totalUncompressedBytes: number;
}

export function normalizeCardPackagePath(value: string): string | null {
  if (
    !value ||
    value.length > 1_000 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[a-z]:/iu.test(value)
  ) {
    return null;
  }
  const withoutDot = value.replace(/^(?:\.\/)+/u, '');
  const sourceSegments = withoutDot.split('/');
  if (
    sourceSegments.some(
      (segment) => !segment || segment === '.' || segment === '..' || segment.length > 255,
    )
  ) {
    return null;
  }
  const normalized = posix.normalize(withoutDot);
  if (normalized === '.' || normalized.startsWith('../')) return null;
  return normalized.normalize('NFC');
}

export function cardPackageObjectPrefix(
  storagePrefix: string,
  entityType: CardPackageEntityType,
  entityId: string,
  packageId: string,
): string {
  return `${storagePrefix}card-packages/${entityType}/${entityId}/${packageId}/`;
}

export function cardPackageSourceObjectKey(
  storagePrefix: string,
  entityType: CardPackageEntityType,
  entityId: string,
  packageId: string,
): string {
  return `${cardPackageObjectPrefix(storagePrefix, entityType, entityId, packageId)}source.zip`;
}

export function cardPackageUploadMetadata(input: {
  packageId: string;
  entityType: CardPackageEntityType;
  entityId: string;
  sizeBytes: number;
}): Record<string, string> {
  return {
    'package-id': input.packageId,
    'entity-type': input.entityType,
    'entity-id': input.entityId,
    'expected-size': String(input.sizeBytes),
  };
}

export function cardPackagePutHeaders(input: {
  packageId: string;
  entityType: CardPackageEntityType;
  entityId: string;
  sizeBytes: number;
}): Record<string, string> {
  const metadata = cardPackageUploadMetadata(input);
  return {
    'content-type': 'application/zip',
    'x-amz-meta-package-id': metadata['package-id']!,
    'x-amz-meta-entity-type': metadata['entity-type']!,
    'x-amz-meta-entity-id': metadata['entity-id']!,
    'x-amz-meta-expected-size': metadata['expected-size']!,
  };
}

function normalizedMetadataValue(value: string | undefined): string {
  if (!value) return '';
  const values = value.split(',').map((item) => item.trim());
  return values.every((item) => item === values[0]) ? (values[0] ?? '') : value;
}

export function assertCardPackageHead(
  input: {
    packageId: string;
    entityType: CardPackageEntityType;
    entityId: string;
    sizeBytes: number;
  },
  head: HeadObjectCommandOutput,
): void {
  const metadata = head.Metadata ?? {};
  const contentType = head.ContentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    head.ContentLength !== input.sizeBytes ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > CARD_PACKAGE_MAX_ZIP_BYTES ||
    !['application/zip', 'application/x-zip-compressed'].includes(contentType ?? '') ||
    normalizedMetadataValue(metadata['package-id']) !== input.packageId ||
    normalizedMetadataValue(metadata['entity-type']) !== input.entityType ||
    normalizedMetadataValue(metadata['entity-id']) !== input.entityId ||
    normalizedMetadataValue(metadata['expected-size']) !== String(input.sizeBytes)
  ) {
    throw new AppError(
      'CARD_PACKAGE_OBJECT_MISMATCH',
      'Загруженный ZIP не соответствует выданному разрешению',
      409,
    );
  }
}

async function responseBytes(body: unknown): Promise<Uint8Array> {
  if (!body || typeof body !== 'object') {
    throw new AppError('CARD_PACKAGE_EMPTY', 'ZIP-пакет в хранилище пуст', 409);
  }
  const runtimeBody = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  };
  if (runtimeBody.transformToByteArray) return runtimeBody.transformToByteArray();
  if (runtimeBody[Symbol.asyncIterator]) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > CARD_PACKAGE_MAX_ZIP_BYTES) {
        throw new AppError('CARD_PACKAGE_TOO_LARGE', 'ZIP-пакет превышает 30 МБ', 413);
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  throw new AppError('CARD_PACKAGE_UNREADABLE', 'Не удалось прочитать ZIP-пакет из Beget S3', 409);
}

export async function downloadCardPackageZip(
  s3: S3Client,
  bucket: string,
  objectKey: string,
): Promise<Buffer> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  const bytes = Buffer.from(await responseBytes(object.Body));
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    !(
      (bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08)
    )
  ) {
    throw new AppError(
      'CARD_PACKAGE_SIGNATURE_INVALID',
      'Выбранный файл не является ZIP-архивом',
      409,
    );
  }
  return bytes;
}

function zipFromBuffer(bytes: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, decodeStrings: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error('ZIP open failed'));
        else resolve(zip);
      },
    );
  });
}

function readZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('ZIP entry stream missing'));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > CARD_PACKAGE_MAX_FILE_BYTES) {
          stream.destroy(new Error('ZIP entry exceeds the file limit'));
          return;
        }
        chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks, total)));
    });
  });
}

function extensionForPath(path: string): string {
  return posix.extname(path).toLowerCase();
}

async function assertBinarySignature(file: ExtractedCardPackageFile): Promise<void> {
  const accepted = binaryMimeAliases[file.contentType];
  if (!accepted) return;
  const detected = await fileTypeFromBuffer(file.bytes);
  if (!detected || !accepted.includes(detected.mime)) {
    throw new AppError(
      'CARD_PACKAGE_FILE_SIGNATURE_INVALID',
      `Файл «${file.path}» не соответствует своему расширению`,
      409,
    );
  }
}

function decodeCardPackageText(file: ExtractedCardPackageFile, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw new AppError('CARD_PACKAGE_TEXT_ENCODING', `${label} должен быть сохранён в UTF-8`, 409);
  }
}

function manifestStringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function resolveManifestFile(
  files: readonly ExtractedCardPackageFile[],
  manifestPath: string,
  rawPath: string,
  kind: 'entry' | 'style' | 'script',
): ExtractedCardPackageFile {
  if (
    !rawPath.trim() ||
    rawPath.includes('\\') ||
    rawPath.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/iu.test(rawPath)
  ) {
    throw new AppError(
      'CARD_PACKAGE_MANIFEST_PATH_INVALID',
      `Некорректный путь ${kind} в manifest.json: ${rawPath}`,
      409,
    );
  }
  const resolved = normalizeCardPackagePath(posix.join(posix.dirname(manifestPath), rawPath));
  const file = resolved
    ? files.find(
        (item) => item.path.toLocaleLowerCase('en-US') === resolved.toLocaleLowerCase('en-US'),
      )
    : undefined;
  if (!file) {
    throw new AppError(
      'CARD_PACKAGE_MANIFEST_FILE_MISSING',
      `Файл «${rawPath}» из manifest.json не найден в ZIP`,
      409,
    );
  }
  const extension = extensionForPath(file.path);
  const expected =
    kind === 'entry' ? ['.html', '.htm'] : kind === 'style' ? ['.css'] : ['.js', '.mjs'];
  if (!expected.includes(extension)) {
    throw new AppError(
      'CARD_PACKAGE_MANIFEST_FILE_TYPE',
      `Файл «${rawPath}» имеет неподходящий тип для ${kind}`,
      409,
    );
  }
  return file;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function relativeResourcePath(entryPath: string, resourcePath: string): string {
  const relative = posix.relative(posix.dirname(entryPath), resourcePath);
  return relative || posix.basename(resourcePath);
}

function addManifestResources(
  entryPath: string,
  entryHtml: string,
  styles: readonly ExtractedCardPackageFile[],
  scripts: readonly ExtractedCardPackageFile[],
): string {
  const styleTags = styles
    .map(
      (file) =>
        `<link rel="stylesheet" href="${escapeHtmlAttribute(relativeResourcePath(entryPath, file.path))}">`,
    )
    .join('');
  const scriptTags = scripts
    .map((file) => {
      const type = extensionForPath(file.path) === '.mjs' ? ' type="module"' : '';
      return `<script${type} src="${escapeHtmlAttribute(relativeResourcePath(entryPath, file.path))}"></script>`;
    })
    .join('');
  if (!/<html(?:\s[^>]*)?>/iu.test(entryHtml)) {
    return `<!doctype html><html><head>${styleTags}</head><body>${entryHtml}${scriptTags}</body></html>`;
  }
  let document = entryHtml;
  if (styleTags) {
    document = /<head(?:\s[^>]*)?>/iu.test(document)
      ? document.replace(/<head(\s[^>]*)?>/iu, (opening) => `${opening}${styleTags}`)
      : document.replace(/<html(\s[^>]*)?>/iu, (opening) => `${opening}<head>${styleTags}</head>`);
  }
  if (scriptTags) {
    document = /<\/body>/iu.test(document)
      ? document.replace(/<\/body>/iu, `${scriptTags}</body>`)
      : `${document}${scriptTags}`;
  }
  return document;
}

function entryFromManifest(
  files: readonly ExtractedCardPackageFile[],
): { entryPath: string; entryHtml: string } | null {
  const manifest = files
    .filter((file) => posix.basename(file.path).toLowerCase() === 'manifest.json')
    .sort((left, right) => {
      const depth = left.path.split('/').length - right.path.split('/').length;
      return depth || left.path.localeCompare(right.path);
    })[0];
  if (!manifest) return null;
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(decodeCardPackageText(manifest, 'manifest.json'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('manifest root is not an object');
    }
    parsed = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'CARD_PACKAGE_MANIFEST_INVALID',
      'manifest.json содержит некорректный JSON',
      409,
    );
  }
  const rawEntry =
    typeof parsed.entry === 'string'
      ? parsed.entry
      : typeof parsed.html === 'string'
        ? parsed.html
        : null;
  if (!rawEntry) {
    throw new AppError(
      'CARD_PACKAGE_MANIFEST_ENTRY_MISSING',
      'В manifest.json нужно указать поле entry с HTML-файлом',
      409,
    );
  }
  const entry = resolveManifestFile(files, manifest.path, rawEntry, 'entry');
  const styles = [...manifestStringList(parsed.style), ...manifestStringList(parsed.styles)].map(
    (path) => resolveManifestFile(files, manifest.path, path, 'style'),
  );
  const scripts = [...manifestStringList(parsed.script), ...manifestStringList(parsed.scripts)].map(
    (path) => resolveManifestFile(files, manifest.path, path, 'script'),
  );
  const entrySource = decodeCardPackageText(entry, `HTML-файл «${entry.path}»`);
  return {
    entryPath: entry.path,
    entryHtml: addManifestResources(entry.path, entrySource, styles, scripts),
  };
}

export async function extractCardPackage(archiveBytes: Buffer): Promise<ExtractedCardPackage> {
  const zip = await zipFromBuffer(archiveBytes).catch(() => {
    throw new AppError(
      'CARD_PACKAGE_INVALID',
      'ZIP повреждён или использует неподдерживаемый формат',
      409,
    );
  });
  const files: ExtractedCardPackageFile[] = [];
  const paths = new Set<string>();
  let entryCount = 0;
  let totalUncompressedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zip.once('error', fail);
    zip.once('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        entryCount += 1;
        if (entryCount > CARD_PACKAGE_MAX_FILES) {
          throw new AppError(
            'CARD_PACKAGE_FILE_LIMIT',
            `В ZIP должно быть не больше ${CARD_PACKAGE_MAX_FILES} файлов`,
            409,
          );
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
          throw new AppError('CARD_PACKAGE_ENCRYPTED', 'ZIP с паролем не поддерживается', 409);
        }
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        const unixMode = entry.externalFileAttributes >>> 16;
        if ((unixMode & 0o170000) === 0o120000) {
          throw new AppError(
            'CARD_PACKAGE_SYMLINK_FORBIDDEN',
            'Символические ссылки в ZIP не поддерживаются',
            409,
          );
        }
        const path = normalizeCardPackagePath(entry.fileName);
        if (!path) {
          throw new AppError(
            'CARD_PACKAGE_PATH_INVALID',
            `Недопустимый путь внутри ZIP: ${entry.fileName}`,
            409,
          );
        }
        if (path.startsWith('__MACOSX/') || path.endsWith('/.DS_Store')) {
          zip.readEntry();
          return;
        }
        if (paths.has(path.toLocaleLowerCase('en-US'))) {
          throw new AppError(
            'CARD_PACKAGE_DUPLICATE_PATH',
            `Путь «${path}» повторяется в ZIP`,
            409,
          );
        }
        paths.add(path.toLocaleLowerCase('en-US'));
        totalUncompressedBytes += entry.uncompressedSize;
        if (
          entry.uncompressedSize > CARD_PACKAGE_MAX_FILE_BYTES ||
          totalUncompressedBytes > CARD_PACKAGE_MAX_UNCOMPRESSED_BYTES
        ) {
          throw new AppError(
            'CARD_PACKAGE_UNPACKED_TOO_LARGE',
            'Распакованный ZIP превышает безопасный лимит 120 МБ',
            413,
          );
        }
        const extension = extensionForPath(path);
        const contentType = contentTypesByExtension[extension];
        if (!contentType) {
          zip.readEntry();
          return;
        }
        if (
          ['.html', '.htm', '.css', '.js', '.mjs', '.json', '.map', '.svg'].includes(extension) &&
          entry.uncompressedSize > CARD_PACKAGE_MAX_TEXT_FILE_BYTES
        ) {
          throw new AppError(
            'CARD_PACKAGE_TEXT_FILE_TOO_LARGE',
            `Текстовый файл «${path}» превышает 5 МБ`,
            413,
          );
        }
        const bytes = await readZipEntry(zip, entry);
        const file = { path, contentType, bytes };
        await assertBinarySignature(file);
        files.push(file);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });

  const entryCandidates = files
    .filter((file) => posix.basename(file.path).toLowerCase() === 'index.html')
    .sort((left, right) => {
      const depth = left.path.split('/').length - right.path.split('/').length;
      return depth || left.path.localeCompare(right.path);
    });
  const entry = entryCandidates[0];
  const manifestEntry = entry ? null : entryFromManifest(files);
  const fallbackEntry = entry
    ? null
    : manifestEntry
      ? null
      : files
          .filter((file) => ['.html', '.htm'].includes(extensionForPath(file.path)))
          .sort((left, right) => {
            const previewDifference =
              Number(posix.basename(right.path).toLowerCase() === 'preview.html') -
              Number(posix.basename(left.path).toLowerCase() === 'preview.html');
            const depth = left.path.split('/').length - right.path.split('/').length;
            return previewDifference || depth || left.path.localeCompare(right.path);
          })[0];
  if (!entry && !manifestEntry && !fallbackEntry) {
    throw new AppError(
      'CARD_PACKAGE_ENTRY_MISSING',
      'В ZIP нужен index.html, manifest.json с полем entry или другой HTML-файл',
      409,
    );
  }
  const entryPath = entry?.path ?? manifestEntry?.entryPath ?? fallbackEntry!.path;
  const entryHtml =
    manifestEntry?.entryHtml ??
    decodeCardPackageText(entry ?? fallbackEntry!, `HTML-файл «${entryPath}»`);
  if (!entryHtml.trim()) {
    throw new AppError('CARD_PACKAGE_INDEX_EMPTY', 'Входной HTML-файл в ZIP пуст', 409);
  }
  return { entryPath, entryHtml, files, totalUncompressedBytes };
}

function objectExtension(path: string): string {
  const extension = extensionForPath(path).replace(/[^a-z0-9.]/giu, '');
  return extension || '.bin';
}

export async function uploadCardPackageFiles(input: {
  s3: S3Client;
  bucket: string;
  objectPrefix: string;
  packageId: string;
  files: ExtractedCardPackageFile[];
}): Promise<CustomCardPackageFile[]> {
  const stored: CustomCardPackageFile[] = [];
  for (let index = 0; index < input.files.length; index += 4) {
    const batch = input.files.slice(index, index + 4);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const id = crypto.randomUUID();
        const objectKey = `${input.objectPrefix}files/${id}${objectExtension(file.path)}`;
        await input.s3.send(
          new PutObjectCommand({
            Bucket: input.bucket,
            Key: objectKey,
            Body: file.bytes,
            ContentType: file.contentType,
            CacheControl: 'public, max-age=31536000, immutable',
            Metadata: { 'package-id': input.packageId },
          }),
        );
        return {
          id,
          path: file.path,
          objectKey,
          contentType: file.contentType,
          sizeBytes: file.bytes.length,
        } satisfies CustomCardPackageFile;
      }),
    );
    const uploaded: CustomCardPackageFile[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') uploaded.push(result.value);
    }
    stored.push(...uploaded);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) {
      await deleteCardPackageObjects(
        input.s3,
        input.bucket,
        stored.map((file) => file.objectKey),
      ).catch(() => undefined);
      throw failed.reason;
    }
  }
  return stored;
}

export async function deleteCardPackageObjects(
  s3: S3Client,
  bucket: string,
  objectKeys: string[],
): Promise<void> {
  const unique = [...new Set(objectKeys)].filter(Boolean);
  for (let index = 0; index < unique.length; index += 1_000) {
    const batch = unique.slice(index, index + 1_000);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Quiet: true,
          Objects: batch.map((Key) => ({ Key })),
        },
      }),
    );
  }
}

export async function getCardPackageFile(
  s3: S3Client,
  bucket: string,
  file: Pick<CustomCardPackageFile, 'objectKey'>,
  range?: string,
) {
  return s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: file.objectKey,
      ...(range ? { Range: range } : {}),
    }),
  );
}

export function isNodeReadable(value: unknown): value is Readable {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'pipe' in value &&
    typeof (value as { pipe?: unknown }).pipe === 'function',
  );
}

export function cardPackageBasePath(packageId: string, entryPath: string): string {
  const directory = posix.dirname(entryPath);
  const encodedDirectory =
    directory === '.'
      ? ''
      : `${directory
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')}/`;
  return `/api/v1/card-packages/${encodeURIComponent(packageId)}/files/${encodedDirectory}`;
}

function encodedPackageFileUrl(packageId: string, path: string): string {
  return `/api/v1/card-packages/${encodeURIComponent(packageId)}/files/${path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

export function rewriteCardPackageAssetReferences(
  value: string,
  packageId: string,
  availablePaths: readonly string[],
): string {
  const byLowerPath = new Map(
    availablePaths.map((path) => [path.toLocaleLowerCase('en-US'), path]),
  );
  const resolve = (rawPath: string): string | null => {
    const [path, suffix = ''] = rawPath.split(/(?=[?#])/u, 2);
    const normalized = normalizeCardPackagePath(path ?? '');
    if (!normalized) return null;
    const stored = byLowerPath.get(normalized.toLocaleLowerCase('en-US'));
    return stored ? `${encodedPackageFileUrl(packageId, stored)}${suffix}` : null;
  };
  const quoted = value.replace(/(["'])\/([^"']+)\1/gu, (match, quote: string, rawPath: string) => {
    const replacement = resolve(rawPath);
    return replacement ? `${quote}${replacement}${quote}` : match;
  });
  return quoted.replace(/url\(\s*\/([^)'"\s]+)\s*\)/giu, (match, rawPath: string) => {
    const replacement = resolve(rawPath);
    return replacement ? `url("${replacement}")` : match;
  });
}

export function renderCardPackageDocument(
  packageId: string,
  entryPath: string,
  html: string,
  availablePaths: readonly string[] = [],
): string {
  const host = `<script>if(new URLSearchParams(location.search).get("display")==="fullscreen")document.documentElement.dataset.cpiDisplay="fullscreen"</script><style>html,body{max-width:100%;min-width:0;margin:0;overflow-x:hidden;overscroll-behavior-y:contain}html{height:auto;-webkit-text-size-adjust:100%;touch-action:pan-y pinch-zoom}body{min-height:100%;-webkit-overflow-scrolling:touch;touch-action:pan-y pinch-zoom}html[data-cpi-display="fullscreen"],html[data-cpi-display="fullscreen"] body{min-height:100%;background:#101112}html[data-cpi-display="fullscreen"] body>:first-child{width:100%!important;max-width:none!important;min-height:100vh!important;min-height:100dvh!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important}</style>`;
  const head = `<meta charset="utf-8"><base href="${cardPackageBasePath(packageId, entryPath)}"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${host}`;
  const fullscreenBridge = `<script>(()=>{if(document.documentElement.dataset.cpiDisplay!=="fullscreen")return;const root=Array.from(document.body.children).find(node=>!["SCRIPT","STYLE","LINK"].includes(node.tagName));if(!root)return;root.setAttribute("data-cpi-fields","");for(const [property,value] of Object.entries({width:"100%","max-width":"none","min-height":"100dvh",margin:"0",border:"0","border-radius":"0","box-shadow":"none"}))root.style.setProperty(property,value,"important")})()</script>`;
  const boundaryScrollBridge = `<script>(()=>{const packageId=${JSON.stringify(packageId)};let touchY=null;const height=()=>Math.max(document.documentElement.scrollHeight,document.documentElement.offsetHeight,document.body?document.body.scrollHeight:0,document.body?document.body.offsetHeight:0);const top=()=>window.scrollY||document.documentElement.scrollTop||(document.body?document.body.scrollTop:0);const relay=value=>{const deltaY=Number(value);if(!Number.isFinite(deltaY)||Math.abs(deltaY)<.5)return;const maxScroll=Math.max(0,height()-window.innerHeight);const scrollTop=top();const atBoundary=deltaY>0?scrollTop>=maxScroll-2:scrollTop<=2;if(maxScroll>2&&!atBoundary)return;parent.postMessage({type:"cpi-card-scroll",packageId,deltaY:Math.max(-240,Math.min(240,deltaY))},"*")};addEventListener("wheel",event=>{event.stopImmediatePropagation();relay(event.deltaY)},{capture:true,passive:true});addEventListener("touchstart",event=>{event.stopImmediatePropagation();const touch=event.touches&&event.touches[0];touchY=touch?touch.clientY:null},{capture:true,passive:true});addEventListener("touchmove",event=>{event.stopImmediatePropagation();const touch=event.touches&&event.touches[0];const nextY=touch?touch.clientY:null;if(touchY!=null&&nextY!=null)relay(touchY-nextY);touchY=nextY},{capture:true,passive:true});const end=event=>{event.stopImmediatePropagation();touchY=null};addEventListener("touchend",end,{capture:true,passive:true});addEventListener("touchcancel",end,{capture:true,passive:true})})()</script>`;
  const bridge = `<script>(()=>{const packageId=${JSON.stringify(packageId)};const post=payload=>parent.postMessage({packageId,...payload},"*");const clean=value=>String(value==null?"":value).replace(/\\s+/g," ").trim().slice(0,300);const add=(fields,key,value)=>{key=clean(key).slice(0,80);value=clean(value);if(!key||!value||(!(key in fields)&&Object.keys(fields).length>=20))return;fields[key]=value};const ignored=key=>/(?:action|image|img|src|url|token|initialized|productid|packageid|cpifield|cpivalue|cpifields)/i.test(key);const collect=()=>{const fields={};document.querySelectorAll("input[name],select[name],textarea[name]").forEach(field=>{if(field.disabled||((field.type==="checkbox"||field.type==="radio")&&!field.checked))return;const value=field instanceof HTMLSelectElement&&field.multiple?Array.from(field.selectedOptions).map(option=>option.value).join(", "):field.value;add(fields,field.dataset.cpiLabel||field.getAttribute("aria-label")||field.name,value)});document.querySelectorAll("[data-cpi-field]").forEach(field=>add(fields,field.dataset.cpiField,field.dataset.cpiValue!=null?field.dataset.cpiValue:("value" in field?field.value:field.textContent)));const roots=new Set([document.documentElement,document.body]);document.querySelectorAll("[data-cpi-fields],[data-product-id],[data-catalyst-card]").forEach(root=>roots.add(root));roots.forEach(root=>Object.entries(root&&root.dataset?root.dataset:{}).forEach(([key,value])=>{if(!ignored(key))add(fields,key,value)}));return fields};const send=()=>{const body=document.body;post({type:"cpi-card-height",height:Math.ceil(Math.max(document.documentElement.scrollHeight,document.documentElement.offsetHeight,body?body.scrollHeight:0,body?body.offsetHeight:0))})};const sendFields=()=>post({type:"cpi-card-fields",fields:collect()});const relayScroll=value=>{const deltaY=Number(value);if(!Number.isFinite(deltaY)||Math.abs(deltaY)<.5)return;post({type:"cpi-card-scroll",deltaY:Math.max(-240,Math.min(240,deltaY))})};let touchY=null;const defer=window.queueMicrotask?window.queueMicrotask.bind(window):callback=>Promise.resolve().then(callback);const actionTarget=origin=>{let node=origin instanceof Element?origin:null;while(node){if(node.matches('[data-cpi-action],a[href="#"]')||Array.from(node.attributes).some(attribute=>/^data-(?:[\\w-]+-)?action$/i.test(attribute.name)))return node;node=node.parentElement}return null};addEventListener("click",event=>{const target=actionTarget(event.target);defer(sendFields);if(!target)return;event.preventDefault();post({type:"cpi-card-action",fields:collect()})});addEventListener("input",sendFields);addEventListener("change",sendFields);addEventListener("wheel",event=>relayScroll(event.deltaY),{passive:true});addEventListener("touchstart",event=>{const touch=event.touches&&event.touches[0];touchY=touch?touch.clientY:null},{passive:true});addEventListener("touchmove",event=>{const touch=event.touches&&event.touches[0];const nextY=touch?touch.clientY:null;if(touchY!=null&&nextY!=null)relayScroll(touchY-nextY);touchY=nextY},{passive:true});addEventListener("touchend",()=>{touchY=null},{passive:true});addEventListener("touchcancel",()=>{touchY=null},{passive:true});addEventListener("resize",send);addEventListener("orientationchange",send);addEventListener("load",()=>{send();sendFields()});if(typeof ResizeObserver==="function"){const observer=new ResizeObserver(send);observer.observe(document.documentElement);if(document.body){observer.observe(document.body);Array.from(document.body.children).forEach(node=>observer.observe(node))}}if(document.fonts&&document.fonts.ready)document.fonts.ready.then(send);document.querySelectorAll("img,video").forEach(media=>media.addEventListener("load",send,{once:true}));setTimeout(send,250);setTimeout(sendFields,250);setTimeout(send,1000);setTimeout(send,2000)})()</script>`;
  const linkBridge = `<script>(()=>{const packageId=${JSON.stringify(packageId)};addEventListener("click",event=>{if(event.defaultPrevented)return;const anchor=event.target instanceof Element?event.target.closest("a[href]"):null;if(!anchor)return;const attribute=anchor.getAttribute("href");const raw=attribute?attribute.trim():"";if(!raw||raw.startsWith("#"))return;let href;try{href=new URL(raw,document.baseURI).href}catch{return}if(!/^(?:https?|tg):/i.test(href))return;event.preventDefault();parent.postMessage({type:"cpi-card-link",packageId,href},"*")})})()</script>`;
  const rewritten = rewriteCardPackageAssetReferences(html, packageId, availablePaths);
  const withBridge = /<\/body>/iu.test(rewritten)
    ? rewritten.replace(
        /<\/body>/iu,
        `${fullscreenBridge}${boundaryScrollBridge}${bridge}${linkBridge}</body>`,
      )
    : `${rewritten}${fullscreenBridge}${boundaryScrollBridge}${bridge}${linkBridge}`;
  if (/<head(?:\s[^>]*)?>/iu.test(withBridge)) {
    return withBridge.replace(/<head(\s[^>]*)?>/iu, (opening) => `${opening}${head}`);
  }
  if (/<html(?:\s[^>]*)?>/iu.test(withBridge)) {
    return withBridge.replace(/<html(\s[^>]*)?>/iu, (opening) => `${opening}<head>${head}</head>`);
  }
  return `<!doctype html><html><head>${head}</head><body>${withBridge}</body></html>`;
}

export const CARD_PACKAGE_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');
