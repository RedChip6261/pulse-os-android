/*
 * Pulse OS — attachments: camera, gallery and documents (PDF, text, DOCX, images).
 * Files are read as base64 with expo-file-system and sent to Gemini as inlineData in the same turn as the text.
 */
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { strFromU8, unzipSync } from 'fflate';

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

export type Attachment = {
  uri: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'document';
  size: number;
  base64?: string; // sent as inlineData (images, PDFs)
  textContent?: string; // sent as a text part (txt, md, csv, json, docx)
};

export class AttachmentError extends Error {}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'text/xml',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const DOCX = EXT_MIME.docx;
const TEXT_LIKE = /^(text\/|application\/(json|xml))/;
const IMAGE_OK = /^image\/(jpeg|png|webp|heic|heif)$/;

function mimeFor(name: string, given?: string | null): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const fromExt = EXT_MIME[ext];
  if (given && given !== 'application/octet-stream') {
    if (given === 'image/jpg') return 'image/jpeg';
    return given;
  }
  return fromExt || 'application/octet-stream';
}

function mb(n: number) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function sizeOf(uri: string, hinted?: number | null): Promise<number> {
  if (hinted && hinted > 0) return hinted;
  const info: any = await FileSystem.getInfoAsync(uri).catch(() => null);
  return Number(info?.size) || 0;
}

function checkSize(size: number, name: string) {
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`"${name}" is ${mb(size)}. The limit is 15 MB — pick a smaller file or a lower-resolution photo.`);
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = (globalThis as any).atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function docxToText(b64: string): string {
  const files = unzipSync(base64ToBytes(b64), { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new AttachmentError('That Word file could not be read.');
  return strFromU8(xml)
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fromImageAsset(a: ImagePicker.ImagePickerAsset): Promise<Attachment> {
  const name = a.fileName || `photo-${Date.now()}.jpg`;
  const mimeType = mimeFor(name, a.mimeType);
  const size = await sizeOf(a.uri, a.fileSize);
  checkSize(size, name);
  const base64 = a.base64 || (await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 }));
  return { uri: a.uri, name, mimeType: IMAGE_OK.test(mimeType) ? mimeType : 'image/jpeg', kind: 'image', size, base64 };
}

const IMAGE_OPTS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  quality: 0.7, // keeps photos well under the limit and uploads faster
  base64: false,
  exif: false,
  allowsEditing: false,
};

export async function takePhoto(): Promise<Attachment | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new AttachmentError('Camera permission is off. Allow it in Android Settings > Apps > Pulse OS > Permissions.');
  const res = await ImagePicker.launchCameraAsync(IMAGE_OPTS);
  if (res.canceled || !res.assets?.length) return null;
  return fromImageAsset(res.assets[0]);
}

export async function pickImage(): Promise<Attachment | null> {
  // Android 13+ uses the system photo picker, which needs no permission.
  const res = await ImagePicker.launchImageLibraryAsync(IMAGE_OPTS);
  if (res.canceled || !res.assets?.length) return null;
  return fromImageAsset(res.assets[0]);
}

export async function pickDocument(): Promise<Attachment | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'text/*', 'application/json', DOCX, 'image/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled || !res.assets?.length) return null;
  const a = res.assets[0];
  const name = a.name || 'file';
  const mimeType = mimeFor(name, a.mimeType);
  const size = await sizeOf(a.uri, a.size);
  checkSize(size, name);

  if (IMAGE_OK.test(mimeType)) {
    const base64 = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
    return { uri: a.uri, name, mimeType, kind: 'image', size, base64 };
  }
  if (mimeType === 'application/pdf') {
    const base64 = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
    return { uri: a.uri, name, mimeType, kind: 'document', size, base64 };
  }
  if (mimeType === DOCX) {
    const b64 = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.Base64 });
    const text = docxToText(b64);
    if (!text) throw new AttachmentError('That Word file has no readable text.');
    return { uri: a.uri, name, mimeType, kind: 'document', size, textContent: text.slice(0, 200000) };
  }
  if (TEXT_LIKE.test(mimeType)) {
    const text = await FileSystem.readAsStringAsync(a.uri, { encoding: FileSystem.EncodingType.UTF8 });
    return { uri: a.uri, name, mimeType, kind: 'document', size, textContent: text.slice(0, 200000) };
  }
  throw new AttachmentError(`"${name}" isn't supported. Use a PDF, Word (.docx), text file or image.`);
}

export function prettySize(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return mb(n);
}
