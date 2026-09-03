/* global process */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function generate(target, endpoint, upstream = 'must-not-be-trusted.example') {
  return spawnSync('sh', ['scripts/generate-production-env.sh', target], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      S3_ENDPOINT_VALUE: endpoint,
      S3_UPSTREAM_VALUE: upstream,
    },
  });
}

describe('production storage endpoint generation', () => {
  it('derives the Caddy upstream from the canonical S3 endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cpi-storage-config-'));
    const target = join(directory, '.env');
    try {
      const result = generate(target, 'https://s3.example.test/');
      expect(result.status, result.stderr).toBe(0);
      const output = await readFile(target, 'utf8');
      expect(output).toContain('S3_ENDPOINT=https://s3.example.test/\n');
      expect(output).toContain('S3_UPSTREAM=s3.example.test\n');
      expect(output).not.toContain('must-not-be-trusted.example');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an endpoint with a path instead of producing a divergent upstream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cpi-storage-config-'));
    const target = join(directory, '.env');
    try {
      const result = generate(target, 'https://s3.example.test/wrong');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('without credentials, path, query or fragment');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses to install Caddy configuration when endpoint and upstream diverge', () => {
    const result = spawnSync('sh', ['scripts/install-caddy-fragment.sh'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ARTIFACTS_DOMAIN: 'artifacts.example.test',
        S3_ENDPOINT: 'https://s3.example.test',
        S3_UPSTREAM: 'different.example.test',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must exactly match');
  });
});
