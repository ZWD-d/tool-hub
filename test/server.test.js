import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, isPublicAddress, openRemote } from '../server.js';

test('rejects private, reserved, and IPv6 destinations', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  await assert.rejects(openRemote('http://127.0.0.1/test'), /禁止访问/);
  await assert.rejects(openRemote('file:///etc/passwd'), /仅支持/);
  await assert.rejects(openRemote('https://example.com:8080/test'), /仅支持/);
});

test('download API preserves content, validates requests, supports cancellation and cleanup', async t => {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'tool-hub-test-'));
  const content = Buffer.from('测试下载内容\n');
  const server = createApp({ storage, opener: async input => {
    const url = new URL(input);
    const response = url.pathname === '/slow' ? new Readable({ read() {} }) : Readable.from([content]);
    response.headers = { 'content-length': url.pathname === '/large' ? String(1024 ** 3 + 1) : String(content.length) };
    return { response, url };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(storage, { recursive: true, force: true }); });
  const submit = async name => (await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `https://example.com/${name}` }) })).json();
  const settle = async (id, expected) => {
    for (let i = 0; i < 100; i++) {
      const jobs = await (await fetch(`${base}/api/jobs`)).json();
      const job = jobs.find(job => job.id === id);
      if (job.status === expected) return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Job did not reach ${expected}`);
  };
  assert.match(await (await fetch(base)).text(), /下载，简单一点/);
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/api/jobs`, { method: 'POST', body: '{}' })).status, 415);
  const job = await submit('sample.txt');
  const completed = await settle(job.id, 'complete');
  assert.equal(completed.received, content.length);
  const file = await fetch(`${base}/api/jobs/${job.id}/file`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /sample.txt/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), content);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/jobs/${job.id}/file`)).status, 404);
  const large = await submit('large');
  assert.match((await settle(large.id, 'failed')).error, /1 GiB/);
  const slow = await submit('slow');
  await fetch(`${base}/api/jobs/${slow.id}`, { method: 'DELETE' });
  await settle(slow.id, 'cancelled');
});
