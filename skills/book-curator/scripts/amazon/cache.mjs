// Caller must have explicit raw-cache authorization and a host-permitted private path.
import {open, lstat, unlink} from 'node:fs/promises';
export async function saveNewSnapshot(path, capture, {rawCacheAuthorized = false} = {}) {
  if (!rawCacheAuthorized) throw new Error('Raw-cache authorization required');
  if (capture?.format !== 'book-curator-amazon-content' || capture.version !== 1 || !['books','docs'].includes(capture.category) || !Array.isArray(capture.records)) throw new Error('Invalid capture');
  // Exclusive creation prevents replacement of any previous, potentially richer snapshot.
  const bytes = JSON.stringify(capture, null, 2) + '\n';
  const file = await open(path, 'wx+', 0o600);
  const created = await file.stat();
  try {
    await file.writeFile(bytes, 'utf8');
    await file.sync();
    const buffer = Buffer.alloc(Buffer.byteLength(bytes));
    const {bytesRead} = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length || buffer.toString('utf8') !== bytes) throw new Error('Snapshot read-back mismatch');
    const current = await lstat(path);
    if (current.dev !== created.dev || current.ino !== created.ino) throw new Error('Snapshot path changed');
  } catch (error) {
    try { const current = await lstat(path); if (current.dev === created.dev && current.ino === created.ino) await unlink(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    throw error;
  } finally { await file.close(); }
}
