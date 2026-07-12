import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { buildCollage, pickCollagePhotos } from '../src/collage';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bereal-collage-'));

async function makeImage(name: string, r: number, g: number, b: number): Promise<string> {
  const file = path.join(tmp, name);
  await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r, g, b } },
  })
    .png()
    .toFile(file);
  return file;
}

test('buildCollage lays out a near-square grid of cover-fitted tiles', async () => {
  const images = [
    await makeImage('a.png', 255, 0, 0),
    await makeImage('b.png', 0, 255, 0),
    await makeImage('c.png', 0, 0, 255),
  ];
  const out = path.join(tmp, 'collage.jpg');
  assert.equal(await buildCollage(images, out), true);

  // 3 images -> 2 columns x 2 rows of 400px cells.
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 800);
  assert.equal(meta.height, 800);
  assert.equal(meta.format, 'jpeg');
});

test('pickCollagePhotos ranks by reaction score with chronological tiebreak', () => {
  const picked = pickCollagePhotos([
    { path: 'mon.jpg', score: 1 },
    { path: 'tue.jpg', score: 5 },
    { path: 'wed.jpg', score: 0 },
    { path: 'thu.jpg', score: 5 },
    { path: 'fri.jpg', score: 0 },
  ]);
  // Highest score first; ties (tue/thu and wed/fri) keep chronological order.
  assert.deepEqual(picked, ['tue.jpg', 'thu.jpg', 'mon.jpg', 'wed.jpg', 'fri.jpg']);
});

test('buildCollage declines with fewer than two images', async () => {
  const one = [await makeImage('solo.png', 128, 128, 128)];
  const out = path.join(tmp, 'nope.jpg');
  assert.equal(await buildCollage(one, out), false);
  assert.equal(fs.existsSync(out), false);
});
