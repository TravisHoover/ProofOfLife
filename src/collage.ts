import sharp from 'sharp';

const CELL = 400;
const MAX_TILES = 12;

// Composites up to MAX_TILES images into a near-square grid. Returns false
// when there aren't enough images to make a grid worthwhile.
export async function buildCollage(imagePaths: string[], outPath: string): Promise<boolean> {
  const files = imagePaths.slice(0, MAX_TILES);
  if (files.length < 2) return false;

  const cols = Math.ceil(Math.sqrt(files.length));
  const rows = Math.ceil(files.length / cols);

  const tiles = await Promise.all(
    files.map(async (file, i) => ({
      input: await sharp(file).resize(CELL, CELL, { fit: 'cover' }).toBuffer(),
      left: (i % cols) * CELL,
      top: Math.floor(i / cols) * CELL,
    })),
  );

  await sharp({
    create: {
      width: cols * CELL,
      height: rows * CELL,
      channels: 3,
      background: { r: 17, g: 17, b: 20 },
    },
  })
    .composite(tiles)
    .jpeg({ quality: 85 })
    .toFile(outPath);

  return true;
}
