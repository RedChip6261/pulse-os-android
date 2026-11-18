/*
 * Pulse OS — Local User Authentication & Account Management
 * Supports secure account creation, login, logout, profile updates, and password changes
 * stored locally in AsyncStorage without external auth dependencies.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { UserProfile } from './assistant';

const STORAGE_ACCOUNTS = 'pulseos.accounts.v1';
const STORAGE_SESSION = 'pulseos.session.v1';

export type StoredUser = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  updatedAt: number;
};

export type PublicUser = Omit<StoredUser, 'passwordHash' | 'salt'>;

function toPublic(u: StoredUser): PublicUser {
  const { passwordHash: _p, salt: _s, ...pub } = u;
  return pub;
}

export function userToProfile(u: PublicUser | null): UserProfile {
  if (!u) return { name: '', email: '', phone: '', address: '' };
  return { name: u.name, email: u.email, phone: u.phone, address: u.address };
}

/** Deterministic pure-JS salted iterative hash (FNV-1a / Murmur-style 128-bit mix) for local password verification. */
function hashPassword(password: string, salt: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  const input = `${salt}:${password}:pulse-os-v6`;
  for (let round = 0; round < 512; round++) {
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i) ^ (round & 0xff);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (c + round), 0x85ebca6b) >>> 0;
      h3 = Math.imul(h3 ^ (h1 >>> 3), 0xc2b2ae35) >>> 0;
      h4 = Math.imul(h4 ^ (h2 >>> 5), 0x27d4eb2f) >>> 0;
    }
  }
  return [h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

function makeSalt(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function loadAccounts(): Promise<StoredUser[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_ACCOUNTS);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAccounts(list: StoredUser[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_ACCOUNTS, JSON.stringify(list));
}

export async function loadSessionUser(): Promise<PublicUser | null> {
  try {
    const uid = await AsyncStorage.getItem(STORAGE_SESSION);
    if (!uid) return null;
    const accounts = await loadAccounts();
    const found = accounts.find((a) => a.id === uid);
    return found ? toPublic(found) : null;
  } catch {
    return null;
  }
}

export async function registerUser(opts: {
  name: string;
  email: string;
  phone?: string;
  address?: string;
  password: string;
}): Promise<PublicUser> {
  const name = opts.name.trim();
  const email = opts.email.trim().toLowerCase();
  const phone = (opts.phone || '').trim();
  const address = (opts.address || '').trim();
  const password = opts.password;

  if (!name) throw new Error('Please enter your full name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');

  const accounts = await loadAccounts();
  if (accounts.some((a) => a.email === email)) {
    throw new Error('An account with this email already exists. Sign in instead.');
  }

  const salt = makeSalt();
  const now = Date.now();
  const user: StoredUser = {
    id: 'usr_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    email,
    phone,
    address,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: now,
    updatedAt: now,
  };
  await saveAccounts([user, ...accounts]);
  await AsyncStorage.setItem(STORAGE_SESSION, user.id);
  return toPublic(user);
}

export async function loginUser(emailRaw: string, password: string): Promise<PublicUser> {
  const email = emailRaw.trim().toLowerCase();
  if (!email || !password) throw new Error('Enter both your email and password.');
  const accounts = await loadAccounts();
  const user = accounts.find((a) => a.email === email);
  if (!user) throw new Error('No account found with that email.');
  if (hashPassword(password, user.salt) !== user.passwordHash) {
    throw new Error('Incorrect password. Please try again.');
  }
  await AsyncStorage.setItem(STORAGE_SESSION, user.id);
  return toPublic(user);
}

export async function logoutUser(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_SESSION);
}

export async function updateAccountProfile(userId: string, patch: UserProfile): Promise<PublicUser> {
  const accounts = await loadAccounts();
  const idx = accounts.findIndex((a) => a.id === userId);
  if (idx < 0) throw new Error('Account not found.');
  const nextEmail = patch.email.trim().toLowerCase();
  if (nextEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    throw new Error('Please enter a valid email address.');
  }
  if (nextEmail && accounts.some((a, i) => i !== idx && a.email === nextEmail)) {
    throw new Error('Another account already uses that email.');
  }
  const updated: StoredUser = {
    ...accounts[idx],
    name: patch.name.trim() || accounts[idx].name,
    email: nextEmail || accounts[idx].email,
    phone: patch.phone.trim(),
    address: patch.address.trim(),
    updatedAt: Date.now(),
  };
  accounts[idx] = updated;
  await saveAccounts(accounts);
  return toPublic(updated);
}

export async function changeAccountPassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  if (newPassword.length < 6) throw new Error('New password must be at least 6 characters.');
  const accounts = await loadAccounts();
  const idx = accounts.findIndex((a) => a.id === userId);
  if (idx < 0) throw new Error('Account not found.');
  const user = accounts[idx];
  if (hashPassword(currentPassword, user.salt) !== user.passwordHash) {
    throw new Error('Current password is incorrect.');
  }
  const salt = makeSalt();
  accounts[idx] = {
    ...user,
    salt,
    passwordHash: hashPassword(newPassword, salt),
    updatedAt: Date.now(),
  };
  await saveAccounts(accounts);
}
