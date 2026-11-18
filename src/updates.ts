/*
 * Pulse OS — in-app updates. Downloads the APK from the latest GitHub release inside the app (with progress)
 * and opens the Android package installer directly. Android always shows one "Install" confirmation; that's expected.
 */
import { Linking, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Application from 'expo-application';

export const UPDATE_REPO = 'RedChip6261/pulse-os-android';
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases/latest`;
const APK_MIME = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

export type UpdateInfo = {
  available: boolean;
  latestBuild: number;
  currentBuild: number;
  tag: string;
  name: string;
  notes: string;
  sizeBytes: number;
  apkUrl: string;
};

/** The build number of the APK actually installed (android versionCode), falling back to app.json. */
export function installedBuild(fallback: number): number {
  const n = Number(Application.nativeBuildVersion);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function checkForUpdate(fallbackBuild: number): Promise<UpdateInfo> {
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (res.status === 403) throw new Error('GitHub rate limit reached. Try again in a few minutes.');
  if (!res.ok) throw new Error(`Update check failed (HTTP ${res.status}).`);
  const rel: any = await res.json();
  const asset = (rel.assets || []).find((a: any) => /\.apk$/i.test(String(a?.name)));
  if (!asset?.browser_download_url) throw new Error('The latest release has no APK yet.');
  const m = String(rel.tag_name || '').match(/(\d+)\s*$/);
  const latestBuild = m ? parseInt(m[1], 10) : 0;
  const currentBuild = installedBuild(fallbackBuild);
  return {
    available: latestBuild > currentBuild,
    latestBuild,
    currentBuild,
    tag: String(rel.tag_name || ''),
    name: String(rel.name || rel.tag_name || ''),
    notes: String(rel.body || '').slice(0, 400),
    sizeBytes: Number(asset.size) || 0,
    apkUrl: String(asset.browser_download_url),
  };
}

let active: FileSystem.DownloadResumable | null = null;

export async function cancelDownload() {
  if (active) await active.pauseAsync().catch(() => undefined);
  active = null;
}

/** Downloads the APK into the app cache with progress (0..1). Returns the local file uri. */
export async function downloadApk(info: UpdateInfo, onProgress: (f: number) => void): Promise<string> {
  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
  const dest = `${dir}pulse-os-${info.latestBuild}.apk`;
  const existing: any = await FileSystem.getInfoAsync(dest).catch(() => null);
  if (existing?.exists && info.sizeBytes && Number(existing.size) === info.sizeBytes) {
    onProgress(1);
    return dest; // already downloaded
  }
  await FileSystem.deleteAsync(dest, { idempotent: true });
  active = FileSystem.createDownloadResumable(info.apkUrl, dest, {}, (p) => {
    const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : info.sizeBytes;
    if (total > 0) onProgress(Math.min(1, p.totalBytesWritten / total));
  });
  const res = await active.downloadAsync();
  active = null;
  if (!res || (res.status && res.status >= 400)) throw new Error(`Download failed (HTTP ${res?.status ?? '?'}).`);
  onProgress(1);
  return res.uri || dest;
}

/** Opens the system package installer for a downloaded APK. Never opens the browser. */
export async function installApk(fileUri: string): Promise<void> {
  if (Platform.OS !== 'android') throw new Error('Updates install on Android only.');
  const contentUri = await FileSystem.getContentUriAsync(fileUri);
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
      data: contentUri,
      type: APK_MIME,
      flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
    });
  } catch {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: APK_MIME,
      flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
    });
  }
}

/** Android asks once to allow "Install unknown apps" for Pulse OS; this opens that exact toggle. */
export async function openInstallPermissionSettings(): Promise<void> {
  const pkg = Application.applicationId || 'com.pulseos.app';
  await IntentLauncher.startActivityAsync('android.settings.MANAGE_UNKNOWN_APP_SOURCES', { data: `package:${pkg}` }).catch(() => Linking.openSettings());
}

/** Only used by the explicit "Open release page" link. */
export function openReleasePage() {
  return Linking.openURL(RELEASES_PAGE);
}
