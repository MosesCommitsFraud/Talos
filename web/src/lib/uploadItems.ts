/** Folder uploads: keep each file's path inside the folder it came from.
 *
 *  A file picked through `<input webkitdirectory>` carries
 *  `webkitRelativePath`; a dropped folder has to be walked through the
 *  FileSystem entry API, and its paths are remembered here. The path becomes
 *  the document's identity on the server, so "Nord/Protokoll.docx" and
 *  "Süd/Protokoll.docx" stay two documents. */

const relPaths = new WeakMap<File, string>();

export function relativePathOf(file: File): string {
  return relPaths.get(file) || (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
}

function readFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await readFile(entry as FileSystemFileEntry);
    relPaths.set(file, prefix + file.name);
    out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands out batches (about 100 in Chromium) until empty.
    for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/** Every file in a drop, folders included. Must be called synchronously from
 *  the drop handler: the items are only valid until it returns. */
export function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  const loose = Array.from(dt.files ?? []);
  if (!entries.length) return Promise.resolve(loose);
  return (async () => {
    const out: File[] = [];
    for (const entry of entries) await walk(entry, '', out);
    return out;
  })();
}

/** Split an upload into requests of at most `maxFiles` files / `maxBytes`. */
export function uploadBatches(files: File[], maxFiles = 100, maxBytes = 512 * 1024 * 1024): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let size = 0;
  for (const file of files) {
    if (current.length && (current.length >= maxFiles || size + file.size > maxBytes)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}
