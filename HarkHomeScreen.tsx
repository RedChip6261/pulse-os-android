/*
 * Pulse OS — Hark Pro Home (Personal OS) & Projects Workspaces Screen
 * Features:
 * - Ambient Time-of-Day Greeting & Weather Header
 * - Proactive Action Cards (one-tap Handoff² browser tasks, briefings, inbox triage, dismissible)
 * - Custom Live Panels ("Build a new panel" from natural language prompts: Expense Trackers, Habit Checklists, AI Radar Feeds)
 * - Projects Workspaces (Inbox Zero, Creator Studio, Smart Shopping, + New Project) with isolated tasks & notes
 */
import React, { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  buildPanelFromPrompt,
  CustomPanel,
  DEFAULT_PROACTIVE_CARDS,
  loadCustomPanels,
  loadDismissedCards,
  loadProjects,
  ProactiveCard,
  ProjectWorkspace,
  saveCustomPanels,
  saveDismissedCards,
  saveProjects,
} from './src/harkPanels';

const C = {
  bg: '#090C12',
  surface: '#111622',
  surface2: '#182032',
  border: '#1F293B',
  text: '#F8FAFC',
  muted: '#8B9BB4',
  accent: '#6366F1',
  accentSoft: 'rgba(99, 102, 241, 0.16)',
  cyan: '#38BDF8',
  good: '#10B981',
  warn: '#F59E0B',
  danger: '#EF4444',
};

export default function HarkHomeScreen({
  userName,
  onRunChatPrompt,
  onRunHandoffTask,
  onOpenAppsLauncher,
}: {
  userName?: string;
  onRunChatPrompt: (prompt: string) => void;
  onRunHandoffTask: (goal: string) => void;
  onOpenAppsLauncher: () => void;
}) {
  const [subTab, setSubTab] = useState<'HOME' | 'PROJECTS'>('HOME');
  const [panels, setPanels] = useState<CustomPanel[]>([]);
  const [projects, setProjects] = useState<ProjectWorkspace[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>('proj-inbox');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [panelPrompt, setPanelPrompt] = useState('');
  const [buildingPanel, setBuildingPanel] = useState(false);
  const [entryLabel, setEntryLabel] = useState<Record<string, string>>({});
  const [entryVal, setEntryVal] = useState<Record<string, string>>({});
  const [addingToPanel, setAddingToPanel] = useState<string | null>(null);
  const [newProjName, setNewProjName] = useState('');
  const [newProjDesc, setNewProjDesc] = useState('');
  const [creatingProj, setCreatingProj] = useState(false);
  const [newTaskText, setNewTaskText] = useState('');
  const [newNoteText, setNewNoteText] = useState('');

  useEffect(() => {
    Promise.all([loadCustomPanels(), loadProjects(), loadDismissedCards()]).then(([p, pr, d]) => {
      setPanels(p);
      setProjects(pr);
      if (pr[0]) setActiveProjectId(pr[0].id);
      setDismissed(d);
    });
  }, []);

  const updatePanels = (next: CustomPanel[]) => {
    setPanels(next);
    saveCustomPanels(next);
  };

  const updateProjects = (next: ProjectWorkspace[]) => {
    setProjects(next);
    saveProjects(next);
  };

  const dismissCard = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    saveDismissedCards(next);
  };

  const resetProactiveCards = () => {
    setDismissed([]);
    saveDismissedCards([]);
  };

  const handleCardAction = (card: ProactiveCard) => {
    if (card.kind === 'handoff') {
      onRunHandoffTask(card.prompt);
    } else if (card.kind === 'project') {
      setSubTab('PROJECTS');
    } else {
      onRunChatPrompt(card.prompt);
    }
  };

  const handleCreatePanel = () => {
    const p = panelPrompt.trim();
    if (!p) return;
    const created = buildPanelFromPrompt(p);
    updatePanels([created, ...panels]);
    setPanelPrompt('');
    setBuildingPanel(false);
  };

  const toggleChecklistItem = (panelId: string, itemId: string) => {
    const next = panels.map((pan) => {
      if (pan.id !== panelId) return pan;
      return {
        ...pan,
        items: pan.items.map((it) =>
          it.id === itemId ? { ...it, done: !it.done, value: !it.done ? 'Done' : 'Pending' } : it,
        ),
      };
    });
    updatePanels(next);
  };

  const addPanelItem = (panelId: string) => {
    const lbl = (entryLabel[panelId] || '').trim();
    const val = (entryVal[panelId] || '').trim();
    if (!lbl) return;
    const next = panels.map((pan) => {
      if (pan.id !== panelId) return pan;
      return {
        ...pan,
        items: [
          ...pan.items,
          {
            id: `it-${Date.now().toString(36)}`,
            label: lbl,
            value: val || (pan.type === 'tracker' ? '100' : 'Pending'),
            done: false,
          },
        ],
      };
    });
    updatePanels(next);
    setEntryLabel((prev) => ({ ...prev, [panelId]: '' }));
    setEntryVal((prev) => ({ ...prev, [panelId]: '' }));
    setAddingToPanel(null);
  };

  const deletePanel = (panelId: string) => {
    updatePanels(panels.filter((p) => p.id !== panelId));
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = userName ? userName.split(' ')[0] : '';
  const visibleCards = DEFAULT_PROACTIVE_CARDS.filter((c) => !dismissed.includes(c.id));
  const activeProject = projects.find((p) => p.id === activeProjectId) || projects[0];

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: C.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* Sub-navigation bar: Home OS · Projects · Phone Apps */}
      <View style={s.topSwitchRow}>
        <View style={s.segWrap}>
          <Pressable onPress={() => setSubTab('HOME')} style={[s.segBtn, subTab === 'HOME' && s.segBtnOn]}>
            <Text style={[s.segText, subTab === 'HOME' && s.segTextOn]}>✦ Home OS</Text>
          </Pressable>
          <Pressable onPress={() => setSubTab('PROJECTS')} style={[s.segBtn, subTab === 'PROJECTS' && s.segBtnOn]}>
            <Text style={[s.segText, subTab === 'PROJECTS' && s.segTextOn]}>🗂 Projects ({projects.length})</Text>
          </Pressable>
        </View>
        <Pressable onPress={onOpenAppsLauncher} style={s.appsBtn}>
          <Text style={s.appsBtnText}>📱 Phone Apps</Text>
        </Pressable>
      </View>

      {subTab === 'HOME' ? (
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          {/* Ambient Header */}
          <View style={s.ambientCard}>
            <View style={s.rowBetween}>
              <View style={{ flex: 1 }}>
                <Text style={s.ambientBadge}>PULSE PERSONAL OS · LIVE</Text>
                <Text style={s.ambientTitle}>
                  {greeting}{firstName ? `, ${firstName}` : ''}
                </Text>
                <Text style={s.ambientSub}>
                  Proactive cards, live custom panels, and Handoff² autonomous browser ready.
                </Text>
              </View>
              <View style={s.weatherPill}>
                <Text style={{ fontSize: 18 }}>☀️</Text>
                <Text style={s.weatherText}>29°C</Text>
              </View>
            </View>
          </View>

          {/* Proactive Cards Section */}
          <View style={s.secHeader}>
            <Text style={s.secTitle}>Proactive Actions</Text>
            {dismissed.length > 0 && (
              <Pressable onPress={resetProactiveCards}>
                <Text style={s.linkText}>Restore all</Text>
              </Pressable>
            )}
          </View>

          {visibleCards.map((card) => (
            <View key={card.id} style={s.proCard}>
              <View style={s.rowBetween}>
                <Text style={s.proBadge}>{card.badge}</Text>
                <Pressable onPress={() => dismissCard(card.id)} hitSlop={8}>
                  <Text style={s.dismissText}>✕</Text>
                </Pressable>
              </View>
              <Text style={s.proTitle}>{card.title}</Text>
              <Text style={s.proSub}>{card.subtitle}</Text>
              <View style={[s.row, { gap: 8, marginTop: 10 }]}>
                <Pressable onPress={() => handleCardAction(card)} style={s.proActionBtn}>
                  <Text style={s.proActionText}>{card.actionLabel} →</Text>
                </Pressable>
              </View>
            </View>
          ))}

          {/* Custom Panels Section (Hark Pro signature feature) */}
          <View style={[s.secHeader, { marginTop: 6 }]}>
            <Text style={s.secTitle}>Live Panels</Text>
            <Pressable onPress={() => setBuildingPanel((v) => !v)} style={s.buildPill}>
              <Text style={s.buildPillText}>{buildingPanel ? 'Cancel' : '+ Build a new panel'}</Text>
            </Pressable>
          </View>

          {buildingPanel && (
            <View style={[s.panelCard, { borderColor: C.cyan }]}>
              <Text style={s.panelTitle}>Build a new panel</Text>
              <Text style={s.proSub}>
                Describe what you want to see (e.g. "Daily coffee & food spend", "Morning gym & coding habits", "Robotics & AI news radar").
              </Text>
              <TextInput
                value={panelPrompt}
                onChangeText={setPanelPrompt}
                placeholder="Describe your custom panel…"
                placeholderTextColor={C.muted}
                style={[s.input, { marginTop: 8 }]}
                onSubmitEditing={handleCreatePanel}
              />
              <Pressable onPress={handleCreatePanel} style={[s.proActionBtn, { marginTop: 8, alignSelf: 'flex-start' }]}>
                <Text style={s.proActionText}>Generate Live Panel ✦</Text>
              </Pressable>
            </View>
          )}

          {panels.map((pan) => {
            const total =
              pan.type === 'tracker'
                ? pan.items.reduce((acc, it) => acc + (parseFloat(it.value.replace(/[^0-9.]/g, '')) || 0), 0)
                : 0;
            return (
              <View key={pan.id} style={s.panelCard}>
                <View style={s.rowBetween}>
                  <View style={[s.row, { gap: 8, flex: 1 }]}>
                    <Text style={{ fontSize: 18 }}>{pan.icon}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.panelTitle} numberOfLines={1}>
                        {pan.title}
                      </Text>
                      <Text style={s.panelSub}>{pan.subtitle}</Text>
                    </View>
                  </View>
                  <View style={[s.row, { gap: 8 }]}>
                    {pan.type === 'tracker' && (
                      <View style={s.totalBadge}>
                        <Text style={s.totalBadgeText}>
                          {pan.unit || '₹'}
                          {total.toLocaleString()}
                        </Text>
                      </View>
                    )}
                    <Pressable onPress={() => setAddingToPanel(addingToPanel === pan.id ? null : pan.id)} style={s.iconSmallBtn}>
                      <Text style={s.iconSmallText}>+</Text>
                    </Pressable>
                    <Pressable onPress={() => deletePanel(pan.id)} hitSlop={8}>
                      <Text style={s.dismissText}>✕</Text>
                    </Pressable>
                  </View>
                </View>

                <View style={{ marginTop: 10, gap: 6 }}>
                  {pan.items.map((it) => (
                    <Pressable
                      key={it.id}
                      onPress={() => {
                        if (pan.type === 'checklist') toggleChecklistItem(pan.id, it.id);
                        else if (pan.type === 'feed') onRunChatPrompt(it.label);
                      }}
                      style={s.panelItemRow}
                    >
                      <Text style={[s.panelItemLabel, it.done && { textDecorationLine: 'line-through', color: C.muted }]} numberOfLines={1}>
                        {pan.type === 'checklist' ? (it.done ? '☑ ' : '☐ ') : '• '}
                        {it.label}
                      </Text>
                      <Text style={[s.panelItemVal, it.done && { color: C.good }]}>
                        {pan.type === 'tracker' ? `${pan.unit || '₹'}${it.value}` : it.value}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {addingToPanel === pan.id && (
                  <View style={[s.row, { gap: 6, marginTop: 10 }]}>
                    <TextInput
                      value={entryLabel[pan.id] || ''}
                      onChangeText={(t) => setEntryLabel((p) => ({ ...p, [pan.id]: t }))}
                      placeholder={pan.type === 'tracker' ? 'Item (e.g. Lunch)' : 'New item…'}
                      placeholderTextColor={C.muted}
                      style={[s.input, { flex: 1, paddingVertical: 7 }]}
                    />
                    {pan.type === 'tracker' && (
                      <TextInput
                        value={entryVal[pan.id] || ''}
                        onChangeText={(t) => setEntryVal((p) => ({ ...p, [pan.id]: t }))}
                        placeholder="Amount"
                        placeholderTextColor={C.muted}
                        keyboardType="numeric"
                        style={[s.input, { width: 82, paddingVertical: 7 }]}
                      />
                    )}
                    <Pressable onPress={() => addPanelItem(pan.id)} style={s.proActionBtn}>
                      <Text style={s.proActionText}>Add</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      ) : (
        /* PROJECTS WORKSPACE VIEW */
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.secHeader}>
            <Text style={s.secTitle}>Focused Project Workspaces</Text>
            <Pressable onPress={() => setCreatingProj((v) => !v)} style={s.buildPill}>
              <Text style={s.buildPillText}>{creatingProj ? 'Cancel' : '+ New Project'}</Text>
            </Pressable>
          </View>

          {creatingProj && (
            <View style={[s.panelCard, { borderColor: C.cyan }]}>
              <Text style={s.panelTitle}>Create Project Workspace</Text>
              <TextInput
                value={newProjName}
                onChangeText={setNewProjName}
                placeholder="Project name (e.g. Q4 Product Launch)"
                placeholderTextColor={C.muted}
                style={[s.input, { marginTop: 8 }]}
              />
              <TextInput
                value={newProjDesc}
                onChangeText={setNewProjDesc}
                placeholder="Goal & context…"
                placeholderTextColor={C.muted}
                style={[s.input, { marginTop: 8 }]}
              />
              <Pressable
                onPress={() => {
                  if (!newProjName.trim()) return;
                  const p: ProjectWorkspace = {
                    id: `proj-${Date.now().toString(36)}`,
                    name: newProjName.trim(),
                    icon: '🚀',
                    description: newProjDesc.trim() || 'Dedicated project workspace',
                    notes: [],
                    tasks: [],
                    updatedAt: Date.now(),
                  };
                  const next = [p, ...projects];
                  updateProjects(next);
                  setActiveProjectId(p.id);
                  setNewProjName('');
                  setNewProjDesc('');
                  setCreatingProj(false);
                }}
                style={[s.proActionBtn, { marginTop: 8, alignSelf: 'flex-start' }]}
              >
                <Text style={s.proActionText}>Create Project</Text>
              </Pressable>
            </View>
          )}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {projects.map((p) => {
              const on = p.id === activeProject?.id;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => setActiveProjectId(p.id)}
                  style={[s.projChip, on && s.projChipOn]}
                >
                  <Text style={s.projChipText}>
                    {p.icon} {p.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {activeProject && (
            <View style={s.panelCard}>
              <Text style={s.ambientTitle}>
                {activeProject.icon} {activeProject.name}
              </Text>
              <Text style={[s.proSub, { marginTop: 4 }]}>{activeProject.description}</Text>

              <View style={[s.row, { gap: 8, marginTop: 12, flexWrap: 'wrap' }]}>
                <Pressable
                  onPress={() => onRunChatPrompt(`Working on project "${activeProject.name}": ${activeProject.description}. Help me with the next steps.`)}
                  style={s.proActionBtn}
                >
                  <Text style={s.proActionText}>💬 Open in Chat</Text>
                </Pressable>
                <Pressable
                  onPress={() => onRunHandoffTask(`Research ${activeProject.name} online`)}
                  style={[s.proActionBtn, { backgroundColor: C.surface2, borderWidth: 1, borderColor: C.cyan }]}
                >
                  <Text style={[s.proActionText, { color: C.cyan }]}>🌐 Run Handoff² Research</Text>
                </Pressable>
              </View>

              {/* Project Tasks */}
              <Text style={[s.secTitle, { marginTop: 16, fontSize: 13 }]}>Project Action Items</Text>
              <View style={{ gap: 6, marginTop: 6 }}>
                {activeProject.tasks.map((t) => (
                  <Pressable
                    key={t.id}
                    onPress={() => {
                      const next = projects.map((pr) =>
                        pr.id !== activeProject.id
                          ? pr
                          : { ...pr, tasks: pr.tasks.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)) },
                      );
                      updateProjects(next);
                    }}
                    style={s.panelItemRow}
                  >
                    <Text style={[s.panelItemLabel, t.done && { textDecorationLine: 'line-through', color: C.muted }]}>
                      {t.done ? '☑ ' : '☐ '}
                      {t.text}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <View style={[s.row, { gap: 6, marginTop: 8 }]}>
                <TextInput
                  value={newTaskText}
                  onChangeText={setNewTaskText}
                  placeholder="Add project task…"
                  placeholderTextColor={C.muted}
                  style={[s.input, { flex: 1, paddingVertical: 7 }]}
                />
                <Pressable
                  onPress={() => {
                    if (!newTaskText.trim()) return;
                    const next = projects.map((pr) =>
                      pr.id !== activeProject.id
                        ? pr
                        : { ...pr, tasks: [...pr.tasks, { id: `t-${Date.now()}`, text: newTaskText.trim(), done: false }] },
                    );
                    updateProjects(next);
                    setNewTaskText('');
                  }}
                  style={s.proActionBtn}
                >
                  <Text style={s.proActionText}>Add</Text>
                </Pressable>
              </View>

              {/* Project Knowledge & Context Notes */}
              <Text style={[s.secTitle, { marginTop: 16, fontSize: 13 }]}>Saved Context & Notes</Text>
              <View style={{ gap: 6, marginTop: 6 }}>
                {activeProject.notes.map((n, idx) => (
                  <View key={idx} style={s.panelItemRow}>
                    <Text style={s.panelItemLabel}>📌 {n}</Text>
                  </View>
                ))}
              </View>
              <View style={[s.row, { gap: 6, marginTop: 8 }]}>
                <TextInput
                  value={newNoteText}
                  onChangeText={setNewNoteText}
                  placeholder="Save a rule, link, or note to this project…"
                  placeholderTextColor={C.muted}
                  style={[s.input, { flex: 1, paddingVertical: 7 }]}
                />
                <Pressable
                  onPress={() => {
                    if (!newNoteText.trim()) return;
                    const next = projects.map((pr) =>
                      pr.id !== activeProject.id ? pr : { ...pr, notes: [...pr.notes, newNoteText.trim()] },
                    );
                    updateProjects(next);
                    setNewNoteText('');
                  }}
                  style={s.proActionBtn}
                >
                  <Text style={s.proActionText}>Save</Text>
                </Pressable>
              </View>
            </View>
          )}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  topSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 8,
  },
  segWrap: {
    flexDirection: 'row',
    backgroundColor: C.surface,
    borderRadius: 12,
    padding: 3,
    borderWidth: 1,
    borderColor: C.border,
  },
  segBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 9 },
  segBtnOn: { backgroundColor: C.accent },
  segText: { color: C.muted, fontSize: 12, fontWeight: '600' },
  segTextOn: { color: '#fff', fontWeight: '700' },
  appsBtn: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  appsBtnText: { color: C.text, fontSize: 12, fontWeight: '600' },
  scroll: { padding: 14, gap: 12, paddingBottom: 36 },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ambientCard: {
    backgroundColor: C.surface,
    borderRadius: 16,
    padding: 15,
    borderWidth: 1,
    borderColor: C.border,
  },
  ambientBadge: { color: C.cyan, fontSize: 10, fontWeight: '800', letterSpacing: 0.8, marginBottom: 4 },
  ambientTitle: { color: C.text, fontSize: 20, fontWeight: '700' },
  ambientSub: { color: C.muted, fontSize: 12, marginTop: 4, lineHeight: 17 },
  weatherPill: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface2,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: C.border,
  },
  weatherText: { color: C.text, fontSize: 12, fontWeight: '700', marginTop: 2 },
  secHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  secTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  linkText: { color: C.cyan, fontSize: 12, fontWeight: '600' },
  proCard: {
    backgroundColor: C.surface,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1,
    borderColor: C.border,
  },
  proBadge: { color: C.cyan, fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  dismissText: { color: C.muted, fontSize: 13, fontWeight: '700', paddingHorizontal: 4 },
  proTitle: { color: C.text, fontSize: 15, fontWeight: '700', marginTop: 4 },
  proSub: { color: C.muted, fontSize: 12, marginTop: 3, lineHeight: 17 },
  proActionBtn: {
    backgroundColor: C.accent,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  proActionText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  buildPill: {
    backgroundColor: C.accentSoft,
    borderWidth: 1,
    borderColor: C.accent,
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
  },
  buildPillText: { color: C.text, fontSize: 11, fontWeight: '700' },
  panelCard: {
    backgroundColor: C.surface,
    borderRadius: 15,
    padding: 13,
    borderWidth: 1,
    borderColor: C.border,
  },
  panelTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  panelSub: { color: C.muted, fontSize: 11, marginTop: 1 },
  totalBadge: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderColor: C.good,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
  },
  totalBadgeText: { color: C.good, fontSize: 12, fontWeight: '800' },
  iconSmallBtn: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconSmallText: { color: C.text, fontSize: 15, fontWeight: '700' },
  panelItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.surface2,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
  },
  panelItemLabel: { color: C.text, fontSize: 13, flex: 1, marginRight: 8 },
  panelItemVal: { color: C.cyan, fontSize: 12, fontWeight: '700' },
  input: {
    backgroundColor: C.surface2,
    color: C.text,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 13,
    borderWidth: 1,
    borderColor: C.border,
  },
  projChip: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  projChipOn: { borderColor: C.cyan, backgroundColor: 'rgba(56, 189, 248, 0.15)' },
  projChipText: { color: C.text, fontSize: 13, fontWeight: '600' },
});
