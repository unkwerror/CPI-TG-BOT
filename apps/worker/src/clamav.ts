import net from 'node:net';
import type { Hash } from 'node:crypto';
import { once } from 'node:events';

export interface ScanResult {
  clean: boolean;
  response: string;
  fileHead: Uint8Array;
}

export async function assertClamavReady(clamav: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = clamav.timeoutMs ?? 5_000;
  const socket = net.createConnection({ host: clamav.host, port: clamav.port });
  try {
    await waitForSocketEvent(socket, 'connect', timeoutMs, 'ClamAV readiness connection timeout');
    socket.write(Buffer.from('zPING\0'));
    let timeout: NodeJS.Timeout | undefined;
    try {
      const [chunk] = await Promise.race([
        once(socket, 'data') as Promise<[Buffer]>,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('ClamAV readiness response timeout');
            socket.destroy(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
      const response = chunk.toString('utf8').replace(/\0/gu, '').trim();
      if (response !== 'PONG') throw new Error(`ClamAV readiness failed: ${response || 'empty'}`);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    socket.destroy();
  }
}

async function waitForSocketEvent(
  socket: net.Socket,
  event: 'connect' | 'close',
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(socket, event),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(timeoutMessage);
          socket.destroy(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function throwIfSocketFailed(error: Error | undefined): void {
  if (error) throw error;
}

export async function hashAndOptionallyScan(
  body: AsyncIterable<Uint8Array>,
  hash: Hash,
  clamav?: { host: string; port: number; timeoutMs?: number },
): Promise<ScanResult> {
  let socket: net.Socket | undefined;
  const responseChunks: Buffer[] = [];
  const headChunks: Buffer[] = [];
  let headLength = 0;
  let socketError: Error | undefined;
  if (clamav) {
    const timeoutMs = clamav.timeoutMs ?? 120_000;
    socket = net.createConnection({ host: clamav.host, port: clamav.port });
    socket.setTimeout(timeoutMs, () => {
      socket?.destroy(new Error('ClamAV socket timeout'));
    });
    socket.on('data', (chunk: Buffer) => responseChunks.push(chunk));
    socket.on('error', (error) => {
      socketError ??= error;
    });
    await waitForSocketEvent(socket, 'connect', timeoutMs, 'ClamAV connection timeout');
    socket.write(Buffer.from('zINSTREAM\0'));
  }

  try {
    for await (const rawChunk of body) {
      const chunk = Buffer.from(rawChunk);
      if (headLength < 8_192) {
        const slice = chunk.subarray(0, Math.min(chunk.length, 8_192 - headLength));
        headChunks.push(slice);
        headLength += slice.length;
      }
      hash.update(chunk);
      if (socket) {
        throwIfSocketFailed(socketError);
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length, 0);
        if (!socket.write(length)) await once(socket, 'drain');
        if (!socket.write(chunk)) await once(socket, 'drain');
      }
    }
    if (!socket) {
      return {
        clean: true,
        response: 'metadata-only',
        fileHead: Buffer.concat(headChunks, headLength),
      };
    }

    throwIfSocketFailed(socketError);
    socket.write(Buffer.alloc(4));
    socket.end();
    await waitForSocketEvent(
      socket,
      'close',
      clamav?.timeoutMs ?? 120_000,
      'ClamAV scan response timeout',
    );
    throwIfSocketFailed(socketError);
    const response = Buffer.concat(responseChunks).toString('utf8').replace(/\0/g, '').trim();
    if (!response) throw new Error('ClamAV returned an empty response');
    return {
      clean: response.endsWith('OK'),
      response,
      fileHead: Buffer.concat(headChunks, headLength),
    };
  } finally {
    socket?.destroy();
  }
}
