import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { BlobStore } from '../src/core/store.js';

async function readText(stream) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

test('BlobStore writes complete blobs and removes failed temp files', async (t) => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'cachenest-store-'));
  t.after(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const store = new BlobStore({ cacheDir: temporaryDirectory });

  const bufferKey = 'a'.repeat(64);
  const bufferResult = await store.write(bufferKey, Buffer.from('buffer contents'));
  assert.equal(bufferResult.size, 15);

  const bufferBlob = await store.openRead(bufferKey);
  assert.ok(bufferBlob);
  assert.equal(await readText(bufferBlob.stream), 'buffer contents');

  const streamKey = 'b'.repeat(64);
  await store.write(streamKey, Readable.from([Buffer.from('stream '), Buffer.from('contents')]));

  const streamBlob = await store.openRead(streamKey);
  assert.ok(streamBlob);
  assert.equal(await readText(streamBlob.stream), 'stream contents');

  const bufferShard = await fs.readdir(path.dirname(store.pathForKey(bufferKey)));
  assert.deepEqual(bufferShard, [bufferKey], 'no temporary file should remain after success');

  const failedKey = 'c'.repeat(64);
  const failingBody = new Readable({
    read() {
      this.push(Buffer.from('partial download'));
      this.destroy(new Error('network dropped'));
    },
  });

  await assert.rejects(store.write(failedKey, failingBody), /failed to write blob/);
  assert.equal(await store.openRead(failedKey), null);

  const failedShard = await fs.readdir(path.dirname(store.pathForKey(failedKey)));
  assert.deepEqual(failedShard, [], 'failed downloads should leave no blob or temp file');
});
