import { fileTypeFromBuffer } from 'file-type';

const MIME_ALIAS_GROUPS = [
  new Set(['image/jpeg', 'image/jpg']),
  new Set(['audio/mpeg', 'audio/mp3']),
  new Set(['application/zip', 'application/x-zip-compressed']),
  new Set(['application/gzip', 'application/x-gzip']),
  new Set(['application/x-rar-compressed', 'application/vnd.rar']),
];
const GENERIC_MIME_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);
const ZIP_CONTAINER_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub']);
const EXECUTABLE_SIGNATURE_EXTENSIONS = new Set([
  'exe',
  'elf',
  'class',
  'wasm',
  'swf',
  'deb',
  'rpm',
]);

function normalizedMime(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

export function fileSignatureMatches(
  declaredMimeType: string,
  declaredExtension: string,
  detected: { mime: string; ext: string },
): boolean {
  const declared = normalizedMime(declaredMimeType);
  const detectedMime = normalizedMime(detected.mime);
  const detectedExtension = detected.ext.toLowerCase();
  if (EXECUTABLE_SIGNATURE_EXTENSIONS.has(detectedExtension)) return false;
  if (GENERIC_MIME_TYPES.has(declared)) return true;
  if (declared === detectedMime) return true;
  if (MIME_ALIAS_GROUPS.some((group) => group.has(declared) && group.has(detectedMime))) {
    return true;
  }
  // Office/OpenDocument/EPUB files are ZIP containers. Some short samples can only be
  // identified as ZIP, while longer samples are identified by their exact document MIME.
  return (
    detectedMime === 'application/zip' &&
    ZIP_CONTAINER_EXTENSIONS.has(declaredExtension.toLowerCase())
  );
}

export async function inspectFileSignature(
  bytes: Uint8Array,
  declaredMimeType: string,
  declaredExtension: string,
): Promise<{ detected: { mime: string; ext: string } | null; matches: boolean }> {
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected) return { detected: null, matches: true };
  return {
    detected,
    matches: fileSignatureMatches(declaredMimeType, declaredExtension, detected),
  };
}
