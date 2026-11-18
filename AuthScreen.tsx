/*
 * Pulse OS — Dedicated Login & Account Creation Screen
 */
import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { loginUser, PublicUser, registerUser } from './src/auth';

const C = {
  bg: '#090C12',
  surface: '#111622',
  surface2: '#182032',
  border: '#1F293B',
  text: '#F8FAFC',
  muted: '#8B9BB4',
  accent: '#6366F1',
  cyan: '#38BDF8',
  danger: '#EF4444',
};

export default function AuthScreen({
  onAuthenticated,
  onContinueGuest,
}: {
  onAuthenticated: (user: PublicUser) => void;
  onContinueGuest: () => void;
}) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const user =
        mode === 'login'
          ? await loginUser(email, password)
          : await registerUser({ name, email, phone, password });
      onAuthenticated(user);
    } catch (e: any) {
      setError(e?.message || 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={s.root}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
          <View style={s.brandBox}>
            <View style={s.dot} />
            <Text style={s.brand}>Pulse OS</Text>
            <Text style={s.tagline}>Personal AI, voice automation & cloud computer</Text>
          </View>

          <View style={s.card}>
            <View style={s.tabs}>
              <Pressable onPress={() => { setMode('login'); setError(''); }} style={[s.tab, mode === 'login' && s.tabOn]}>
                <Text style={[s.tabText, mode === 'login' && s.tabTextOn]}>Sign In</Text>
              </Pressable>
              <Pressable onPress={() => { setMode('signup'); setError(''); }} style={[s.tab, mode === 'signup' && s.tabOn]}>
                <Text style={[s.tabText, mode === 'signup' && s.tabTextOn]}>Create Account</Text>
              </Pressable>
            </View>

            {mode === 'signup' && (
              <>
                <Text style={s.label}>Full Name</Text>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Your name"
                  placeholderTextColor={C.muted}
                  style={s.input}
                />
              </>
            )}

            <Text style={s.label}>Email</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={C.muted}
              autoCapitalize="none"
              keyboardType="email-address"
              style={s.input}
            />

            {mode === 'signup' && (
              <>
                <Text style={s.label}>Phone (optional)</Text>
                <TextInput
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="+91 98..."
                  placeholderTextColor={C.muted}
                  keyboardType="phone-pad"
                  style={s.input}
                />
              </>
            )}

            <Text style={s.label}>Password</Text>
            <View style={s.pwRow}>
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder={mode === 'signup' ? 'At least 6 characters' : 'Your password'}
                placeholderTextColor={C.muted}
                secureTextEntry={!showPw}
                autoCapitalize="none"
                style={[s.input, { flex: 1, borderWidth: 0 }]}
              />
              <Pressable onPress={() => setShowPw((v) => !v)} style={s.eyeBtn}>
                <Text style={s.eyeText}>{showPw ? 'Hide' : 'Show'}</Text>
              </Pressable>
            </View>

            {!!error && <Text style={s.error}>{error}</Text>}

            <Pressable onPress={submit} disabled={busy} style={[s.primaryBtn, busy && { opacity: 0.6 }]}>
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={s.primaryText}>{mode === 'login' ? 'Sign In' : 'Create Account'}</Text>
              )}
            </Pressable>
          </View>

          <Pressable onPress={onContinueGuest} style={s.guestBtn}>
            <Text style={s.guestText}>Continue without an account</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === 'android' ? RNStatusBar.currentHeight ?? 0 : 0 },
  wrap: { flexGrow: 1, justifyContent: 'center', padding: 20, gap: 18 },
  brandBox: { alignItems: 'center', gap: 6, marginBottom: 4 },
  dot: { width: 16, height: 16, borderRadius: 8, backgroundColor: C.accent, marginBottom: 4 },
  brand: { color: C.text, fontSize: 28, fontWeight: '800', letterSpacing: 0.3 },
  tagline: { color: C.muted, fontSize: 13, textAlign: 'center' },
  card: { backgroundColor: C.surface, borderRadius: 18, borderWidth: 1, borderColor: C.border, padding: 16, gap: 10 },
  tabs: { flexDirection: 'row', backgroundColor: C.surface2, borderRadius: 12, padding: 4, marginBottom: 4 },
  tab: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 9 },
  tabOn: { backgroundColor: C.accent },
  tabText: { color: C.muted, fontSize: 13, fontWeight: '700' },
  tabTextOn: { color: '#fff' },
  label: { color: C.muted, fontSize: 12, fontWeight: '600', marginTop: 2 },
  input: {
    color: C.text,
    backgroundColor: C.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
  },
  pwRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingRight: 10,
  },
  eyeBtn: { paddingHorizontal: 8, paddingVertical: 6 },
  eyeText: { color: C.cyan, fontSize: 12, fontWeight: '600' },
  error: { color: C.danger, fontSize: 13, marginTop: 2 },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 6 },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  guestBtn: { alignItems: 'center', paddingVertical: 10 },
  guestText: { color: C.muted, fontSize: 13, textDecorationLine: 'underline' },
});
