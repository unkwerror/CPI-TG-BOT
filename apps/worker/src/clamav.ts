import net from 'node:net';
import type { Hash } from 'node:crypto';
import { once } from 'node:events';

export interface ScanResult {
  clean: boolean;
  response: string;
}

export async function hashAndOptionallyScan(
  body: AsyncIterable<Uint8Array>,
  hash: Hash,
  clamav?: { host: string; port: number; timeoutMs?: number },
): Promise<ScanResult> {
  let socket: net.Socket | undefined;
  const responseChunks: Buffer[] = [];
  if (clamav) {
    socket = net.createConnection({ host: clamav.host, port: clamav.port });
    socket.setTimeout(clamav.timeoutMs ?? 120_000);
    socket.on('data', (chunk: Buffer) => responseChunks.push(chunk));
    await once(socket, 'connect');
    socket.write(Buffer.from('zINSTREAM\0'));
  }

  try {
    for await (const rawChunk of body) {
      const chunk = Buffer.from(rawChunk);
      hash.update(chunk);
      if (socket) {
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length, 0);
        if (!socket.write(length)) await once(socket, 'drain');
        if (!socket.write(chunk)) await once(socket, 'drain');
      }
    }
    if (!socket) return { clean: true, response: 'metadata-only' };

    socket.write(Buffer.alloc(4));
    socket.end();
    await Promise.race([
      once(socket, 'close'),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('ClamAV scan response timeout')), clamav?.timeoutMs ?? 120_000),
      ),
    ]);
    const response = Buffer.concat(responseChunks).toString('utf8').replace(/\0/g, '').trim();
    if (!response) throw new Error('ClamAV returned an empty response');
    return { clean: response.endsWith('OK'), response };
  } finally {
    socket?.destroy();
  }
}
