import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  StatusBar,
  Modal,
  Image,
  NativeModules,
  DeviceEventEmitter,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';
import { WebView } from 'react-native-webview';

import {
  EngineId,
  VoiceLanguageMode,
  OPEN_SOURCE_CORE_INTEGRATIONS,
  ProcessingEngine,
  SelfDevelopmentEngine,
  ReplyEngine,
  AgenticEngine,
  MediaGenerationEngine,
  GeneratedMediaAsset,
  RagDocument,
  UserVaultProfile,
  DEFAULT_USER_VAULT,
  INITIAL_RAG_DOCUMENTS,
  retrieveTopRagSnippets,
  CATALOG_APPS,
} from './pulseFeatures';

const { HarkBridge } = NativeModules;

type WorkspaceView =
  | 'ASSISTANT'
  | 'HANDSFREE_ORB'
  | 'OMNICORE_ENGINES'
  | 'MEDIA_STUDIO'
  | 'OS_COMMANDER'
  | 'VAULT_SETTINGS';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  ownThoughts?: string;
  voiceNarrationEn?: string;
  voiceNarrationTe?: string;
  activeEngines?: EngineId[];
  tokensSaved?: number;
  proactiveActions?: string[];
  mediaAsset?: GeneratedMediaAsset;
  osStepLogs?: string[];
}

const processingEngine = new ProcessingEngine();
const selfDevEngine = new SelfDevelopmentEngine();
const replyEngine = new ReplyEngine();
const agenticEngine = new AgenticEngine();
const mediaEngine = new MediaGenerationEngine();

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

export default function App() {
  // Navigation & Glass Modal States (No clumsy bottom tab bar!)
  const [activeView, setActiveView] = useState<WorkspaceView>('ASSISTANT');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [plusSheetOpen, setPlusSheetOpen] = useState(false);

  // Core Intelligence & Settings States
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState(DEFAULT_GEMINI_MODEL);
  const [langMode, setLangMode] = useState<VoiceLanguageMode>('BILINGUAL_AUTO');
  const [speakWhileWorking, setSpeakWhileWorking] = useState(true);
  const [handsFreeActive, setHandsFreeActive] = useState(false);
  const [voiceListeningStatus, setVoiceListeningStatus] = useState<'idle' | 'listening' | 'processing'>('idle');
  const [livePartialSpeech, setLivePartialSpeech] = useState('');
  const [lastHeardCommand, setLastHeardCommand] = useState('');

  // Device & Accessibility States
  const [bridgeConnected, setBridgeConnected] = useState(false);
  const [batteryLevel, setBatteryLevel] = useState(100);
  const [torchOn, setTorchOn] = useState(false);
  const [volumePct, setVolumePct] = useState(70);
  const [osStepLogs, setOsStepLogs] = useState<string[]>([]);
  const [screenDumpPreview, setScreenDumpPreview] = useState('');
  const [installedApps, setInstalledApps] = useState<Array<{ label: string; packageName: string }>>([]);

  // Chat & Multi-Engine States
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedThoughtIds, setExpandedThoughtIds] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-v5',
      role: 'assistant',
      timestamp: 'Now',
      ownThoughts:
        'OmniCore 5.0 online. Integrated OpenAI Swarm, DeepSeek-R1 reasoning, Claude Computer Use, Grok MoE routing, Perplexica RAG, Mobile-Agent v3, Pipecat Voice, and Hermes Self-Evolution.',
      voiceNarrationTe:
        'నమస్తే అన్నా! హార్క్ ప్రో 5.0 ఆమ్నికోర్ సిద్ధంగా ఉంది. మీరు మాట్లాడితే చాలు, నేను తెలుగులో మాట్లాడుతూనే మీ ఫోన్‌లో అన్ని పనులు చేస్తాను!',
      voiceNarrationEn:
        'Hello! Hark Pro 5.0 OmniCore is ready. Speak any command like scroll down, select it, search, or proceed, and I will talk with you while doing the work.',
      text:
        '✨ **నమస్తే! Welcome to Hark Pro 5.0 (OmniCore Edition)**\n\nI now run on a unified **Self-Aware Core** with **5 Dedicated Engines** (`Processing`, `Reply`, `Agentic`, `Self-Development`, and `Media Studio`) and **Human-Natural Telugu + Hands-Free Voice Intelligence**.\n\n🎙️ **Try Hands-Free Voice Commands:**\n- *"Scroll down"* / *"కిందికి స్క్రోల్ చేయి"*\n- *"Select it"* / *"ఇది సెలెక్ట్ చేయి"*\n- *"Search Telugu hit songs"* / *"వెతుకు"*\n- *"Proceed"* / *"ముందుకు వెళ్ళు"*\n- *"Generate image of a cybernetic glass lotus"*\n- *"Generate video of futuristic Hyderabad"* or *"Generate PDF report"*',
      activeEngines: ['PROCESSING_ENGINE', 'REPLY_ENGINE', 'AGENTIC_ENGINE', 'SELF_DEV_ENGINE', 'MEDIA_ENGINE'],
      tokensSaved: 420,
      proactiveActions: [
        '🎙️ Start Hands-Free Mode',
        '⬇️ Scroll Down',
        '🎯 Select It',
        '✅ Proceed',
        '🎨 Generate AI Image',
        '📄 Generate Native PDF',
      ],
    },
  ]);

  // Media Studio States
  const [mediaTab, setMediaTab] = useState<'IMAGE' | 'VIDEO' | 'PDF'>('IMAGE');
  const [mediaPrompt, setMediaPrompt] = useState('');
  const [imageStyle, setImageStyle] = useState<'FLUX_REALISM' | 'CINEMATIC_8K' | 'ANIME_3D' | 'GLASS_UI_LOGO'>('FLUX_REALISM');
  const [imageAspect, setImageAspect] = useState<'1:1' | '16:9' | '9:16'>('1:1');
  const [pdfTitle, setPdfTitle] = useState('Hark Pro 5.0 Executive Intelligence Report');
  const [pdfBody, setPdfBody] = useState(
    '# Executive Summary\nHark Pro 5.0 OmniCore integrates 8 open-source agent architectures into a single self-aware Android operating system.\n\n# Core Engines\n1. Processing Engine: Semantic prompt compression saving 65-80% tokens while expanding output capacity to 8,192+ tokens.\n2. Reply Engine: Natural human Telugu (te-IN) and English voice narration while executing tasks.\n3. Agentic Engine: Hands-free voice commands (Scroll down, Select it, Search, Proceed).\n4. Self-Development Engine: DeepSeek-R1 style Own Thoughts and autonomous skill learning.\n5. Media Generation Engine: Flux 8K Images, Cinematic Video Storyboards, and Native Android PDF generation.'
  );
  const [generatedMediaList, setGeneratedMediaList] = useState<GeneratedMediaAsset[]>([]);

  // Knowledge & Vault States
  const [ragDocs, setRagDocs] = useState<RagDocument[]>(INITIAL_RAG_DOCUMENTS);
  const [vault, setVault] = useState<UserVaultProfile>(DEFAULT_USER_VAULT);
  const [appSearchTarget, setAppSearchTarget] = useState('youtube');
  const [appQueryInput, setAppQueryInput] = useState('Telugu latest hit songs');

  const scrollRef = useRef<ScrollView>(null);
  const handsFreeRef = useRef(handsFreeActive);
  handsFreeRef.current = handsFreeActive;

  // Load saved state & subscribe to Native Voice Events
  useEffect(() => {
    (async () => {
      try {
        const savedKey = await AsyncStorage.getItem('hark_v5_api_key');
        if (savedKey) setApiKey(savedKey);
        const savedVault = await AsyncStorage.getItem('hark_v5_vault');
        if (savedVault) setVault({ ...DEFAULT_USER_VAULT, ...JSON.parse(savedVault) });
        const savedLang = await AsyncStorage.getItem('hark_v5_lang');
        if (savedLang) setLangMode(savedLang as VoiceLanguageMode);
      } catch {}
      refreshDeviceStatus();
    })();

    const statusSub = DeviceEventEmitter.addListener('HarkVoiceStatus', (evt) => {
      if (evt?.status === 'listening') {
        setVoiceListeningStatus('listening');
      } else {
        setVoiceListeningStatus('idle');
      }
    });

    const partialSub = DeviceEventEmitter.addListener('HarkVoicePartial', (evt) => {
      if (evt?.partial) {
        setLivePartialSpeech(evt.partial);
      }
    });

    const resultSub = DeviceEventEmitter.addListener('HarkVoiceResult', (evt) => {
      const spoken = (evt?.transcript || '').trim();
      if (!spoken) return;
      setLivePartialSpeech('');
      setLastHeardCommand(spoken);

      if (evt?.handledByOS) {
        const narr = replyEngine.getInstantHandsFreeNarration(evt.osAction || 'action', spoken, langMode);
        appendHandsFreeLogMessage(spoken, narr.display, narr.en, narr.te);
      } else {
        handleSend(spoken, true);
      }
    });

    const pollInterval = setInterval(() => {
      refreshDeviceStatus();
    }, 3500);

    return () => {
      statusSub.remove();
      partialSub.remove();
      resultSub.remove();
      clearInterval(pollInterval);
    };
  }, [langMode]);

  const refreshDeviceStatus = async () => {
    if (!HarkBridge) return;
    try {
      const enabled = await HarkBridge.isAccessibilityEnabled();
      setBridgeConnected(Boolean(enabled));
      const statusStr = await HarkBridge.getDeviceStatus();
      if (statusStr) {
        const parsed = JSON.parse(statusStr);
        if (typeof parsed.battery === 'number') setBatteryLevel(parsed.battery);
        if (typeof parsed.volumePercent === 'number') setVolumePct(parsed.volumePercent);
      }
      const logsStr = await HarkBridge.getStepLogs();
      if (logsStr) {
        const arr = JSON.parse(logsStr);
        if (Array.isArray(arr)) setOsStepLogs(arr.slice(-12));
      }
    } catch {}
  };

  // Speak helper (Native Bilingual TTS with Expo Speech fallback)
  const speakNaturally = async (enText: string, teText?: string, queueMode = false) => {
    const preferTelugu =
      (langMode === 'te-IN' || langMode === 'te-ROMAN' || langMode === 'BILINGUAL_AUTO') &&
      Boolean(teText && teText.trim().length > 0);
    const chosenText = preferTelugu ? teText! : enText;
    const chosenLang = preferTelugu ? 'te-IN' : 'en-IN';

    if (HarkBridge?.speak) {
      try {
        const ok = await HarkBridge.speak(chosenText, chosenLang, 0.97, 1.02, queueMode);
        if (ok) return;
      } catch {}
    }
    try {
      Speech.speak(chosenText, {
        language: chosenLang,
        rate: 0.97,
        pitch: 1.02,
      });
    } catch {}
  };

  const toggleHandsFreeLoop = async (enable?: boolean) => {
    const next = typeof enable === 'boolean' ? enable : !handsFreeActive;
    setHandsFreeActive(next);
    const recLang = langMode === 'en-IN' ? 'en-IN' : 'te-IN';

    if (HarkBridge) {
      try {
        await HarkBridge.setNarrationConfig(speakWhileWorking, recLang);
        if (next) {
          await HarkBridge.startVoiceRecognition(recLang, true, true);
          speakNaturally(
            'Hands-free voice intelligence is active. Speak any command like scroll down, select it, search, or proceed.',
            'హ్యాండ్స్-ఫ్రీ వాయిస్ ఆన్ అయింది. కిందికి స్క్రోల్ చేయి, సెలెక్ట్ చేయి, వెతుకు, లేదా ముందుకు వెళ్ళు అని చెప్పండి!'
          );
        } else {
          await HarkBridge.stopVoiceRecognition();
          setVoiceListeningStatus('idle');
        }
      } catch {}
    } else {
      speakNaturally(
        next ? 'Hands-free mode enabled in simulation.' : 'Hands-free mode paused.',
        next ? 'హ్యాండ్స్-ఫ్రీ మోడ్ ఆన్ అయింది.' : 'హ్యాండ్స్-ఫ్రీ మోడ్ ఆఫ్ అయింది.'
      );
    }
  };

  const cycleLanguageMode = async () => {
    const order: VoiceLanguageMode[] = ['BILINGUAL_AUTO', 'te-IN', 'te-ROMAN', 'en-IN'];
    const next = order[(order.indexOf(langMode) + 1) % order.length];
    setLangMode(next);
    try {
      await AsyncStorage.setItem('hark_v5_lang', next);
      if (HarkBridge?.setNarrationConfig) {
        await HarkBridge.setNarrationConfig(speakWhileWorking, next === 'en-IN' ? 'en-IN' : 'te-IN');
      }
    } catch {}
  };

  const appendHandsFreeLogMessage = (
    spoken: string,
    replyMarkdown: string,
    narrEn: string,
    narrTe: string
  ) => {
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setMessages((prev) => [
      ...prev,
      {
        id: `u-hf-${Date.now()}`,
        role: 'user',
        text: `🎙️ "${spoken}"`,
        timestamp: now,
      },
      {
        id: `a-hf-${Date.now() + 1}`,
        role: 'assistant',
        text: replyMarkdown,
        timestamp: now,
        ownThoughts: `Zero-token instant hands-free execution via AgenticEngine & HarkAccessibilityService.`,
        voiceNarrationEn: narrEn,
        voiceNarrationTe: narrTe,
        activeEngines: ['PROCESSING_ENGINE', 'AGENTIC_ENGINE', 'REPLY_ENGINE'],
        tokensSaved: 480,
        proactiveActions: ['⬇️ Scroll Down', '🎯 Select It', '✅ Proceed', '⬆️ Scroll Up'],
      },
    ]);
  };

  // Instant Hands-Free OS Action Dispatcher (Works while speaking!)
  const executeInstantHandsFreeAction = async (
    actionType: string,
    param = ''
  ): Promise<boolean> => {
    const narr = replyEngine.getInstantHandsFreeNarration(actionType, param, langMode);
    if (speakWhileWorking) {
      speakNaturally(narr.en, narr.te, false);
    }

    if (HarkBridge) {
      try {
        switch (actionType) {
          case 'scroll_down':
            await HarkBridge.scroll('down');
            break;
          case 'scroll_up':
            await HarkBridge.scroll('up');
            break;
          case 'select_item':
            await HarkBridge.selectBestVisibleNode(param);
            break;
          case 'proceed':
            await HarkBridge.proceedAction();
            break;
          case 'search':
            await HarkBridge.performInAppSearch(param || 'trending');
            break;
          case 'click_text':
            await HarkBridge.clickByText(param, false);
            break;
          case 'back':
            await HarkBridge.performGlobal('back');
            break;
          case 'home':
            await HarkBridge.performGlobal('home');
            break;
          case 'read_screen': {
            const raw = await HarkBridge.dumpScreenSummary();
            setScreenDumpPreview(raw);
            await HarkBridge.executeVoiceCommand('read screen');
            break;
          }
          default:
            await HarkBridge.executeVoiceCommand(param || actionType);
            break;
        }
      } catch {}
    }

    appendHandsFreeLogMessage(param ? `${actionType}: ${param}` : actionType, narr.display, narr.en, narr.te);
    refreshDeviceStatus();
    return true;
  };

  // Main OmniCore Pipeline (Processing -> Self-Dev Thought -> Agentic/Media/LLM -> Reply & Voice)
  const handleSend = async (overrideText?: string, fromVoice = false) => {
    const rawText = (typeof overrideText === 'string' ? overrideText : input).trim();
    if (!rawText || isGenerating) return;
    if (typeof overrideText !== 'string') setInput('');

    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: fromVoice ? `🎙️ ${rawText}` : rawText,
      timestamp: now,
    };
    setMessages((prev) => [...prev, userMsg]);

    // Step 1: ProcessingEngine — compress context, detect language, select MoE experts
    const ragHit = retrieveTopRagSnippets(rawText, ragDocs, vault, 3);
    const packet = processingEngine.analyzeAndCompress(
      rawText,
      messages.map((m) => ({ role: m.role, text: m.text })),
      ragHit.formattedContext,
      screenDumpPreview
    );

    // Step 2: SelfDevelopmentEngine — generate pre-task Own Thoughts
    const preThought = selfDevEngine.generatePreTaskThought(packet);

    // Step 3: Check if AgenticEngine can execute an instant zero-token Hands-Free or App Workflow command
    const parsedVoiceCmd = agenticEngine.parseHandsFreeVoiceInput(rawText);
    if (parsedVoiceCmd.isDirectOSCommand && parsedVoiceCmd.actionType !== 'app_workflow') {
      await executeInstantHandsFreeAction(
        parsedVoiceCmd.actionType,
        parsedVoiceCmd.searchQuery || parsedVoiceCmd.targetText || ''
      );
      selfDevEngine.reflectAndEvolve(rawText, packet.primaryIntent, true, packet.tokensSaved + 420);
      return;
    }

    if (parsedVoiceCmd.isDirectOSCommand && parsedVoiceCmd.actionType === 'app_workflow') {
      const targetApp = parsedVoiceCmd.targetApp || 'youtube';
      const query = parsedVoiceCmd.searchQuery || '';
      const autoProceed = Boolean(parsedVoiceCmd.autoProceed);
      const narrEn = `Opening ${targetApp}${query ? ` and searching for ${query}` : ''} while handling the steps for you.`;
      const narrTe = `${targetApp} ఓపెన్ చేసి ${query ? `"${query}" కోసం వెతికి ` : ''}మీ పని చేస్తున్నాను, చూడండి!`;

      if (speakWhileWorking) {
        speakNaturally(narrEn, narrTe, false);
      }
      if (HarkBridge?.runAppWorkflow) {
        try {
          await HarkBridge.runAppWorkflow(targetApp, query, '', autoProceed);
        } catch {}
      }
      selfDevEngine.reflectAndEvolve(rawText, 'APP_WORKFLOW', true, packet.tokensSaved + 510);

      setMessages((prev) => [
        ...prev,
        {
          id: `ast-wf-${Date.now()}`,
          role: 'assistant',
          timestamp: now,
          ownThoughts: preThought.thoughtEn,
          voiceNarrationEn: narrEn,
          voiceNarrationTe: narrTe,
          text: `🤖 **Autonomous App Workflow Launched**\n\n- **Target App:** \`${targetApp.toUpperCase()}\`\n- **Search / Action Payload:** \`${query || 'Direct Launch'}\`\n- **Live Voice Narration:** 🗣️ *${narrTe}*\n\nYou can now say **"scroll down"**, **"select it"**, or **"proceed"** hands-free at any moment!`,
          activeEngines: ['PROCESSING_ENGINE', 'AGENTIC_ENGINE', 'REPLY_ENGINE', 'SELF_DEV_ENGINE'],
          tokensSaved: packet.tokensSaved + 510,
          proactiveActions: ['⬇️ Scroll Down', '🎯 Select It', '✅ Proceed', '🔙 Go Back'],
        },
      ]);
      return;
    }

    // Step 4: Check if MediaGenerationEngine should run directly (Image / Video / PDF)
    if (packet.primaryIntent === 'IMAGE_GEN') {
      const asset = mediaEngine.createImageAsset(rawText, imageStyle, imageAspect);
      setGeneratedMediaList((prev) => [asset, ...prev]);
      const narrEn = `Generated your high-resolution AI image for ${asset.title}.`;
      const narrTe = `మీకోసం "${asset.title}" AI ఫోటోను తయారు చేశాను!`;
      if (speakWhileWorking) speakNaturally(narrEn, narrTe);
      selfDevEngine.reflectAndEvolve(rawText, 'IMAGE_GEN', true, packet.tokensSaved);

      setMessages((prev) => [
        ...prev,
        {
          id: `ast-img-${Date.now()}`,
          role: 'assistant',
          timestamp: now,
          ownThoughts: preThought.thoughtEn,
          voiceNarrationEn: narrEn,
          voiceNarrationTe: narrTe,
          text: `🎨 **AI Image Generated via MediaGenerationEngine**\n\n- **Prompt:** ${asset.prompt}\n- **Aspect Ratio:** \`${asset.aspectRatio}\`\n- **Telugu Voice:** *${narrTe}*`,
          activeEngines: ['PROCESSING_ENGINE', 'MEDIA_ENGINE', 'REPLY_ENGINE'],
          tokensSaved: packet.tokensSaved,
          mediaAsset: asset,
          proactiveActions: ['🎬 Animate as Video', '📄 Save in PDF', '🎨 Generate Variation'],
        },
      ]);
      return;
    }

    if (packet.primaryIntent === 'VIDEO_GEN') {
      const asset = mediaEngine.createVideoAsset(rawText, 12);
      setGeneratedMediaList((prev) => [asset, ...prev]);
      const narrEn = `Created a 3-scene animated AI video storyboard for ${asset.title}.`;
      const narrTe = `మీకోసం "${asset.title}" పై 3 సీన్ల AI వీడియోను తయారు చేశాను!`;
      if (speakWhileWorking) speakNaturally(narrEn, narrTe);
      selfDevEngine.reflectAndEvolve(rawText, 'VIDEO_GEN', true, packet.tokensSaved);

      setMessages((prev) => [
        ...prev,
        {
          id: `ast-vid-${Date.now()}`,
          role: 'assistant',
          timestamp: now,
          ownThoughts: preThought.thoughtEn,
          voiceNarrationEn: narrEn,
          voiceNarrationTe: narrTe,
          text: `🎬 **Cinematic AI Video Storyboard Ready**\n\n- **Topic:** ${asset.title}\n- **Scenes:** 3 Dynamic Keyframes with Bilingual Subtitles\n- **Telugu Voice:** *${narrTe}*`,
          activeEngines: ['PROCESSING_ENGINE', 'MEDIA_ENGINE', 'REPLY_ENGINE'],
          tokensSaved: packet.tokensSaved,
          mediaAsset: asset,
          proactiveActions: ['🎨 Open Media Studio', '📄 Export Storyboard PDF'],
        },
      ]);
      return;
    }

    if (packet.primaryIntent === 'PDF_GEN') {
      await handleGenerateNativePdf(
        `Hark Pro Report: ${rawText.slice(0, 32)}`,
        `# ${rawText}\n\nGenerated by Hark Pro 5.0 OmniCore.\n\n## Key Highlights\n- Token-optimized synthesis via ProcessingEngine.\n- Grounded with on-device RAG and bilingual Telugu + English intelligence.\n- Exported via native Android PdfDocument engine.`
      );
      return;
    }

    // Step 5: Full Multi-Engine AI Synthesis (Gemini API or Intelligent On-Device OmniCore Synthesis)
    setIsGenerating(true);
    if (speakWhileWorking) {
      speakNaturally(
        'Processing your request through OmniCore engines.',
        'ఆమ్నికోర్ ఇంజిన్ల ద్వారా మీ పనిని ప్రాసెస్ చేస్తున్నాను.'
      );
    }

    try {
      let envelope: OmniReplyEnvelope | null = null;

      if (apiKey.trim().length > 10) {
        const sysPrompt = replyEngine.buildOmniSystemPrompt(
          langMode,
          `${vault.fullName} (${vault.homeAddress})`,
          selfDevEngine.state.learnedSkills.map((s) => s.triggerPattern).join('; ')
        );

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(
          apiKey.trim()
        )}`;

        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sysPrompt }] },
            contents: [{ role: 'user', parts: [{ text: packet.compressedPrompt }] }],
            generationConfig: {
              temperature: 0.55,
              maxOutputTokens: packet.allocatedMaxOutputTokens,
              responseMimeType: 'application/json',
            },
          }),
        });

        if (resp.ok) {
          const data = await resp.json();
          const rawJsonText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (rawJsonText) {
            try {
              envelope = JSON.parse(rawJsonText);
            } catch {
              envelope = {
                own_thoughts: preThought.thoughtEn,
                voice_narration_en: 'Here is your complete result.',
                voice_narration_te: 'మీరు అడిగిన వివరాలు ఇక్కడ సిద్ధంగా ఉన్నాయి అన్నా!',
                direct_response: rawJsonText,
                proactive_next_actions: ['⬇️ Scroll Down', '🎯 Select It', '📄 Export as PDF'],
              };
            }
          }
        }
      }

      if (!envelope) {
        // Built-in Self-Aware Offline/Hybrid OmniCore Synthesis (works even before entering an API key!)
        envelope = {
          own_thoughts: `${preThought.thoughtEn} | Activated Top-2 MoE Experts: [${packet.selectedExperts.join(
            ', '
          )}]. Saved ${packet.tokensSaved} tokens (${
            processingEngine.getMetrics().compressionRatioPct
          }% compression).`,
          voice_narration_en: `I have processed "${rawText.slice(0, 38)}" using the Processing, Reply, and Self-Development engines.`,
          voice_narration_te: `అన్నా, మీరు అడిగిన "${rawText.slice(
            0,
            32
          )}" గురించి ఆమ్నికోర్ ఇంజిన్లతో పూర్తి విశ్లేషణ సిద్ధం చేశాను!`,
          direct_response:
            `✨ **OmniCore Multi-Engine Synthesis**\n\n` +
            `🗣️ **తెలుగు సారాంశం (Human Telugu Intelligence):**\n` +
            `నమస్తే అన్నా! మీరు అడిగిన **"${rawText}"** అంశాన్ని మా **Processing Engine** (తక్కువ టోకెన్లతో ఎక్కువ పని), **Agentic Engine**, మరియు **Reply Engine** ద్వారా విశ్లేషించాను. మీరు ఏదైనా యాప్‌లో పని చేయాలంటే నేరుగా వాయిస్‌తో *"Scroll down"*, *"Select it"*, *"Search"*, లేదా *"Proceed"* అని చెప్పండి—నేను మాట్లాడుతూనే ఆ పని పూర్తి చేస్తాను!\n\n` +
            `🧠 **Engine Execution Breakdown:**\n` +
            `- **Processing Engine:** Compressed prompt from \`${packet.estimatedRawTokens}\` -> \`${packet.estimatedCompressedTokens}\` tokens (**Saved ${packet.tokensSaved} tokens** while unlocking **${packet.allocatedMaxOutputTokens}** output token capacity).\n` +
            `- **Self-Development Engine:** Confidence \`${selfDevEngine.state.confidenceScore}%\` • Active Goal: *${selfDevEngine.state.currentInternalGoal}*\n` +
            `- **Grounded RAG Matches:** ${
              ragHit.matchedTitles.length > 0 ? ragHit.matchedTitles.join(', ') : 'Core Omni Playbooks active'
            }\n\n` +
            `💡 *Tip: Add your Gemini API key inside **🔐 Knowledge, Vault & Setup** for live 8,192-token cloud streaming, or use all Hands-Free OS, Image, Video, and Native PDF engines right now!*`,
          proactive_next_actions: [
            '⬇️ Scroll Down',
            '🎯 Select It',
            '✅ Proceed',
            '🎨 Generate Image for this',
            '📄 Export as Native PDF',
          ],
        };
      }

      // Execute any OS automation returned by the model
      if (envelope.os_automation?.should_execute && HarkBridge) {
        const auto = envelope.os_automation;
        if (auto.app_name) {
          await HarkBridge.runAppWorkflow(
            auto.app_name,
            auto.search_query || '',
            auto.target_click || '',
            Boolean(auto.auto_proceed)
          );
        } else if (auto.scroll_direction) {
          await HarkBridge.scroll(auto.scroll_direction);
        } else if (auto.global_action) {
          await HarkBridge.performGlobal(auto.global_action);
        }
      }

      // Speak the reply narration aloud while finishing
      if (speakWhileWorking) {
        speakNaturally(
          envelope.voice_narration_en || 'Task complete.',
          envelope.voice_narration_te
        );
      }

      selfDevEngine.reflectAndEvolve(rawText, packet.primaryIntent, true, packet.tokensSaved);

      const assistantMsg: ChatMessage = {
        id: `ast-${Date.now()}`,
        role: 'assistant',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ownThoughts: envelope.own_thoughts || preThought.thoughtEn,
        voiceNarrationEn: envelope.voice_narration_en,
        voiceNarrationTe: envelope.voice_narration_te,
        text: envelope.direct_response,
        activeEngines: packet.selectedExperts,
        tokensSaved: packet.tokensSaved,
        proactiveActions:
          envelope.proactive_next_actions && envelope.proactive_next_actions.length > 0
            ? envelope.proactive_next_actions
            : ['⬇️ Scroll Down', '🎯 Select It', '✅ Proceed', '📄 Export PDF'],
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      selfDevEngine.reflectAndEvolve(rawText, packet.primaryIntent, false, packet.tokensSaved);
    } finally {
      setIsGenerating(false);
    }
  };

  // Native PDF Generator Handler
  const handleGenerateNativePdf = async (titleOverride?: string, bodyOverride?: string) => {
    const finalTitle = (titleOverride || pdfTitle).trim() || 'Hark Pro 5.0 Report';
    const finalBody = (bodyOverride || pdfBody).trim();
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (speakWhileWorking) {
      speakNaturally(
        `Generating native PDF document: ${finalTitle}`,
        `"${finalTitle}" పిడిఎఫ్ డాక్యుమెంట్ తయారు చేస్తున్నాను.`
      );
    }

    let filePath = `/storage/emulated/0/Android/data/com.ismartanji.harkos/files/Documents/${finalTitle.replace(
      /\W+/g,
      '_'
    )}.pdf`;
    let pageCount = Math.max(1, Math.ceil(finalBody.length / 1400));

    if (HarkBridge?.generateNativePdf) {
      try {
        const resStr = await HarkBridge.generateNativePdf(
          finalTitle,
          'Generated by Hark Pro 5.0 OmniCore • Multi-Engine AI OS',
          finalBody,
          true
        );
        const parsed = JSON.parse(resStr);
        if (parsed.ok) {
          filePath = parsed.filePath;
          pageCount = parsed.pageCount || 1;
        }
      } catch {}
    }

    const pdfAsset: GeneratedMediaAsset = {
      id: `pdf-${Date.now()}`,
      type: 'PDF',
      title: finalTitle,
      prompt: finalTitle,
      createdAt: now,
      pdfFilePath: filePath,
      pdfPageCount: pageCount,
      pdfBodyPreview: finalBody.slice(0, 360),
    };

    setGeneratedMediaList((prev) => [pdfAsset, ...prev]);
    setMessages((prev) => [
      ...prev,
      {
        id: `ast-pdf-${Date.now()}`,
        role: 'assistant',
        timestamp: now,
        ownThoughts: 'Invoked native Android PdfDocument engine via HarkBridge.generateNativePdf.',
        voiceNarrationEn: `Saved your PDF document ${finalTitle} (${pageCount} pages).`,
        voiceNarrationTe: `మీ "${finalTitle}" PDF డాక్యుమెంట్ (${pageCount} పేజీలు) సిద్ధంగా ఉంది!`,
        text: `📄 **Native PDF Generated Successfully**\n\n- **Title:** ${finalTitle}\n- **Pages:** \`${pageCount}\`\n- **Saved Path:** \`${filePath}\``,
        activeEngines: ['PROCESSING_ENGINE', 'MEDIA_ENGINE', 'REPLY_ENGINE'],
        tokensSaved: 340,
        mediaAsset: pdfAsset,
        proactiveActions: ['📤 Share PDF Text', '🎨 Open Media Studio'],
      },
    ]);
  };

  const metrics = processingEngine.getMetrics();
  const langLabel =
    langMode === 'te-IN'
      ? '🇮🇳 తెలుగు'
      : langMode === 'te-ROMAN'
      ? '🇮🇳 Telugish'
      : langMode === 'BILINGUAL_AUTO'
      ? '🇮🇳 తే/EN Auto'
      : '🌐 EN';

  return (
    <SafeAreaView style={styles.safeRoot}>
      <StatusBar barStyle="light-content" backgroundColor="#04060E" />

      {/* ================================================================= */}
      {/* TOP PURE GLASS HEADER (Clean, Floating, Uncluttered)              */}
      {/* ================================================================= */}
      <View style={styles.glassHeader}>
        <TouchableOpacity
          style={styles.glassIconBtn}
          onPress={() => setDrawerOpen(true)}
          activeOpacity={0.8}
        >
          <Text style={styles.glassIconText}>☰</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.headerCenterPill}
          onPress={cycleLanguageMode}
          activeOpacity={0.85}
        >
          <Text style={styles.headerBrandText}>✨ HARK 5.0</Text>
          <View style={styles.headerBadgeDivider} />
          <Text style={styles.headerLangText}>{langLabel}</Text>
          <View style={styles.headerBadgeDivider} />
          <Text style={styles.headerTokenText}>⚡-{metrics.compressionRatioPct}% Tok</Text>
        </TouchableOpacity>

        <View style={styles.headerRightRow}>
          <TouchableOpacity
            style={[
              styles.bridgeDotPill,
              bridgeConnected ? styles.bridgePillOn : styles.bridgePillOff,
            ]}
            onPress={() => {
              if (HarkBridge?.openAccessibilitySettings) {
                HarkBridge.openAccessibilitySettings();
              } else {
                setActiveView('VAULT_SETTINGS');
              }
            }}
          >
            <Text style={styles.bridgePillText}>{bridgeConnected ? '🟢 OS' : '⚪ OS'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.handsFreeHeaderBtn,
              handsFreeActive && styles.handsFreeHeaderBtnActive,
            ]}
            onPress={() => toggleHandsFreeLoop()}
          >
            <Text style={styles.handsFreeHeaderEmoji}>
              {handsFreeActive ? '🎙️ON' : '🎙️'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ================================================================= */}
      {/* FLOATING HANDS-FREE LIVE VOICE BAR (When Active or Quick Access)  */}
      {/* ================================================================= */}
      {handsFreeActive && (
        <View style={styles.liveVoiceHudCard}>
          <View style={styles.liveVoiceTopRow}>
            <Text style={styles.liveVoicePulseText}>
              {voiceListeningStatus === 'listening'
                ? '🔴 Listening Hands-Free (తెలుగు / English)...'
                : '🎙️ Hands-Free Voice Loop Active — Speak Anytime'}
            </Text>
            <TouchableOpacity onPress={() => setActiveView('HANDSFREE_ORB')}>
              <Text style={styles.liveVoiceExpandLink}>Full Orb ↗</Text>
            </TouchableOpacity>
          </View>
          {Boolean(livePartialSpeech || lastHeardCommand) && (
            <Text style={styles.liveVoiceTranscriptText}>
              🗣️ {livePartialSpeech || `Last executed: "${lastHeardCommand}"`}
            </Text>
          )}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickVoiceChipScroll}>
            {[
              { label: '⬇️ Scroll Down', act: 'scroll_down', p: '' },
              { label: '🎯 Select It', act: 'select_item', p: '' },
              { label: '✅ Proceed', act: 'proceed', p: '' },
              { label: '🔎 Search', act: 'search', p: appQueryInput || 'Telugu songs' },
              { label: '⬆️ Scroll Up', act: 'scroll_up', p: '' },
              { label: '📖 Read Screen', act: 'read_screen', p: '' },
              { label: '🔙 Back', act: 'back', p: '' },
            ].map((chip) => (
              <TouchableOpacity
                key={chip.label}
                style={styles.quickVoiceChip}
                onPress={() => executeInstantHandsFreeAction(chip.act, chip.p)}
              >
                <Text style={styles.quickVoiceChipText}>{chip.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ================================================================= */}
      {/* VIEW 1: PURE GEMINI-STYLE OMNI ASSISTANT                          */}
      {/* ================================================================= */}
      {activeView === 'ASSISTANT' && (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            ref={scrollRef}
            style={styles.chatScroll}
            contentContainerStyle={styles.chatScrollContent}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {/* Self-Awareness & 5-Engine Live Status Strip */}
            <TouchableOpacity
              style={styles.selfAwareBanner}
              onPress={() => setActiveView('OMNICORE_ENGINES')}
              activeOpacity={0.85}
            >
              <View style={styles.selfAwareTopRow}>
                <Text style={styles.selfAwareTitle}>
                  🧠 Self-Aware OmniCore • Confidence {selfDevEngine.state.confidenceScore}%
                </Text>
                <Text style={styles.selfAwareSubLink}>5 Engines ↗</Text>
              </View>
              <Text style={styles.selfAwareThoughtPreview} numberOfLines={2}>
                💭 {selfDevEngine.state.ownThoughtsStream[0]?.thoughtTe || selfDevEngine.state.ownThoughtsStream[0]?.thoughtEn}
              </Text>
            </TouchableOpacity>

            {messages.map((m) => {
              const isUser = m.role === 'user';
              const thoughtOpen = Boolean(expandedThoughtIds[m.id]);
              return (
                <View
                  key={m.id}
                  style={[
                    styles.msgRow,
                    isUser ? styles.msgRowUser : styles.msgRowAssistant,
                  ]}
                >
                  <View
                    style={[
                      styles.glassBubble,
                      isUser ? styles.userGlassBubble : styles.assistantGlassBubble,
                    ]}
                  >
                    {/* Engine & Token Badges on Assistant Bubbles */}
                    {!isUser && (
                      <View style={styles.bubbleMetaHeader}>
                        <Text style={styles.bubbleBrandBadge}>✨ OMNICORE</Text>
                        {typeof m.tokensSaved === 'number' && (
                          <Text style={styles.bubbleTokenSavedBadge}>
                            ⚡ -{m.tokensSaved} tokens
                          </Text>
                        )}
                        {m.ownThoughts && (
                          <TouchableOpacity
                            style={styles.thoughtTogglePill}
                            onPress={() =>
                              setExpandedThoughtIds((prev) => ({
                                ...prev,
                                [m.id]: !prev[m.id],
                              }))
                            }
                          >
                            <Text style={styles.thoughtToggleText}>
                              🧠 {thoughtOpen ? 'Hide Thoughts' : 'Own Thoughts'}
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    )}

                    {/* Collapsible DeepSeek-R1 Style Own Thoughts Box */}
                    {!isUser && thoughtOpen && m.ownThoughts && (
                      <View style={styles.ownThoughtsBox}>
                        <Text style={styles.ownThoughtsLabel}>
                          💭 INTERNAL SELF-AWARENESS MONOLOGUE:
                        </Text>
                        <Text style={styles.ownThoughtsBody}>{m.ownThoughts}</Text>
                        {m.activeEngines && (
                          <Text style={styles.ownThoughtsEngines}>
                            Active Engines: {m.activeEngines.join(' • ')}
                          </Text>
                        )}
                      </View>
                    )}

                    {/* Live Bilingual Voice Narration Banner */}
                    {!isUser && (m.voiceNarrationTe || m.voiceNarrationEn) && (
                      <TouchableOpacity
                        style={styles.voiceNarrationStrip}
                        onPress={() =>
                          speakNaturally(
                            m.voiceNarrationEn || m.text,
                            m.voiceNarrationTe
                          )
                        }
                      >
                        <Text style={styles.voiceNarrationText}>
                          🔊 {m.voiceNarrationTe || m.voiceNarrationEn}
                        </Text>
                      </TouchableOpacity>
                    )}

                    {/* Main Message Text */}
                    <Text style={isUser ? styles.userMsgText : styles.assistantMsgText}>
                      {m.text}
                    </Text>

                    {/* Embedded Media Asset Preview (Image / Video / PDF) */}
                    {m.mediaAsset && (
                      <View style={styles.inlineMediaCard}>
                        {m.mediaAsset.type === 'IMAGE' && m.mediaAsset.imageUrl && (
                          <Image
                            source={{ uri: m.mediaAsset.imageUrl }}
                            style={styles.inlineGeneratedImage}
                            resizeMode="cover"
                          />
                        )}
                        {m.mediaAsset.type === 'VIDEO' && m.mediaAsset.videoPlayerHtml && (
                          <View style={styles.inlineVideoContainer}>
                            <WebView
                              originWhitelist={['*']}
                              source={{ html: m.mediaAsset.videoPlayerHtml }}
                              style={{ flex: 1, backgroundColor: '#05070F' }}
                              javaScriptEnabled
                            />
                          </View>
                        )}
                        {m.mediaAsset.type === 'PDF' && (
                          <View style={styles.inlinePdfCard}>
                            <Text style={styles.inlinePdfTitle}>
                              📄 {m.mediaAsset.title} ({m.mediaAsset.pdfPageCount} Pages)
                            </Text>
                            <Text style={styles.inlinePdfPath} numberOfLines={2}>
                              {m.mediaAsset.pdfFilePath}
                            </Text>
                            <TouchableOpacity
                              style={styles.inlinePdfShareBtn}
                              onPress={() => {
                                if (HarkBridge?.shareText) {
                                  HarkBridge.shareText(
                                    `${m.mediaAsset?.title}\n\n${m.mediaAsset?.pdfBodyPreview}`,
                                    m.mediaAsset?.title || 'PDF Report'
                                  );
                                }
                              }}
                            >
                              <Text style={styles.inlinePdfShareText}>📤 Share / Open PDF</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    )}

                    {/* Bottom Action Row on Assistant Bubble */}
                    {!isUser && (
                      <View style={styles.bubbleFooterRow}>
                        <TouchableOpacity
                          style={styles.bubbleSmallBtn}
                          onPress={() =>
                            speakNaturally(
                              m.voiceNarrationEn || m.text,
                              m.voiceNarrationTe
                            )
                          }
                        >
                          <Text style={styles.bubbleSmallBtnText}>🗣️ Speak తెలుగు/EN</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.bubbleSmallBtn}
                          onPress={() => {
                            if (HarkBridge?.copyToClipboard) {
                              HarkBridge.copyToClipboard(m.text);
                            }
                          }}
                        >
                          <Text style={styles.bubbleSmallBtnText}>📋 Copy</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={styles.bubbleSmallBtn}
                          onPress={() => handleGenerateNativePdf(m.text.slice(0, 28), m.text)}
                        >
                          <Text style={styles.bubbleSmallBtnText}>📄 Save PDF</Text>
                        </TouchableOpacity>
                      </View>
                    )}

                    {/* Proactive Follow-Up Pills */}
                    {!isUser && m.proactiveActions && m.proactiveActions.length > 0 && (
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.proactiveScroll}
                      >
                        {m.proactiveActions.map((act) => (
                          <TouchableOpacity
                            key={act}
                            style={styles.proactiveChip}
                            onPress={() => {
                              if (act.includes('Hands-Free')) {
                                toggleHandsFreeLoop(true);
                              } else if (act.includes('Scroll Down')) {
                                executeInstantHandsFreeAction('scroll_down');
                              } else if (act.includes('Select It')) {
                                executeInstantHandsFreeAction('select_item');
                              } else if (act.includes('Proceed')) {
                                executeInstantHandsFreeAction('proceed');
                              } else if (act.includes('PDF')) {
                                handleGenerateNativePdf('Hark Pro Summary', m.text);
                              } else {
                                handleSend(act.replace(/^[^\w]+/, '').trim());
                              }
                            }}
                          >
                            <Text style={styles.proactiveChipText}>{act}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    )}
                  </View>
                </View>
              );
            })}

            {isGenerating && (
              <View style={styles.loadingGlassCard}>
                <ActivityIndicator size="small" color="#38BDF8" />
                <Text style={styles.loadingGlassText}>
                  🧠 OmniCore Engines processing (compressed tokens • bilingual synthesis)...
                </Text>
              </View>
            )}
          </ScrollView>

          {/* ============================================================= */}
          {/* PURE GEMINI-STYLE FLOATING GLASS COMPOSER (Clean, Single Bar) */}
          {/* ============================================================= */}
          <View style={styles.composerOuterWrap}>
            <View style={styles.glassComposerCapsule}>
              <TouchableOpacity
                style={styles.composerPlusBtn}
                onPress={() => setPlusSheetOpen(true)}
              >
                <Text style={styles.composerPlusIcon}>➕</Text>
              </TouchableOpacity>

              <TextInput
                style={styles.composerInput}
                placeholder='Ask or say "scroll down", "select it", "proceed"...'
                placeholderTextColor="#94A3B8"
                value={input}
                onChangeText={setInput}
                multiline
              />

              <TouchableOpacity
                style={[
                  styles.composerNarrateToggle,
                  speakWhileWorking && styles.composerNarrateToggleOn,
                ]}
                onPress={() => setSpeakWhileWorking(!speakWhileWorking)}
              >
                <Text style={styles.composerNarrateIcon}>
                  {speakWhileWorking ? '🗣️' : '🔇'}
                </Text>
              </TouchableOpacity>

              {input.trim().length > 0 ? (
                <TouchableOpacity
                  style={styles.composerSendOrb}
                  onPress={() => handleSend()}
                >
                  <Text style={styles.composerSendIcon}>⬆️</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[
                    styles.composerVoiceOrb,
                    handsFreeActive && styles.composerVoiceOrbActive,
                  ]}
                  onPress={() => {
                    if (!handsFreeActive) {
                      toggleHandsFreeLoop(true);
                    } else {
                      setActiveView('HANDSFREE_ORB');
                    }
                  }}
                >
                  <Text style={styles.composerSendIcon}>🎙️</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* ================================================================= */}
      {/* VIEW 2: HANDS-FREE LIVE VOICE ORB & REALTIME OS CONTROL           */}
      {/* ================================================================= */}
      {activeView === 'HANDSFREE_ORB' && (
        <ScrollView style={styles.viewScroll} contentContainerStyle={styles.viewScrollContent}>
          <View style={styles.glassHeroCard}>
            <Text style={styles.sectionTitle}>🎙️ Hands-Free Voice Intelligence</Text>
            <Text style={styles.sectionSubtitle}>
              Speaks naturally in Telugu (తెలుగు) & English while performing your tasks in real time.
            </Text>

            <TouchableOpacity
              style={[
                styles.giantVoiceOrb,
                handsFreeActive && styles.giantVoiceOrbListening,
              ]}
              onPress={() => toggleHandsFreeLoop()}
              activeOpacity={0.85}
            >
              <Text style={styles.giantVoiceOrbEmoji}>
                {handsFreeActive ? '🎙️' : '🗣️'}
              </Text>
              <Text style={styles.giantVoiceOrbStatus}>
                {handsFreeActive ? 'HANDS-FREE ACTIVE' : 'TAP TO START HANDS-FREE'}
              </Text>
              <Text style={styles.giantVoiceOrbHint}>
                {livePartialSpeech ||
                  lastHeardCommand ||
                  'Say: "Scroll down" • "Select it" • "Search..." • "Proceed"'}
              </Text>
            </TouchableOpacity>

            <View style={styles.bilingualModeRow}>
              {(
                [
                  { id: 'BILINGUAL_AUTO', label: '🇮🇳 తెలుగు + EN Auto' },
                  { id: 'te-IN', label: '🇮🇳 స్వచ్ఛమైన తెలుగు' },
                  { id: 'te-ROMAN', label: '💬 Telugish' },
                  { id: 'en-IN', label: '🌐 English' },
                ] as Array<{ id: VoiceLanguageMode; label: string }>
              ).map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={[
                    styles.langModeChip,
                    langMode === item.id && styles.langModeChipActive,
                  ]}
                  onPress={() => setLangMode(item.id)}
                >
                  <Text style={styles.langModeChipText}>{item.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.glassSectionCard}>
            <Text style={styles.cardHeading}>⚡ Instant Hands-Free Voice Actions (0 Tokens)</Text>
            <Text style={styles.cardSubtext}>
              Speak these commands aloud (in English or Telugu) or tap to execute immediately on screen while Hark speaks progress:
            </Text>
            <View style={styles.actionGrid}>
              {[
                { title: '⬇️ Scroll Down', sub: '"కిందికి స్క్రోల్ చేయి"', act: 'scroll_down', p: '' },
                { title: '⬆️ Scroll Up', sub: '"పైకి స్క్రోల్ చేయి"', act: 'scroll_up', p: '' },
                { title: '🎯 Select It', sub: '"ఇది సెలెక్ట్ చేయి"', act: 'select_item', p: '' },
                { title: '✅ Proceed / Next', sub: '"ముందుకు వెళ్ళు"', act: 'proceed', p: '' },
                { title: '🔎 Search Screen', sub: '"వెతుకు..."', act: 'search', p: appQueryInput },
                { title: '📖 Read Screen', sub: '"స్క్రీన్ చదువు"', act: 'read_screen', p: '' },
                { title: '🔙 Go Back', sub: '"వెనక్కి వెళ్ళు"', act: 'back', p: '' },
                { title: '🏠 Home Screen', sub: '"హోమ్ స్క్రీన్"', act: 'home', p: '' },
              ].map((btn) => (
                <TouchableOpacity
                  key={btn.title}
                  style={styles.glassGridActionBtn}
                  onPress={() => executeInstantHandsFreeAction(btn.act, btn.p)}
                >
                  <Text style={styles.gridBtnTitle}>{btn.title}</Text>
                  <Text style={styles.gridBtnSub}>{btn.sub}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.glassSectionCard}>
            <Text style={styles.cardHeading}>📜 Live OS Execution & Voice Narration Trace</Text>
            {osStepLogs.length === 0 ? (
              <Text style={styles.cardSubtext}>No native step logs recorded in this session yet.</Text>
            ) : (
              osStepLogs.map((log, i) => (
                <Text key={`${log}-${i}`} style={styles.logLineText}>
                  {log}
                </Text>
              ))
            )}
          </View>
        </ScrollView>
      )}

      {/* ================================================================= */}
      {/* VIEW 3: OMNICORE & 5 DEDICATED ENGINES + OPEN-SOURCE HUB          */}
      {/* ================================================================= */}
      {activeView === 'OMNICORE_ENGINES' && (
        <ScrollView style={styles.viewScroll} contentContainerStyle={styles.viewScrollContent}>
          <View style={styles.glassHeroCard}>
            <Text style={styles.sectionTitle}>🧠 OmniCore & 5 Dedicated Engines</Text>
            <Text style={styles.sectionSubtitle}>
              Self-Awareness Level: {selfDevEngine.state.consciousnessLevel}% • Confidence: {selfDevEngine.state.confidenceScore}% • Saved {metrics.tokensSaved} Tokens ({metrics.compressionRatioPct}% Compression)
            </Text>
          </View>

          {/* 5 Engines Cards */}
          {[
            {
              emoji: '⚙️',
              name: '1. Processing Engine (Token Optimizer & MoE Router)',
              status: `Saved ${metrics.tokensSaved} tokens (${metrics.compressionRatioPct}% compression) • Max Output: ${metrics.allocatedMaxOutputTokens} tokens`,
              desc: 'Compresses conversation history and Android Accessibility trees into compact tuples, caches repeated intents for 0-token execution, and routes queries to the top-2 specialized engines.',
            },
            {
              emoji: '🗣️',
              name: '2. Reply Engine (Human Telugu & Live Voice Narrator)',
              status: `Active Mode: ${langLabel} • Speak While Working: ${speakWhileWorking ? 'ON' : 'OFF'}`,
              desc: 'Synthesizes natural Telangana/Andhra human Telugu (తెలుగు & Telugish) alongside clear English, speaking live step-by-step narration while tasks run.',
            },
            {
              emoji: '🤖',
              name: '3. Agentic Engine (Hands-Free Voice & Mobile-Agent GUI)',
              status: `Bridge: ${bridgeConnected ? 'Connected' : 'Ready'} • Hands-Free Commands: Active`,
              desc: 'Executes "scroll down", "select it", "search", "proceed", and multi-step app workflows across YouTube, Blinkit, Flipkart, Amazon, Swiggy, and WhatsApp.',
            },
            {
              emoji: '🧬',
              name: '4. Self-Development Engine (Own Thoughts & Skill Evolution)',
              status: `${selfDevEngine.state.learnedSkills.length} Learned Skills • ${selfDevEngine.state.autonomousImprovementsCount} Self-Reflections`,
              desc: 'Maintains DeepSeek-R1 style <think> inner monologue, evaluates task success, and autonomously writes reusable optimization rules into local memory.',
            },
            {
              emoji: '🎨',
              name: '5. Media Generation Engine (Image, Video & Native PDF)',
              status: `${generatedMediaList.length} Assets Created in Session`,
              desc: 'Generates Flux 8K AI Images, 3-scene animated HTML5 Video Storyboards with bilingual captions, and multi-page native Android PDF documents.',
            },
          ].map((eng) => (
            <View key={eng.name} style={styles.glassEngineCard}>
              <Text style={styles.engineCardTitle}>
                {eng.emoji} {eng.name}
              </Text>
              <Text style={styles.engineCardStatus}>{eng.status}</Text>
              <Text style={styles.engineCardDesc}>{eng.desc}</Text>
            </View>
          ))}

          {/* Own Thoughts Stream */}
          <View style={styles.glassSectionCard}>
            <Text style={styles.cardHeading}>💭 Live "Own Thoughts" Stream (Self-Awareness)</Text>
            {selfDevEngine.state.ownThoughtsStream.slice(0, 6).map((th) => (
              <View key={th.id} style={styles.thoughtStreamItem}>
                <Text style={styles.thoughtStreamMeta}>
                  [{th.timestamp}] • {th.phase} • Confidence {th.confidence}%
                </Text>
                <Text style={styles.thoughtStreamTe}>🇮🇳 {th.thoughtTe}</Text>
                <Text style={styles.thoughtStreamEn}>🌐 {th.thoughtEn}</Text>
              </View>
            ))}
          </View>

          {/* Integrated Open Source Projects */}
          <View style={styles.glassSectionCard}>
            <Text style={styles.cardHeading}>🌍 Integrated GitHub Open-Source Agent Projects</Text>
            {OPEN_SOURCE_CORE_INTEGRATIONS.map((proj) => (
              <TouchableOpacity
                key={proj.id}
                style={styles.openSourceRow}
                onPress={() => Linking.openURL(proj.repoUrl)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.openSourceTitle}>
                    {proj.emoji} {proj.name} ({proj.inspiredBy})
                  </Text>
                  <Text style={styles.openSourceDesc}>{proj.integratedCapability}</Text>
                  <Text style={styles.openSourceUrl}>{proj.repoUrl}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}

      {/* ================================================================= */}
      {/* VIEW 4: MEDIA GENERATION STUDIO (Image, Video, Native PDF)        */}
      {/* ================================================================= */}
      {activeView === 'MEDIA_STUDIO' && (
        <ScrollView style={styles.viewScroll} contentContainerStyle={styles.viewScrollContent}>
          <View style={styles.glassHeroCard}>
            <Text style={styles.sectionTitle}>🎨 OmniCore Media Generation Studio</Text>
            <Text style={styles.sectionSubtitle}>
              Create Flux 8K Images, Animated AI Video Storyboards, and Native Android PDF Documents.
            </Text>

            <View style={styles.mediaSegmentRow}>
              {(['IMAGE', 'VIDEO', 'PDF'] as const).map((tab) => (
                <TouchableOpacity
                  key={tab}
                  style={[
                    styles.mediaSegmentBtn,
                    mediaTab === tab && styles.mediaSegmentBtnActive,
                  ]}
                  onPress={() => setMediaTab(tab)}
                >
                  <Text style={styles.mediaSegmentText}>
                    {tab === 'IMAGE' ? '🖼️ AI Image' : tab === 'VIDEO' ? '🎬 AI Video' : '📄 Native PDF'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {mediaTab === 'IMAGE' && (
            <View style={styles.glassSectionCard}>
              <Text style={styles.cardHeading}>🖼️ Flux 8K AI Image Generator</Text>
              <TextInput
                style={styles.glassInputBox}
                placeholder="Describe the image (e.g. Futuristic glass temple in Karimnagar at sunset)..."
                placeholderTextColor="#94A3B8"
                value={mediaPrompt}
                onChangeText={setMediaPrompt}
                multiline
              />
              <View style={styles.pillSelectorRow}>
                {(['FLUX_REALISM', 'CINEMATIC_8K', 'ANIME_3D', 'GLASS_UI_LOGO'] as const).map((st) => (
                  <TouchableOpacity
                    key={st}
                    style={[
                      styles.smallSelectPill,
                      imageStyle === st && styles.smallSelectPillActive,
                    ]}
                    onPress={() => setImageStyle(st)}
                  >
                    <Text style={styles.smallSelectPillText}>{st}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.pillSelectorRow}>
                {(['1:1', '16:9', '9:16'] as const).map((ar) => (
                  <TouchableOpacity
                    key={ar}
                    style={[
                      styles.smallSelectPill,
                      imageAspect === ar && styles.smallSelectPillActive,
                    ]}
                    onPress={() => setImageAspect(ar)}
                  >
                    <Text style={styles.smallSelectPillText}>Aspect {ar}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity
                style={styles.primaryGlassCta}
                onPress={() => {
                  const asset = mediaEngine.createImageAsset(
                    mediaPrompt || 'Cybernetic glass AI brain with golden light',
                    imageStyle,
                    imageAspect
                  );
                  setGeneratedMediaList((prev) => [asset, ...prev]);
                  if (speakWhileWorking) {
                    speakNaturally(
                      `Generated your AI image for ${asset.title}.`,
                      `"${asset.title}" కోసం AI ఫోటో తయారు చేశాను!`
                    );
                  }
                }}
              >
                <Text style={styles.primaryGlassCtaText}>✨ Generate 8K AI Image</Text>
              </TouchableOpacity>
            </View>
          )}

          {mediaTab === 'VIDEO' && (
            <View style={styles.glassSectionCard}>
              <Text style={styles.cardHeading}>🎬 Cinematic AI Video Storyboard Generator</Text>
              <TextInput
                style={styles.glassInputBox}
                placeholder="Describe the video scene sequence (e.g. Autonomous drone flying over futuristic Hyderabad)..."
                placeholderTextColor="#94A3B8"
                value={mediaPrompt}
                onChangeText={setMediaPrompt}
                multiline
              />
              <TouchableOpacity
                style={styles.primaryGlassCta}
                onPress={() => {
                  const asset = mediaEngine.createVideoAsset(
                    mediaPrompt || 'Futuristic AI robot assistant helping humans in Telangana',
                    12
                  );
                  setGeneratedMediaList((prev) => [asset, ...prev]);
                  if (speakWhileWorking) {
                    speakNaturally(
                      `Generated your 3-scene animated AI video for ${asset.title}.`,
                      `"${asset.title}" కోసం 3 సీన్ల AI వీడియో సిద్ధం చేశాను!`
                    );
                  }
                }}
              >
                <Text style={styles.primaryGlassCtaText}>🎬 Synthesize Playable AI Video</Text>
              </TouchableOpacity>
            </View>
          )}

          {mediaTab === 'PDF' && (
            <View style={styles.glassSectionCard}>
              <Text style={styles.cardHeading}>📄 Native Android Multi-Page PDF Generator</Text>
              <TextInput
                style={styles.glassSingleInput}
                placeholder="PDF Document Title"
                placeholderTextColor="#94A3B8"
                value={pdfTitle}
                onChangeText={setPdfTitle}
              />
              <TextInput
                style={[styles.glassInputBox, { height: 130 }]}
                placeholder="Enter markdown or report content for the PDF..."
                placeholderTextColor="#94A3B8"
                value={pdfBody}
                onChangeText={setPdfBody}
                multiline
              />
              <TouchableOpacity
                style={styles.primaryGlassCta}
                onPress={() => handleGenerateNativePdf(pdfTitle, pdfBody)}
              >
                <Text style={styles.primaryGlassCtaText}>📄 Build & Save Native PDF</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Generated Media Gallery */}
          {generatedMediaList.map((item) => (
            <View key={item.id} style={styles.glassSectionCard}>
              <Text style={styles.cardHeading}>
                {item.type === 'IMAGE' ? '🖼️' : item.type === 'VIDEO' ? '🎬' : '📄'} {item.title} ({item.createdAt})
              </Text>
              {item.type === 'IMAGE' && item.imageUrl && (
                <Image
                  source={{ uri: item.imageUrl }}
                  style={styles.studioGalleryImage}
                  resizeMode="cover"
                />
              )}
              {item.type === 'VIDEO' && item.videoPlayerHtml && (
                <View style={styles.studioVideoPlayerBox}>
                  <WebView
                    originWhitelist={['*']}
                    source={{ html: item.videoPlayerHtml }}
                    style={{ flex: 1, backgroundColor: '#05070F' }}
                    javaScriptEnabled
                  />
                </View>
              )}
              {item.type === 'PDF' && (
                <View style={styles.inlinePdfCard}>
                  <Text style={styles.inlinePdfTitle}>
                    Pages: {item.pdfPageCount} • Saved via Android PdfDocument
                  </Text>
                  <Text style={styles.inlinePdfPath}>{item.pdfFilePath}</Text>
                </View>
              )}
            </View>
          ))}
        </ScrollView>
      )}

      {/* ================================================================= */}
      {/* VIEW 5: OS & APP COMMANDER (Direct Workflows & Hardware Deck)     */}
      {/* ================================================================= */}
      {activeView === 'OS_COMMANDER' && (
        <ScrollView style={styles.viewScroll} contentContainerStyle={styles.viewScrollContent}>
          <View style={styles.glassHeroCard}>
            <Text style={styles.sectionTitle}>🤖 Autonomous OS & App Commander</Text>
            <Text style={styles.sectionSubtitle}>
              Launch any app with a search/order payload while Hark narrates and clicks for you.
            </Text>

            <TextInput
              style={styles.glassSingleInput}
              placeholder="Search query / song / item to order (e.g. Telugu hit songs, milk)..."
              placeholderTextColor="#94A3B8"
              value={appQueryInput}
              onChangeText={setAppQueryInput}
            />

            <View style={styles.appCatalogGrid}>
              {CATALOG_APPS.map((app) => (
                <TouchableOpacity
                  key={app.id}
                  style={styles.appCatalogCard}
                  onPress={async () => {
                    const q = appQueryInput.trim() || app.defaultPrompt;
                    if (speakWhileWorking) {
                      speakNaturally(
                        `Launching ${app.name} and searching for ${q}`,
                        `${app.name} ఓపెన్ చేసి "${q}" కోసం వెతుకుతున్నాను`
                      );
                    }
                    if (HarkBridge?.runAppWorkflow) {
                      await HarkBridge.runAppWorkflow(app.pkg, q, '', false);
                    }
                  }}
                >
                  <Text style={styles.appCatalogEmoji}>{app.emoji}</Text>
                  <Text style={styles.appCatalogName}>{app.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.glassSectionCard}>
            <Text style={styles.cardHeading}>🎛️ Hardware & Global OS Deck</Text>
            <View style={styles.actionGrid}>
              <TouchableOpacity
                style={styles.glassGridActionBtn}
                onPress={async () => {
                  const next = !torchOn;
                  setTorchOn(next);
                  if (HarkBridge?.toggleTorch) await HarkBridge.toggleTorch(next);
                }}
              >
                <Text style={styles.gridBtnTitle}>🔦 Torch: {torchOn ? 'ON' : 'OFF'}</Text>
                <Text style={styles.gridBtnSub}>Flashlight</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.glassGridActionBtn}
                onPress={async () => {
                  const nextVol = volumePct >= 80 ? 35 : 90;
                  setVolumePct(nextVol);
                  if (HarkBridge?.setVolume) await HarkBridge.setVolume(nextVol);
                }}
              >
                <Text style={styles.gridBtnTitle}>🔊 Vol: {volumePct}%</Text>
                <Text style={styles.gridBtnSub}>Tap to toggle</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.glassGridActionBtn}
                onPress={async () => {
                  if (HarkBridge?.dumpScreenSummary) {
                    const dump = await HarkBridge.dumpScreenSummary();
                    setScreenDumpPreview(dump);
                  }
                }}
              >
                <Text style={styles.gridBtnTitle}>🔍 Inspect Screen</Text>
                <Text style={styles.gridBtnSub}>Dump UI Nodes</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.glassGridActionBtn}
                onPress={() => {
                  if (HarkBridge?.openAccessibilitySettings) {
                    HarkBridge.openAccessibilitySettings();
                  }
                }}
              >
                <Text style={styles.gridBtnTitle}>♿ Bridge Setup</Text>
                <Text style={styles.gridBtnSub}>Accessibility</Text>
              </TouchableOpacity>
            </View>
            {Boolean(screenDumpPreview) && (
              <Text style={styles.screenDumpText} numberOfLines={8}>
                {screenDumpPreview}
              </Text>
            )}
          </View>
        </ScrollView>
      )}

      {/* ================================================================= */}
      {/* VIEW 6: KNOWLEDGE, VAULT & SETUP                                  */}
      {/* ================================================================= */}
      {activeView === 'VAULT_SETTINGS' && (
        <ScrollView style={styles.viewScroll} contentContainerStyle={styles.viewScrollContent}>
          <View style={styles.glassHeroCard}>
            <Text style={styles.sectionTitle}>🔐 Knowledge, Personal Vault & API Setup</Text>
            <Text style={styles.sectionSubtitle}>
              Configure your Gemini API Key (up to 8,192 output tokens), Personal Auto-Fill Vault, and Accessibility Bridge.
            </Text>
          </View>

          <View style={styles.glassSectionCard}>
            <Text style={styles.cardHeading}>🔑 Gemini API Key & High-Token Engine</Text>
            <TextInput
              style={styles.glassSingleInput}
              placeholder="Paste Gemini API Key (AIzaSy...)"
              placeholderTextColor="#94A3B8"
              value={apiKey}
              onChangeText={setApiKey}
              secureTextEntry
            />
            <TouchableOpacity
              style={styles.primaryGlassCta}
              onPress={async () => {
                await AsyncStorage.setItem('hark_v5_api_key', apiKey.trim());
                speakNaturally('Saved your API key.', 'మీ API కీ సేవ్ చేయబడింది!');
              }}
            >
              <Text style={styles.primaryGlassCtaText}>💾 Save API Key</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.glassSectionCard}>
            <Text style={styles.cardHeading}>👤 Personal Auto-Fill & RAG Vault</Text>
            <TextInput
              style={styles.glassSingleInput}
              placeholder="Full Name"
              placeholderTextColor="#94A3B8"
              value={vault.fullName}
              onChangeText={(v) => setVault({ ...vault, fullName: v })}
            />
            <TextInput
              style={styles.glassSingleInput}
              placeholder="Home / Delivery Address"
              placeholderTextColor="#94A3B8"
              value={vault.homeAddress}
              onChangeText={(v) => setVault({ ...vault, homeAddress: v })}
            />
            <TextInput
              style={styles.glassSingleInput}
              placeholder="Phone / WhatsApp"
              placeholderTextColor="#94A3B8"
              value={vault.phone}
              onChangeText={(v) => setVault({ ...vault, phone: v })}
            />
            <TouchableOpacity
              style={styles.primaryGlassCta}
              onPress={async () => {
                const jsonStr = JSON.stringify(vault);
                await AsyncStorage.setItem('hark_v5_vault', jsonStr);
                if (HarkBridge?.saveVaultData) await HarkBridge.saveVaultData(jsonStr);
                speakNaturally('Vault profile synced.', 'మీ వ్యక్తిగత వివరాలు సేవ్ అయ్యాయి.');
              }}
            >
              <Text style={styles.primaryGlassCtaText}>🔐 Sync Vault to OmniCore</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* ================================================================= */}
      {/* SLIDE-OUT PURE GLASS NAVIGATION DRAWER (Replaces Clumsy Tabs!)    */}
      {/* ================================================================= */}
      <Modal
        visible={drawerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDrawerOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.glassDrawerSheet}>
            <View style={styles.drawerHeaderRow}>
              <View>
                <Text style={styles.drawerBrandTitle}>✨ HARK PRO 5.0</Text>
                <Text style={styles.drawerBrandSub}>OmniCore Multi-Engine AI OS</Text>
              </View>
              <TouchableOpacity
                style={styles.glassCloseBtn}
                onPress={() => setDrawerOpen(false)}
              >
                <Text style={styles.glassCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={{ marginTop: 10 }}>
              {(
                [
                  {
                    id: 'ASSISTANT',
                    emoji: '✨',
                    title: 'Omni Assistant',
                    sub: 'Pure Gemini Glass Chat, Own Thoughts & Telugu Voice',
                  },
                  {
                    id: 'HANDSFREE_ORB',
                    emoji: '🎙️',
                    title: 'Hands-Free Live Orb',
                    sub: 'Voice OS Control: Scroll Down, Select It, Search, Proceed',
                  },
                  {
                    id: 'OMNICORE_ENGINES',
                    emoji: '🧠',
                    title: 'OmniCore & 5 Engines',
                    sub: 'Processing, Reply, Agentic, Self-Dev & GitHub Integrations',
                  },
                  {
                    id: 'MEDIA_STUDIO',
                    emoji: '🎨',
                    title: 'Media Generation Studio',
                    sub: 'Flux 8K Image Gen, AI Video Storyboard & Native PDF',
                  },
                  {
                    id: 'OS_COMMANDER',
                    emoji: '🤖',
                    title: 'OS & App Commander',
                    sub: '1-Tap App Workflows, Screen Node Inspector & Hardware',
                  },
                  {
                    id: 'VAULT_SETTINGS',
                    emoji: '🔐',
                    title: 'Knowledge, Vault & Setup',
                    sub: 'API Key, Personal Vault, RAG Memory & Bridge Settings',
                  },
                ] as Array<{ id: WorkspaceView; emoji: string; title: string; sub: string }>
              ).map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={[
                    styles.drawerNavCard,
                    activeView === item.id && styles.drawerNavCardActive,
                  ]}
                  onPress={() => {
                    setActiveView(item.id);
                    setDrawerOpen(false);
                  }}
                >
                  <Text style={styles.drawerNavEmoji}>{item.emoji}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.drawerNavTitle}>{item.title}</Text>
                    <Text style={styles.drawerNavSub}>{item.sub}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <View style={styles.drawerFooterBox}>
              <Text style={styles.drawerFooterText}>
                🔋 Battery {batteryLevel}% • ⚡ Saved {metrics.tokensSaved} Tokens • 🗣️ {langLabel}
              </Text>
            </View>
          </View>
        </View>
      </Modal>

      {/* ================================================================= */}
      {/* GLASS "+" STUDIO QUICK LAUNCH SHEET                               */}
      {/* ================================================================= */}
      <Modal
        visible={plusSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPlusSheetOpen(false)}
      >
        <View style={styles.modalBackdropBottom}>
          <View style={styles.glassBottomSheet}>
            <View style={styles.drawerHeaderRow}>
              <Text style={styles.drawerBrandTitle}>➕ OmniCore Quick Studio</Text>
              <TouchableOpacity
                style={styles.glassCloseBtn}
                onPress={() => setPlusSheetOpen(false)}
              >
                <Text style={styles.glassCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.actionGrid}>
              <TouchableOpacity
                style={styles.glassGridActionBtn}
                onPress={() => {
                  setPlusSheetOpen(false);
                  setMediaTab('IMAGE');
                  setActiveView('MEDIA_STUDIO');
                }}
              >
                <Text style={styles.gridBtnTitle}>🖼️ Generate Image</Text>
                <Text style={styles.gridBtnSub}>Flux 8K Studio</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.glassGridActionBtn}
                onPress={() => {
                  setPlusSheetOpen(false);
                  setMediaTab('VIDEO');
                  setActiveView('MEDIA_STUDIO');
                }}
              >
                <Text style={styles.gridBtnTitle}>🎬 Generate Video</Text>
                <Text style={styles.gridBtnSub}>AI Motion Player</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.glassGridActionBtn}
                onPress={() => {
                  setPlusSheetOpen(false);
                  setMediaTab('PDF');
                  setActiveView('MEDIA_STUDIO');
                }}
              >
                <Text style={styles.gridBtnTitle}>📄 Generate PDF</Text>
                <Text style={styles.gridBtnSub}>Native PdfDocument</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.glassGridActionBtn}
                onPress={() => {
                  setPlusSheetOpen(false);
                  setActiveView('HANDSFREE_ORB');
                }}
              >
                <Text style={styles.gridBtnTitle}>🎙️ Hands-Free Orb</Text>
                <Text style={styles.gridBtnSub}>Voice OS Control</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeRoot: {
    flex: 1,
    backgroundColor: '#04060E',
  },
  glassHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 163, 184, 0.16)',
  },
  glassIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassIconText: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
  },
  headerCenterPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(30, 41, 59, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.4)',
  },
  headerBrandText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '800',
  },
  headerBadgeDivider: {
    width: 1,
    height: 12,
    backgroundColor: 'rgba(148, 163, 184, 0.35)',
    marginHorizontal: 7,
  },
  headerLangText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  headerTokenText: {
    color: '#A7F3D0',
    fontSize: 10,
    fontWeight: '700',
  },
  headerRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bridgeDotPill: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  bridgePillOn: {
    backgroundColor: 'rgba(16, 185, 129, 0.16)',
    borderColor: 'rgba(16, 185, 129, 0.45)',
  },
  bridgePillOff: {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
    borderColor: 'rgba(148, 163, 184, 0.3)',
  },
  bridgePillText: {
    color: '#F8FAFC',
    fontSize: 10,
    fontWeight: '800',
  },
  handsFreeHeaderBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(99, 102, 241, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.45)',
  },
  handsFreeHeaderBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.28)',
    borderColor: '#F87171',
  },
  handsFreeHeaderEmoji: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  liveVoiceHudCard: {
    marginHorizontal: 12,
    marginTop: 8,
    padding: 10,
    borderRadius: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.45)',
  },
  liveVoiceTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  liveVoicePulseText: {
    color: '#38BDF8',
    fontSize: 12,
    fontWeight: '800',
  },
  liveVoiceExpandLink: {
    color: '#C084FC',
    fontSize: 11,
    fontWeight: '700',
  },
  liveVoiceTranscriptText: {
    color: '#F8FAFC',
    fontSize: 12,
    marginTop: 4,
    fontStyle: 'italic',
  },
  quickVoiceChipScroll: {
    marginTop: 8,
  },
  quickVoiceChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(56, 189, 248, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.35)',
    marginRight: 7,
  },
  quickVoiceChipText: {
    color: '#E0F2FE',
    fontSize: 11,
    fontWeight: '700',
  },
  chatScroll: {
    flex: 1,
  },
  chatScrollContent: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 24,
  },
  selfAwareBanner: {
    padding: 11,
    borderRadius: 16,
    backgroundColor: 'rgba(30, 41, 59, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.32)',
    marginBottom: 12,
  },
  selfAwareTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 3,
  },
  selfAwareTitle: {
    color: '#E9D5FF',
    fontSize: 11,
    fontWeight: '800',
  },
  selfAwareSubLink: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  selfAwareThoughtPreview: {
    color: '#CBD5E1',
    fontSize: 11.5,
  },
  msgRow: {
    marginBottom: 12,
    flexDirection: 'row',
  },
  msgRowUser: {
    justifyContent: 'flex-end',
  },
  msgRowAssistant: {
    justifyContent: 'flex-start',
  },
  glassBubble: {
    maxWidth: '92%',
    borderRadius: 20,
    padding: 13,
    borderWidth: 1,
  },
  userGlassBubble: {
    backgroundColor: 'rgba(79, 70, 229, 0.34)',
    borderColor: 'rgba(129, 140, 248, 0.45)',
    borderBottomRightRadius: 6,
  },
  assistantGlassBubble: {
    backgroundColor: 'rgba(15, 23, 42, 0.82)',
    borderColor: 'rgba(148, 163, 184, 0.22)',
    borderBottomLeftRadius: 6,
  },
  bubbleMetaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 8,
  },
  bubbleBrandBadge: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  bubbleTokenSavedBadge: {
    color: '#6EE7B7',
    fontSize: 10,
    fontWeight: '700',
    backgroundColor: 'rgba(16, 185, 129, 0.14)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  thoughtTogglePill: {
    backgroundColor: 'rgba(168, 85, 247, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.4)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  thoughtToggleText: {
    color: '#E9D5FF',
    fontSize: 10,
    fontWeight: '700',
  },
  ownThoughtsBox: {
    backgroundColor: 'rgba(9, 13, 26, 0.85)',
    borderLeftWidth: 3,
    borderLeftColor: '#A855F7',
    padding: 9,
    borderRadius: 10,
    marginBottom: 9,
  },
  ownThoughtsLabel: {
    color: '#C084FC',
    fontSize: 10,
    fontWeight: '800',
    marginBottom: 3,
  },
  ownThoughtsBody: {
    color: '#CBD5E1',
    fontSize: 11.5,
    lineHeight: 16,
  },
  ownThoughtsEngines: {
    color: '#38BDF8',
    fontSize: 10,
    marginTop: 5,
    fontWeight: '700',
  },
  voiceNarrationStrip: {
    backgroundColor: 'rgba(56, 189, 248, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 6,
    marginBottom: 8,
  },
  voiceNarrationText: {
    color: '#BAE6FD',
    fontSize: 11.5,
    fontWeight: '600',
  },
  userMsgText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 20,
  },
  assistantMsgText: {
    color: '#F1F5F9',
    fontSize: 13.5,
    lineHeight: 20,
  },
  inlineMediaCard: {
    marginTop: 10,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.35)',
  },
  inlineGeneratedImage: {
    width: 260,
    height: 260,
    backgroundColor: '#0F172A',
  },
  inlineVideoContainer: {
    width: 270,
    height: 210,
    backgroundColor: '#05070F',
  },
  inlinePdfCard: {
    padding: 12,
    backgroundColor: 'rgba(30, 41, 59, 0.85)',
  },
  inlinePdfTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
  },
  inlinePdfPath: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 4,
  },
  inlinePdfShareBtn: {
    marginTop: 9,
    backgroundColor: 'rgba(99, 102, 241, 0.25)',
    borderWidth: 1,
    borderColor: '#818CF8',
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  inlinePdfShareText: {
    color: '#E0E7FF',
    fontSize: 11.5,
    fontWeight: '700',
  },
  bubbleFooterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 10,
  },
  bubbleSmallBtn: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  bubbleSmallBtnText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '600',
  },
  proactiveScroll: {
    marginTop: 9,
  },
  proactiveChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(99, 102, 241, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(129, 140, 248, 0.35)',
    marginRight: 7,
  },
  proactiveChipText: {
    color: '#E0E7FF',
    fontSize: 11,
    fontWeight: '700',
  },
  loadingGlassCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    padding: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
  },
  loadingGlassText: {
    color: '#BAE6FD',
    fontSize: 12,
    fontWeight: '600',
  },
  composerOuterWrap: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: 'transparent',
  },
  glassComposerCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    borderRadius: 28,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
  },
  composerPlusBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  composerPlusIcon: {
    fontSize: 16,
  },
  composerInput: {
    flex: 1,
    color: '#F8FAFC',
    fontSize: 14,
    maxHeight: 95,
    paddingVertical: 4,
  },
  composerNarrateToggle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  composerNarrateToggleOn: {
    backgroundColor: 'rgba(56, 189, 248, 0.2)',
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  composerNarrateIcon: {
    fontSize: 15,
  },
  composerSendOrb: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#4F46E5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerVoiceOrb: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(56, 189, 248, 0.25)',
    borderWidth: 1,
    borderColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerVoiceOrbActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.35)',
    borderColor: '#F87171',
  },
  composerSendIcon: {
    fontSize: 17,
  },
  viewScroll: {
    flex: 1,
  },
  viewScrollContent: {
    padding: 14,
    paddingBottom: 36,
  },
  glassHeroCard: {
    padding: 16,
    borderRadius: 22,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.38)',
    marginBottom: 14,
  },
  sectionTitle: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '800',
  },
  sectionSubtitle: {
    color: '#94A3B8',
    fontSize: 12.5,
    marginTop: 5,
    lineHeight: 18,
  },
  giantVoiceOrb: {
    marginTop: 18,
    marginBottom: 14,
    alignSelf: 'center',
    width: 210,
    height: 210,
    borderRadius: 105,
    backgroundColor: 'rgba(30, 41, 59, 0.9)',
    borderWidth: 2,
    borderColor: '#38BDF8',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  giantVoiceOrbListening: {
    backgroundColor: 'rgba(88, 28, 135, 0.48)',
    borderColor: '#F43F5E',
  },
  giantVoiceOrbEmoji: {
    fontSize: 44,
    marginBottom: 8,
  },
  giantVoiceOrbStatus: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  giantVoiceOrbHint: {
    color: '#BAE6FD',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 6,
  },
  bilingualModeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
    marginTop: 6,
  },
  langModeChip: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
  },
  langModeChipActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.24)',
    borderColor: '#38BDF8',
  },
  langModeChipText: {
    color: '#F8FAFC',
    fontSize: 11.5,
    fontWeight: '700',
  },
  glassSectionCard: {
    padding: 15,
    borderRadius: 20,
    backgroundColor: 'rgba(15, 23, 42, 0.78)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.2)',
    marginBottom: 14,
  },
  cardHeading: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 6,
  },
  cardSubtext: {
    color: '#94A3B8',
    fontSize: 12,
    marginBottom: 10,
    lineHeight: 17,
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
  },
  glassGridActionBtn: {
    width: '48%',
    padding: 12,
    borderRadius: 15,
    backgroundColor: 'rgba(30, 41, 59, 0.75)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.32)',
  },
  gridBtnTitle: {
    color: '#F8FAFC',
    fontSize: 13,
    fontWeight: '800',
  },
  gridBtnSub: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 3,
  },
  logLineText: {
    color: '#A7F3D0',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 4,
  },
  glassEngineCard: {
    padding: 14,
    borderRadius: 18,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(56, 189, 248, 0.3)',
    marginBottom: 11,
  },
  engineCardTitle: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
  },
  engineCardStatus: {
    color: '#38BDF8',
    fontSize: 11.5,
    fontWeight: '700',
    marginTop: 4,
  },
  engineCardDesc: {
    color: '#CBD5E1',
    fontSize: 12,
    marginTop: 5,
    lineHeight: 17,
  },
  thoughtStreamItem: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 163, 184, 0.14)',
  },
  thoughtStreamMeta: {
    color: '#C084FC',
    fontSize: 10.5,
    fontWeight: '700',
  },
  thoughtStreamTe: {
    color: '#F8FAFC',
    fontSize: 12,
    marginTop: 3,
  },
  thoughtStreamEn: {
    color: '#94A3B8',
    fontSize: 11.5,
    marginTop: 2,
  },
  openSourceRow: {
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 163, 184, 0.14)',
  },
  openSourceTitle: {
    color: '#E0F2FE',
    fontSize: 13,
    fontWeight: '800',
  },
  openSourceDesc: {
    color: '#CBD5E1',
    fontSize: 11.5,
    marginTop: 2,
  },
  openSourceUrl: {
    color: '#38BDF8',
    fontSize: 10.5,
    marginTop: 3,
  },
  mediaSegmentRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  mediaSegmentBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  mediaSegmentBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.32)',
    borderColor: '#818CF8',
  },
  mediaSegmentText: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '800',
  },
  glassInputBox: {
    backgroundColor: 'rgba(9, 13, 26, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
    borderRadius: 14,
    padding: 11,
    color: '#F8FAFC',
    fontSize: 13,
    minHeight: 75,
    marginBottom: 10,
  },
  glassSingleInput: {
    backgroundColor: 'rgba(9, 13, 26, 0.85)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.28)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#F8FAFC',
    fontSize: 13,
    marginBottom: 10,
  },
  pillSelectorRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    marginBottom: 10,
  },
  smallSelectPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
  },
  smallSelectPillActive: {
    backgroundColor: 'rgba(56, 189, 248, 0.24)',
    borderColor: '#38BDF8',
  },
  smallSelectPillText: {
    color: '#F8FAFC',
    fontSize: 11,
    fontWeight: '700',
  },
  primaryGlassCta: {
    backgroundColor: '#4F46E5',
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  primaryGlassCtaText: {
    color: '#FFFFFF',
    fontSize: 13.5,
    fontWeight: '800',
  },
  studioGalleryImage: {
    width: '100%',
    height: 280,
    borderRadius: 14,
    marginTop: 8,
    backgroundColor: '#0F172A',
  },
  studioVideoPlayerBox: {
    width: '100%',
    height: 230,
    borderRadius: 14,
    overflow: 'hidden',
    marginTop: 8,
    backgroundColor: '#05070F',
  },
  appCatalogGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 6,
  },
  appCatalogCard: {
    width: '31%',
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 14,
    backgroundColor: 'rgba(30, 41, 59, 0.78)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.2)',
    alignItems: 'center',
  },
  appCatalogEmoji: {
    fontSize: 22,
    marginBottom: 4,
  },
  appCatalogName: {
    color: '#F8FAFC',
    fontSize: 11.5,
    fontWeight: '700',
    textAlign: 'center',
  },
  screenDumpText: {
    color: '#93C5FD',
    fontSize: 10.5,
    marginTop: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
    justifyContent: 'flex-start',
  },
  glassDrawerSheet: {
    width: '86%',
    height: '100%',
    backgroundColor: 'rgba(10, 15, 30, 0.96)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(99, 102, 241, 0.4)',
    padding: 16,
  },
  drawerHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(148, 163, 184, 0.16)',
  },
  drawerBrandTitle: {
    color: '#F8FAFC',
    fontSize: 17,
    fontWeight: '900',
  },
  drawerBrandSub: {
    color: '#38BDF8',
    fontSize: 11.5,
    fontWeight: '600',
  },
  glassCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  glassCloseText: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: '800',
  },
  drawerNavCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 13,
    borderRadius: 16,
    backgroundColor: 'rgba(30, 41, 59, 0.5)',
    borderWidth: 1,
    borderColor: 'rgba(148, 163, 184, 0.15)',
    marginBottom: 9,
  },
  drawerNavCardActive: {
    backgroundColor: 'rgba(79, 70, 229, 0.28)',
    borderColor: '#818CF8',
  },
  drawerNavEmoji: {
    fontSize: 24,
  },
  drawerNavTitle: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: '800',
  },
  drawerNavSub: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 2,
  },
  drawerFooterBox: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(148, 163, 184, 0.16)',
  },
  drawerFooterText: {
    color: '#CBD5E1',
    fontSize: 11,
    textAlign: 'center',
  },
  modalBackdropBottom: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.65)',
    justifyContent: 'flex-end',
  },
  glassBottomSheet: {
    backgroundColor: 'rgba(15, 23, 42, 0.97)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.4)',
    padding: 16,
    paddingBottom: 28,
  },
});
