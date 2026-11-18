/*
 * Pulse OS — Dedicated User Profile & Account Management Page
 */
import React, { useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { VoiceLanguageMode } from './pulseFeatures';
import { UserProfile } from './src/assistant';
import { changeAccountPassword, PublicUser, updateAccountProfile } from './src/auth';

const C = {
  bg: '#090C12',
  surface: '#111622',
  surface2: '#182032',
  border: '#1F293B',
  text: '#F8FAFC',
  muted: '#8B9BB4',
  accent: '#6366F1',
  cyan: '#38BDF8',
  good: '#10B981',
  danger: '#EF4444',
};

export type AgentMode = 'auto' | 'local' | 'cloud';

export default function ProfileScreen({
  user,
  profile,
  onSaveProfile,
  onUserUpdated,
  onLogout,
  onOpenAuth,
  agentMode,
  setAgentMode,
  voiceLang,
  setVoiceLang,
  voiceOn,
  setVoiceOn,
  stats,
  onClose,
}: {
  user: PublicUser | null;
  profile: UserProfile;
  onSaveProfile: (p: UserProfile) => void;
  onUserUpdated: (u: PublicUser) => void;
  onLogout: () => void;
  onOpenAuth: () => void;
  agentMode: AgentMode;
  setAgentMode: (m: AgentMode) => void;
  voiceLang: VoiceLanguageMode;
  setVoiceLang: (l: VoiceLanguageMode) => void;
  voiceOn: boolean;
  setVoiceOn: (v: boolean) => void;
  stats: { memories: number; reminders: number; workflows: number; notes: number };
  onClose: () => void;
}) {
  const [name, setName] = useState(user?.name || profile.name);
  const [email, setEmail] = useState(user?.email || profile.email);
  const [phone, setPhone] = useState(user?.phone || profile.phone);
  const [address, setAddress] = useState(user?.address || profile.address);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [status, setStatus] = useState('');
  const [pwStatus, setPwStatus] = useState('');

  const initials = (name || email || 'P')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0].toUpperCase())
    .join('');

  const handleSave = async () => {
    setStatus('');
    const next: UserProfile = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      address: address.trim(),
    };
    try {
      if (user) {
        const updated = await updateAccountProfile(user.id, next);
        onUserUpdated(updated);
      }
      onSaveProfile(next);
      setStatus('Profile saved.');
    } catch (e: any) {
      setStatus(e?.message || 'Could not save profile.');
    }
  };

  const handleChangePassword = async () => {
    if (!user) return;
    setPwStatus('');
    try {
      await changeAccountPassword(user.id, curPw, newPw);
      setCurPw('');
      setNewPw('');
      setPwStatus('Password updated.');
    } catch (e: any) {
      setPwStatus(e?.message || 'Could not update password.');
    }
  };

  const confirmLogout = () => {
    Alert.alert('Log out?', 'You will return to the Sign In screen. Your local data remains safely stored on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: onLogout },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={s.header}>
        <Text style={s.brand}>Profile</Text>
        <Pressable onPress={onClose} style={s.pillBtn}>
          <Text style={s.pillText}>Done</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
        <View style={s.hero}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials || 'P'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.heroName}>{name || 'Guest User'}</Text>
            <Text style={s.muted}>{email || (user ? 'Signed in' : 'Not signed in · Guest mode')}</Text>
          </View>
          {!user && (
            <Pressable onPress={onOpenAuth} style={[s.pillBtn, { borderColor: C.accent }]}>
              <Text style={s.pillText}>Sign In</Text>
            </Pressable>
          )}
        </View>

        <View style={s.statsRow}>
          {[
            { label: 'Memories', val: stats.memories },
            { label: 'Reminders', val: stats.reminders },
            { label: 'Workflows', val: stats.workflows },
            { label: 'Notes', val: stats.notes },
          ].map((st) => (
            <View key={st.label} style={s.statBox}>
              <Text style={s.statVal}>{st.val}</Text>
              <Text style={s.statLabel}>{st.label}</Text>
            </View>
          ))}
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Personal Information</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Full Name" placeholderTextColor={C.muted} style={s.input} />
          <TextInput value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={C.muted} autoCapitalize="none" keyboardType="email-address" style={s.input} />
          <TextInput value={phone} onChangeText={setPhone} placeholder="Phone" placeholderTextColor={C.muted} keyboardType="phone-pad" style={s.input} />
          <TextInput value={address} onChangeText={setAddress} placeholder="Home area / address" placeholderTextColor={C.muted} style={s.input} />
          {!!status && <Text style={{ color: C.good, fontSize: 12 }}>{status}</Text>}
          <Pressable onPress={handleSave} style={s.primaryBtn}>
            <Text style={s.primaryText}>Save Changes</Text>
          </Pressable>
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Agent & Voice Preferences</Text>
          <Text style={s.label}>Active Agent Mode</Text>
          <View style={s.chipRow}>
            {(
              [
                { id: 'auto', label: 'Auto (Local + Cloud)' },
                { id: 'local', label: 'Pulse Local (No Key)' },
                { id: 'cloud', label: 'Cloud AI' },
              ] as { id: AgentMode; label: string }[]
            ).map((m) => (
              <Pressable key={m.id} onPress={() => setAgentMode(m.id)} style={[s.chip, agentMode === m.id && s.chipOn]}>
                <Text style={s.chipText}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.label}>Voice Language</Text>
          <View style={s.chipRow}>
            {(
              [
                { id: 'BILINGUAL_AUTO', label: 'Auto' },
                { id: 'en-IN', label: 'English' },
                { id: 'te-IN', label: 'తెలుగు' },
              ] as { id: VoiceLanguageMode; label: string }[]
            ).map((l) => (
              <Pressable key={l.id} onPress={() => setVoiceLang(l.id)} style={[s.chip, voiceLang === l.id && s.chipOn]}>
                <Text style={s.chipText}>{l.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={s.rowBetween}>
            <Text style={s.bodyText}>Read chat replies aloud</Text>
            <Switch value={voiceOn} onValueChange={setVoiceOn} trackColor={{ false: C.border, true: C.accent }} thumbColor="#fff" />
          </View>
        </View>

        {user ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>Security</Text>
            <TextInput
              value={curPw}
              onChangeText={setCurPw}
              placeholder="Current password"
              placeholderTextColor={C.muted}
              secureTextEntry
              autoCapitalize="none"
              style={s.input}
            />
            <TextInput
              value={newPw}
              onChangeText={setNewPw}
              placeholder="New password (6+ chars)"
              placeholderTextColor={C.muted}
              secureTextEntry
              autoCapitalize="none"
              style={s.input}
            />
            {!!pwStatus && <Text style={{ color: pwStatus.includes('updated') ? C.good : C.danger, fontSize: 12 }}>{pwStatus}</Text>}
            <Pressable onPress={handleChangePassword} style={s.secondaryBtn}>
              <Text style={s.primaryText}>Update Password</Text>
            </Pressable>
          </View>
        ) : null}

        <Pressable onPress={user ? confirmLogout : onOpenAuth} style={[s.logoutBtn, !user && { borderColor: C.accent, backgroundColor: 'rgba(99,102,241,0.14)' }]}>
          <Text style={[s.logoutText, !user && { color: C.text }]}>{user ? 'Log Out' : 'Sign In or Create Account'}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  brand: { color: C.text, fontSize: 17, fontWeight: '700' },
  pillBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  pillText: { color: C.text, fontSize: 12, fontWeight: '600' },
  wrap: { padding: 16, gap: 14, paddingBottom: 40 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.surface, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: C.border },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 20, fontWeight: '800' },
  heroName: { color: C.text, fontSize: 17, fontWeight: '700' },
  muted: { color: C.muted, fontSize: 12, marginTop: 2 },
  statsRow: { flexDirection: 'row', gap: 8 },
  statBox: { flex: 1, backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.border, paddingVertical: 10, alignItems: 'center' },
  statVal: { color: C.text, fontSize: 17, fontWeight: '800' },
  statLabel: { color: C.muted, fontSize: 11, marginTop: 2 },
  card: { backgroundColor: C.surface, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14, gap: 10 },
  cardTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  label: { color: C.muted, fontSize: 12, fontWeight: '600' },
  bodyText: { color: C.text, fontSize: 14 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
  chipOn: { borderColor: C.accent, backgroundColor: 'rgba(99,102,241,0.22)' },
  chipText: { color: C.text, fontSize: 12, fontWeight: '600' },
  input: { color: C.text, backgroundColor: C.bg, borderRadius: 10, borderWidth: 1, borderColor: C.border, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14 },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 11, alignItems: 'center' },
  secondaryBtn: { backgroundColor: C.surface2, borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  logoutBtn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: C.danger, backgroundColor: 'rgba(239,68,68,0.12)' },
  logoutText: { color: C.danger, fontSize: 15, fontWeight: '700' },
});
