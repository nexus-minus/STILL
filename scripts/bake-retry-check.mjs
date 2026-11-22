#!/usr/bin/env node
/** Verify the shell retries a native Blender exit 139 with CPU forced. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temp = mkdtempSync(join(tmpdir(), 'liminal-bake-retry-'));
try {
  const fakeBlender = join(temp, 'blender');
  const state = join(temp, 'calls');
  const record = join(temp, 'devices');
  const fakeSource = [
    '#!/bin/sh',
    'count=0',
    `[ -f '${state}' ] && count=$(cat '${state}')`,
    'count=$((count + 1))',
    `printf '%s\\n' "$count" > '${state}'`,
    `printf '%s\\n' "\${LIMINAL_BAKE_DEVICE:-AUTO}" >> '${record}'`,
    '[ "$count" -eq 1 ] && exit 139',
    '[ "\${LIMINAL_BAKE_DEVICE:-}" = CPU ] || exit 42',
    'exit 0',
  ].join('\n') + '\n';
  writeFileSync(fakeBlender, fakeSource);
  chmodSync(fakeBlender, 0o755);
  const blend = join(temp, 'map.blend');
  writeFileSync(blend, 'fixture');
  const result = spawnSync('bash', [resolve('tools/bake_map.sh'), '--resolution', '32', blend], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, BLENDER: fakeBlender, OUT_DIR: join(temp, 'out') },
  });
  if (result.status !== 0) throw new Error(`retry command exited ${result.status}: ${result.stderr}`);
  const devices = readFileSync(record, 'utf8').trim().split(/\r?\n/);
  if (devices.join(',') !== 'AUTO,CPU') throw new Error(`expected AUTO,CPU retry, got ${devices.join(',')}`);
  if (!result.stderr.includes('retrying the full export+bake on CPU')) {
    throw new Error('missing visible CPU retry message');
  }
  console.log(`calls: ${devices.length}, devices: ${devices.join(' → ')}`);
  console.log('PASS bake retry guard');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
