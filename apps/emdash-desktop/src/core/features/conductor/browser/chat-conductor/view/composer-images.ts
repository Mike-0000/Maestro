import {
  conductorImageType,
  MAX_CONDUCTOR_IMAGE_BYTES,
  type ConductorImage,
} from '../../../api/chat-conductor/images';

/** The files among pasted clipboard items or dropped files that may be images. */
export function filesOf(source: DataTransferItemList | FileList | readonly File[]): File[] {
  const files: File[] = [];
  for (const entry of Array.from(source as ArrayLike<DataTransferItem | File>)) {
    if (entry instanceof File) {
      files.push(entry);
      continue;
    }
    if (entry.kind !== 'file') continue;
    const file = entry.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export type ReadImage = { image: ConductorImage } | { error: string };

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('unreadable'));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

/** Reads a file for the conductor, or says why it cannot go. */
export async function readConductorImage(file: File): Promise<ReadImage> {
  const name = file.name || 'pasted image';
  const mediaType = conductorImageType(file.type, file.name);
  if (!mediaType) return { error: `${name} is not a PNG, JPEG, GIF or WebP image.` };
  if (file.size > MAX_CONDUCTOR_IMAGE_BYTES) {
    return { error: `${name} is too large (the limit is 3.75 MB).` };
  }
  try {
    const url = await readDataUrl(file);
    const data = url.slice(url.indexOf(',') + 1);
    if (!data) return { error: `${name} could not be read.` };
    return { image: { id: crypto.randomUUID(), name, mediaType, data } };
  } catch {
    return { error: `${name} could not be read.` };
  }
}
