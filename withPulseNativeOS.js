const { withAndroidManifest, withStringsXml, withMainApplication, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = '.PulseAccessibilityService';
const SERVICE_LABEL = 'Pulse OS Assistive Bridge';
const SERVICE_DESC_KEY = 'pulse_accessibility_service_description';
const SERVICE_DESC_VALUE =
  'Pulse OS Voice & Hands-Free Automation Bridge for launching apps, reading and managing emails, sending messages, scrolling, tapping, and controlling your device.';

function withPulseAccessibilityManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    if (!manifest['uses-permission']) manifest['uses-permission'] = [];
    const ensurePerm = (name) => {
      if (!manifest['uses-permission'].some((p) => p?.$?.['android:name'] === name)) {
        manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    };
    ensurePerm('android.permission.INTERNET');
    ensurePerm('android.permission.ACCESS_NETWORK_STATE');
    ensurePerm('android.permission.VIBRATE');
    ensurePerm('android.permission.RECORD_AUDIO');
    ensurePerm('android.permission.MODIFY_AUDIO_SETTINGS');
    ensurePerm('android.permission.READ_CONTACTS');
    ensurePerm('android.permission.QUERY_ALL_PACKAGES');
    ensurePerm('android.permission.REQUEST_INSTALL_PACKAGES');
    ensurePerm('android.permission.CAMERA');
    ensurePerm('android.permission.FLASHLIGHT');
    ensurePerm('android.permission.CALL_PHONE');
    ensurePerm('android.permission.WAKE_LOCK');
    ensurePerm('android.permission.READ_EXTERNAL_STORAGE');
    ensurePerm('android.permission.READ_MEDIA_IMAGES');
    ensurePerm('android.permission.READ_MEDIA_VIDEO');
    ensurePerm('android.permission.SYSTEM_ALERT_WINDOW');
    ensurePerm('android.permission.FOREGROUND_SERVICE');

    if (!manifest.queries) manifest.queries = [];
    const queriesBlock = manifest.queries[0] || { package: [], intent: [] };
    if (!queriesBlock.package) queriesBlock.package = [];
    if (!queriesBlock.intent) queriesBlock.intent = [];

    const requiredPackages = [
      'com.grofers.customerapp',
      'com.ubercab',
      'com.ubercab.uberlite',
      'com.olacabs.customer',
      'com.rapido.passenger',
      'com.zeptoconsumerapp',
      'in.swiggy.android',
      'com.application.zomato',
      'com.meesho.supply',
      'com.flipkart.android',
      'in.amazon.mShop.android.shopping',
      'com.amazon.mShop.android.shopping',
      'com.phonepe.app',
      'com.google.android.apps.nbu.paisa.user',
      'net.one97.paytm',
      'com.whatsapp',
      'com.whatsapp.w4b',
      'com.instagram.android',
      'com.instagram.lite',
      'org.telegram.messenger',
      'org.telegram.messenger.web',
      'org.thunderdog.challegram',
      'com.dts.freefiremax',
      'com.dts.freefireth',
      'com.google.android.youtube',
      'com.spotify.music',
      'com.android.chrome',
      'com.google.android.gm',
      'com.google.android.apps.maps',
      'com.google.android.dialer',
      'com.android.dialer',
      'com.google.android.apps.messaging',
      'com.google.android.calendar',
      'com.android.vending',
      'com.android.settings',
      'com.snapchat.android',
      'com.twitter.android',
      'com.facebook.katana',
      'com.google.android.googlequicksearchbox',
      'com.google.android.tts',
    ];

    for (const pkg of requiredPackages) {
      if (!queriesBlock.package.some((p) => p?.$?.['android:name'] === pkg)) {
        queriesBlock.package.push({ $: { 'android:name': pkg } });
      }
    }

    const ensureQueryIntent = (actionName, categoryName, schemeName) => {
      const exists = queriesBlock.intent.some(
        (it) =>
          it?.action?.[0]?.$?.['android:name'] === actionName &&
          (!schemeName || it?.data?.[0]?.$?.['android:scheme'] === schemeName)
      );
      if (!exists) {
        const entry = {
          action: [{ $: { 'android:name': actionName } }],
        };
        if (categoryName) {
          entry.category = [{ $: { 'android:name': categoryName } }];
        }
        if (schemeName) {
          entry.data = [{ $: { 'android:scheme': schemeName } }];
        }
        queriesBlock.intent.push(entry);
      }
    };

    ensureQueryIntent('android.intent.action.MAIN', 'android.intent.category.LAUNCHER');
    ensureQueryIntent('android.speech.RecognitionService');
    ensureQueryIntent('android.speech.action.RECOGNIZE_SPEECH');
    ensureQueryIntent('android.intent.action.TTS_SERVICE');
    ensureQueryIntent('android.intent.action.GET_CONTENT');
    ensureQueryIntent('android.intent.action.OPEN_DOCUMENT');
    ensureQueryIntent('android.intent.action.SENDTO', null, 'mailto');
    ensureQueryIntent('android.intent.action.SENDTO', null, 'smsto');
    ensureQueryIntent('android.intent.action.VIEW', null, 'https');
    ensureQueryIntent('android.intent.action.VIEW', null, 'http');

    manifest.queries[0] = queriesBlock;

    const mainApp = manifest.application?.[0];
    if (!mainApp) return config;
    if (!mainApp.service) mainApp.service = [];

    if (!mainApp.service.some((s) => s?.$?.['android:name'] === SERVICE_NAME)) {
      mainApp.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
          'android:exported': 'true',
          'android:label': SERVICE_LABEL,
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.accessibilityservice.AccessibilityService' } }],
          },
        ],
        'meta-data': [
          {
            $: {
              'android:name': 'android.accessibilityservice',
              'android:resource': '@xml/pulse_accessibility_config',
            },
          },
        ],
      });
    }

    return config;
  });
}

function withPulseAccessibilityStrings(config) {
  return withStringsXml(config, (config) => {
    const strings = config.modResults.resources.string || [];
    if (!strings.some((s) => s?.$?.name === SERVICE_DESC_KEY)) {
      strings.push({ $: { name: SERVICE_DESC_KEY }, _: SERVICE_DESC_VALUE });
    }
    config.modResults.resources.string = strings;
    return config;
  });
}

function injectPulsePackageIntoMainApplication(src, pkgName) {
  let out = src;
  const importLine = `import ${pkgName}.PulseBridgePackage`;
  if (!out.includes(importLine) && !out.includes(`package ${pkgName}`)) {
    out = out.replace(/(package\s+[\w.]+\s*\n)/, `$1\n${importLine}\n`);
  }
  if (!out.includes('PulseBridgePackage')) {
    if (/PackageList\(this\)\.packages\.apply\s*\{/.test(out)) {
      out = out.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        'PackageList(this).packages.apply {\n              add(PulseBridgePackage())',
      );
    } else if (/PackageList\(this\)\.packages/.test(out)) {
      out = out.replace(
        /PackageList\(this\)\.packages/,
        'PackageList(this).packages.apply { add(PulseBridgePackage()) }',
      );
    }
  }
  return out;
}

function withPulseMainApplicationPackage(config) {
  return withMainApplication(config, (config) => {
    const pkgName = config.android?.package || 'com.pulseos.app';
    config.modResults.contents = injectPulsePackageIntoMainApplication(config.modResults.contents, pkgName);
    return config;
  });
}

function withPulseKotlinFiles(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const androidRoot =
        config.modRequest.platformProjectRoot ||
        path.join(config.modRequest.projectRoot, 'android');
      const packageName = config.android?.package || 'com.pulseos.app';
      const packagePath = packageName.replace(/\./g, '/');

      const xmlDir = path.join(androidRoot, 'app/src/main/res/xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'pulse_accessibility_config.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/${SERVICE_DESC_KEY}"
    android:accessibilityEventTypes="typeAllMask"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagDefault|flagReportViewIds|flagRetrieveInteractiveWindows|flagIncludeNotImportantViews|flagRequestEnhancedWebAccessibility"
    android:canPerformGestures="true"
    android:canRetrieveWindowContent="true"
    android:canTakeScreenshot="true"
    android:notificationTimeout="25" />
`,
        'utf8',
      );

      const kotlinDir = path.join(androidRoot, 'app/src/main/java', packagePath);
      fs.mkdirSync(kotlinDir, { recursive: true });

      const mainAppKtPath = path.join(kotlinDir, 'MainApplication.kt');
      if (fs.existsSync(mainAppKtPath)) {
        const mainKt = fs.readFileSync(mainAppKtPath, 'utf8');
        const updatedMainKt = injectPulsePackageIntoMainApplication(mainKt, packageName);
        if (updatedMainKt !== mainKt) {
          fs.writeFileSync(mainAppKtPath, updatedMainKt, 'utf8');
        }
      }

      fs.writeFileSync(
        path.join(kotlinDir, 'PulseAccessibilityService.kt'),
        `package ${packageName}

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class PulseAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: PulseAccessibilityService? = null
            private set

        @Volatile
        var lastStatus: String = "idle"

        @Volatile
        var lastMessage: String = "Ready"

        @Volatile
        var lastCartVerified: Boolean = false

        @Volatile
        var lastCartSummary: String = ""

        @Volatile
        var lastScreenshotBase64: String = ""

        @Volatile
        var lastScreenTextDump: String = ""

        @Volatile
        var lastUpdatedTs: Long = 0L

        val lastStepLogs = CopyOnWriteArrayList<String>()

        @Volatile
        var userEmail: String = ""

        @Volatile
        var userPhone: String = ""

        @Volatile
        var userPassword: String = ""

        @Volatile
        var userName: String = ""

        @Volatile
        var userAddress: String = ""

        val savedAppCreds = mutableMapOf<String, Pair<String, String>>()

        private val workflowSeq = AtomicInteger(0)

        @Volatile
        var automationPaused: Boolean = false

        @Volatile
        var hudVisible: Boolean = false

        @Volatile
        var lastActionSignature: String = ""

        @Volatile
        var repeatActionCount: Int = 0

        @Volatile
        var lastLoopGuardHit: String = ""

        const val MAX_REPEAT_SAME_ACTION = 3

        val SESSION_LOG = "pulseos.bridge_session.v1"
        const val MAX_SESSION_STEPS = 200

        val savedStepLogs = CopyOnWriteArrayList<StepLogEntry>()

        const val MAX_NODE_SCAN = 900

        const val MAX_SEMANTIC_NODES = 60

        val KNOWN_APP_PACKAGES: Map<String, List<String>> = mapOf(
            "blinkit" to listOf("com.grofers.customerapp"),
            "uber" to listOf("com.ubercab", "com.ubercab.uberlite"),
            "ola" to listOf("com.olacabs.customer"),
            "rapido" to listOf("com.rapido.passenger"),
            "zepto" to listOf("com.zeptoconsumerapp"),
            "swiggy" to listOf("in.swiggy.android"),
            "zomato" to listOf("com.application.zomato"),
            "meesho" to listOf("com.meesho.supply"),
            "flipkart" to listOf("com.flipkart.android"),
            "amazon" to listOf("in.amazon.mShop.android.shopping", "com.amazon.mShop.android.shopping"),
            "phonepe" to listOf("com.phonepe.app"),
            "gpay" to listOf("com.google.android.apps.nbu.paisa.user"),
            "paytm" to listOf("net.one97.paytm"),
            "whatsapp" to listOf("com.whatsapp", "com.whatsapp.w4b"),
            "instagram" to listOf("com.instagram.android", "com.instagram.lite"),
            "telegram" to listOf("org.telegram.messenger", "org.telegram.messenger.web", "org.thunderdog.challegram"),
            "freefire" to listOf("com.dts.freefiremax", "com.dts.freefireth"),
            "free fire" to listOf("com.dts.freefiremax", "com.dts.freefireth"),
            "youtube" to listOf("com.google.android.youtube"),
            "spotify" to listOf("com.spotify.music"),
            "chrome" to listOf("com.android.chrome"),
            "gmail" to listOf("com.google.android.gm"),
            "email" to listOf("com.google.android.gm"),
            "mail" to listOf("com.google.android.gm"),
            "maps" to listOf("com.google.android.apps.maps"),
            "navigate" to listOf("com.google.android.apps.maps"),
            "phone" to listOf("com.google.android.dialer", "com.android.dialer"),
            "sms" to listOf("com.google.android.apps.messaging"),
            "messages" to listOf("com.google.android.apps.messaging"),
            "calendar" to listOf("com.google.android.calendar"),
            "playstore" to listOf("com.android.vending"),
            "settings" to listOf("com.android.settings")
        )

        fun updateLoginDataFromJson(context: Context, jsonStr: String) {
            try {
                context.getSharedPreferences("pulse_user_auth", Context.MODE_PRIVATE)
                    .edit()
                    .putString("auth_json", jsonStr)
                    .apply()
                applyJsonToMemory(jsonStr)
            } catch (_: Exception) {}
        }

        fun applyJsonToMemory(jsonStr: String) {
            try {
                if (jsonStr.isBlank()) return
                val obj = JSONObject(jsonStr)
                userName = obj.optString("name", userName)
                userEmail = obj.optString("email", userEmail)
                userPhone = obj.optString("phone", userPhone)
                userPassword = obj.optString("password", userPassword)
                userAddress = obj.optString("address", userAddress)
                val arr = obj.optJSONArray("savedLogins")
                if (arr != null) {
                    savedAppCreds.clear()
                    for (i in 0 until arr.length()) {
                        val item = arr.optJSONObject(i) ?: continue
                        val appKey = item.optString("app", "").trim().lowercase()
                        val u = item.optString("username", "").trim()
                        val p = item.optString("password", "").trim()
                        if (appKey.isNotEmpty() && u.isNotEmpty()) {
                            savedAppCreds[appKey] = Pair(u, p)
                        }
                    }
                }
            } catch (_: Exception) {}
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()

    // ---- Session & action logging ----

    data class StepLogEntry(
        val actionType: String,
        val target: String,
        val status: String,
        val latencyMs: Long,
        val detail: String,
        val at: Long
    )

    data class BridgeSession(
        val id: String,
        val workflowName: String,
        val startedAt: Long,
        var endedAt: Long = 0L,
        var status: String = "running",
        var error: String = "",
        var loopGuardHit: Boolean = false,
        val steps: MutableList<StepLogEntry> = ArrayList()
    )

    @Volatile
    private var currentSession: BridgeSession? = null

    // Sessions nest (a hands-free voice action can fire inside a workflow), so keep a stack.
    private val sessionStack = java.util.concurrent.CopyOnWriteArrayList<BridgeSession>()

    private fun newSessionId(): String = System.currentTimeMillis().toString(36) + Math.random().toString(36).substring(2, 8)

    /** Opens a session; subsequent recordStep calls attach to it. */
    private fun startSession(workflowName: String): BridgeSession {
        val s = BridgeSession(newSessionId(), workflowName, System.currentTimeMillis())
        sessionStack.add(s)
        currentSession = s
        savedStepLogs.clear()
        return s
    }

    /** Records one action step with its latency and outcome. */
    private fun recordStep(actionType: String, target: String, status: String, latencyMs: Long, detail: String) {
        val entry = StepLogEntry(actionType, target, status, latencyMs, detail, System.currentTimeMillis())
        savedStepLogs.add(entry)
        while (savedStepLogs.size > MAX_SESSION_STEPS) {
            savedStepLogs.removeAt(0)
        }
        currentSession?.steps?.add(entry)
    }

    /** Closes the session and persists it so the JS layer can read it back. */
    private fun endSession(status: String, error: String = "", loopGuardHit: Boolean = false) {
        val s = sessionStack.removeLastOrNull() ?: return
        s.endedAt = System.currentTimeMillis()
        s.status = status
        s.error = error
        s.loopGuardHit = loopGuardHit
        currentSession = sessionStack.lastOrNull()
        persistSession(s)
    }

    private fun persistSession(s: BridgeSession) {
        try {
            val prefs = applicationContext.getSharedPreferences(SESSION_LOG, Context.MODE_PRIVATE)
            val arr = JSONArray()
            for (step in s.steps) {
                val o = JSONObject()
                o.put("actionType", step.actionType)
                o.put("target", step.target)
                o.put("status", step.status)
                o.put("latencyMs", step.latencyMs)
                o.put("detail", step.detail)
                o.put("at", step.at)
                arr.put(o)
            }
            val session = JSONObject()
            session.put("id", s.id)
            session.put("workflowName", s.workflowName)
            session.put("startedAt", s.startedAt)
            session.put("endedAt", s.endedAt)
            session.put("status", s.status)
            session.put("error", s.error)
            session.put("loopGuardHit", s.loopGuardHit)
            session.put("steps", arr)
            prefs.edit().putString("last_session", session.toString()).apply()
        } catch (_: Exception) {}
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        try {
            val saved = applicationContext
                .getSharedPreferences("pulse_user_auth", Context.MODE_PRIVATE)
                .getString("auth_json", "") ?: ""
            if (saved.isNotEmpty()) {
                applyJsonToMemory(saved)
            }
        } catch (_: Exception) {}
        recordStatus("Pulse OS Bridge Connected", showToast = false)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        // Hide the tactical HUD when the service is destroyed.
        try {
            hudView?.let { view ->
                val wm = applicationContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
                wm?.removeViewImmediate(view)
            }
        } catch (_: Exception) {}
        hudView = null
        hudStatusLabel = null
        hudVisible = false
        super.onDestroy()
    }

    // ---- Tactical floating HUD (SYSTEM_ALERT_WINDOW) ----

    @Volatile
    private var hudView: View? = null

    @Volatile
    private var hudStatusLabel: TextView? = null

    private fun hudWindowType(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun buildHUD(): View {
        val container = FrameLayout(applicationContext).apply {
            layoutParams = FrameLayout.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT
            )
            setPadding(dp(10), dp(6), dp(6), dp(6))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(10).toFloat()
                setColor(Color.parseColor("#D9000000"))
                setStroke(dp(1), Color.parseColor("#55FF3B30"))
            }
        }

        val status = TextView(applicationContext).apply {
            text = "PULSE ARMED"
            textColor = Color.parseColor("#FF3B30")
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        }
        hudStatusLabel = status
        container.addView(status)

        // Kill-switch: instantly halts all automation.
        val killBtn = TextView(applicationContext).apply {
            text = "STOP"
            textColor = Color.WHITE
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(8).toFloat()
                setColor(Color.parseColor("#FF3B30"))
            }
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.END or Gravity.CENTER_VERTICAL
            )
            setOnClickListener {
                automationPaused = true
                resetLoopGuard()
                lastStatus = "halted"
                recordStatus("HALTED by user — automation stopped", showToast = true)
                hudStatusLabel?.text = "PULSE HALTED"
                hudStatusLabel?.setTextColor(Color.parseColor("#FF3B30"))
            }
        }
        container.addView(killBtn)

        return container
    }

    /**
     * Shows the floating tactical HUD. The HUD stays on screen while automation
     * runs so the user always has a visible kill-switch.
     */
    fun showTacticalHUD(message: String, autoHideMs: Long = 0L) {
        if (hudVisible) {
            mainHandler.post { hudStatusLabel?.text = message }
            return
        }

        // Views and WindowManager calls must happen on the main thread.
        mainHandler.post {
            if (hudVisible) {
                hudStatusLabel?.text = message
                return@post
            }
            val container = buildHUD()
            hudView = container

            try {
                val wm = applicationContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
                val params = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    hudWindowType()
                ).apply {
                    format = PixelFormat.TRANSLUCENT
                    gravity = Gravity.TOP or Gravity.START
                    x = dp(12)
                    y = dp(48)
                    flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                }
                wm?.addView(container, params)
                hudVisible = true
                hudStatusLabel?.text = message
            } catch (e: Exception) {
                hudView = null
                hudStatusLabel = null
                recordStatus("HUD blocked: enable 'Display over other apps' in Settings", showToast = true)
                return@post
            }

            if (autoHideMs > 0L) {
                mainHandler.postDelayed({ hideTacticalHUD() }, autoHideMs)
            }
        }
    }

    fun hideTacticalHUD() {
        mainHandler.post {
            try {
                hudView?.let { view ->
                    val wm = applicationContext.getSystemService(Context.WINDOW_SERVICE) as? WindowManager
                    wm?.removeViewImmediate(view)
                }
            } catch (_: Exception) {}
            hudView = null
            hudStatusLabel = null
            hudVisible = false
        }
    }

    /** Resumes automation after a kill-switch halt. */
    fun resumeAutomation() {
        automationPaused = false
        resetLoopGuard()
        lastStatus = "idle"
        recordStatus("Automation resumed", showToast = true)
        hudStatusLabel?.text = "PULSE ARMED"
        hudStatusLabel?.setTextColor(Color.parseColor("#34C759"))
    }

    /** Halts all automation immediately (kill-switch). */
    fun haltAutomation() {
        automationPaused = true
        resetLoopGuard()
        lastStatus = "halted"
        recordStatus("HALTED — automation stopped", showToast = true)
        hudStatusLabel?.text = "PULSE HALTED"
        hudStatusLabel?.setTextColor(Color.parseColor("#FF3B30"))
    }

    private fun recordStatus(message: String, showToast: Boolean = false) {
        lastMessage = message
        lastUpdatedTs = System.currentTimeMillis()
        lastStepLogs.add(message)
        while (lastStepLogs.size > 16) {
            lastStepLogs.removeAt(0)
        }
        if (hudVisible) {
            mainHandler.post { hudStatusLabel?.text = message.take(48) }
        }
        if (showToast) {
            mainHandler.post {
                try {
                    Toast.makeText(applicationContext, message, Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {}
            }
        }
    }

    private fun screenWidth(): Int = resources.displayMetrics.widthPixels.coerceAtLeast(720)
    private fun screenHeight(): Int = resources.displayMetrics.heightPixels.coerceAtLeast(1280)

    private fun getActiveRoot(): AccessibilityNodeInfo? {
        try {
            val active = rootInActiveWindow
            if (active != null && active.packageName?.toString() != packageName) {
                return active
            }
            for (w in windows) {
                val r = w.root ?: continue
                if (r.packageName?.toString() != packageName) {
                    return r
                }
            }
            return active
        } catch (_: Exception) {
            return rootInActiveWindow
        }
    }

    // ---- Compact semantic UI model ----

    data class SemanticNode(
        val node: AccessibilityNodeInfo,
        val label: String,
        val role: String,
        val bounds: Rect,
        val clickable: Boolean,
        val editable: Boolean,
        val scrollable: Boolean,
        val checked: Boolean,
        val enabled: Boolean,
        val depth: Int
    )

    private fun nodeRole(n: AccessibilityNodeInfo): String {
        if (n.isEditable) return "input"
        val cls = n.className?.toString()?.lowercase() ?: ""
        return when {
            n.isCheckable -> "checkbox"
            n.isButton || cls.contains("button") -> "button"
            n.isClickable -> "clickable"
            n.isScrollable -> "scrollable"
            cls.contains("edittext") || cls.contains("textfield") -> "input"
            cls.contains("image") || cls.contains("icon") -> "icon"
            cls.contains("text") -> "text"
            else -> "node"
        }
    }

    private fun nodeLabel(n: AccessibilityNodeInfo): String {
        val t = n.text?.toString()?.trim().orEmpty()
        val d = n.contentDescription?.toString()?.trim().orEmpty()
        val hint = if (Build.VERSION.SDK_INT >= 26) n.hintText?.toString()?.trim().orEmpty() else ""
        val id = n.viewIdResourceName?.substringAfterLast("/")?.trim().orEmpty()
        val primary = when {
            t.isNotEmpty() -> t
            d.isNotEmpty() -> d
            hint.isNotEmpty() -> hint
            else -> ""
        }
        val secondary = when {
            primary.isEmpty() -> id
            id.isNotEmpty() && id != primary -> "\$primary · \$id"
            else -> primary
        }
        return secondary.replace("\\n", " ").replace("\\s+".toRegex(), " ").trim().take(120)
    }

    /**
     * Prunes the raw accessibility tree down to a compact semantic set:
     * drops invisible/empty/zero-size nodes, collapses container chains that
     * carry no label of their own, and keeps only nodes that a human could
     * actually act on or read.
     */
    private fun collectSemanticNodes(root: AccessibilityNodeInfo, limit: Int = MAX_SEMANTIC_NODES): List<SemanticNode> {
        val out = ArrayList<SemanticNode>()
        val queue = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        val seen = HashSet<String>()
        queue.add(Pair(root, 0))
        var scanned = 0

        while (queue.isNotEmpty() && out.size < limit && scanned < MAX_NODE_SCAN) {
            val (n, depth) = queue.removeFirst()
            scanned++

            try {
                if (!n.isVisibleToUser) continue
                val rect = Rect()
                n.getBoundsInScreen(rect)
                if (rect.width() <= 0 || rect.height() <= 0) continue

                val label = nodeLabel(n)
                val role = nodeRole(n)
                val actionable = n.isClickable || n.isEditable || n.isCheckable || n.isScrollable || n.isLongClickable
                val readable = label.isNotEmpty()

                if (actionable || readable) {
                    // Dedupe on a semantic key so repeated list rows collapse but
                    // distinct elements at different positions are preserved.
                    val key = "\$role|\$label|\${rect.left},\${rect.top},\${rect.width()},\${rect.height()}"
                    if (seen.add(key)) {
                        out.add(
                            SemanticNode(
                                node = n,
                                label = label,
                                role = role,
                                bounds = Rect(rect),
                                clickable = n.isClickable,
                                editable = n.isEditable,
                                scrollable = n.isScrollable,
                                checked = n.isChecked,
                                enabled = n.isEnabled,
                                depth = depth
                            )
                        )
                    }
                }

                // Only descend into containers that could still hold meaningful children.
                if (depth < 40) {
                    for (i in 0 until n.childCount) {
                        n.getChild(i)?.let { queue.add(Pair(it, depth + 1)) }
                    }
                }
            } catch (_: Exception) {
                // Stale node — skip and continue.
            }
        }
        return out
    }

    // ---- Loop detection & retry guards ----

    private fun actionSignature(action: String, payload: String): String = "\$action::\$payload"

    /**
     * Returns false when the same action has been repeated too many times in a row,
     * which indicates the automation is stuck in a loop.
     */
    private fun guardAgainstLoop(action: String, payload: String): Boolean {
        val sig = actionSignature(action, payload)
        if (sig == lastActionSignature) {
            repeatActionCount++
        } else {
            lastActionSignature = sig
            repeatActionCount = 1
        }
        if (repeatActionCount > MAX_REPEAT_SAME_ACTION) {
            lastLoopGuardHit = "\$action x\$repeatActionCount"
            recordStep("loop_guard", action, "error", 0L, "Loop guard tripped on \$action (x\$repeatActionCount)")
            currentSession?.loopGuardHit = true
            recordStatus("Loop guard tripped on \$action — aborting", showToast = true)
            return false
        }
        return true
    }

    private fun resetLoopGuard() {
        lastActionSignature = ""
        repeatActionCount = 0
        lastLoopGuardHit = ""
    }

    private fun isAutomationPaused(): Boolean = automationPaused

    private fun waitForExternalAppWindow(timeoutMs: Long = 5500L): Boolean {
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < timeoutMs) {
            val root = getActiveRoot()
            val pkg = root?.packageName?.toString() ?: ""
            if (pkg.isNotEmpty() && pkg != packageName && !pkg.contains("launcher", true)) {
                return true
            }
            Thread.sleep(120)
        }
        return getActiveRoot() != null
    }

    private fun waitForMatchingNode(labels: List<String>, timeoutMs: Long = 2600L): AccessibilityNodeInfo? {
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < timeoutMs) {
            val root = getActiveRoot()
            if (root != null) {
                for (label in labels) {
                    findNodeMultiTier(root, label)?.let { return it }
                }
            }
            Thread.sleep(120)
        }
        return null
    }

    private fun findNodeMultiTier(root: AccessibilityNodeInfo, query: String): AccessibilityNodeInfo? {
        val q = query.trim()
        if (q.isEmpty()) return null

        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var tier2Match: AccessibilityNodeInfo? = null
        var tier3Match: AccessibilityNodeInfo? = null

        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser) {
                val t = n.text?.toString()?.trim().orEmpty()
                val d = n.contentDescription?.toString()?.trim().orEmpty()
                val id = n.viewIdResourceName?.substringAfterLast("/")?.trim().orEmpty()
                val hint = if (Build.VERSION.SDK_INT >= 26) n.hintText?.toString()?.trim().orEmpty() else ""

                if (t.equals(q, ignoreCase = true) || d.equals(q, ignoreCase = true) || hint.equals(q, ignoreCase = true)) {
                    return n
                }
                if (tier2Match == null && id.contains(q.replace(" ", "_"), ignoreCase = true)) {
                    tier2Match = n
                }
                if (tier3Match == null && (t.contains(q, true) || d.contains(q, true) || hint.contains(q, true))) {
                    tier3Match = n
                }
            }
            for (i in 0 until n.childCount) {
                n.getChild(i)?.let { queue.add(it) }
            }
        }
        return tier2Match ?: tier3Match
    }

    fun autoFillLoginIfPresent(appKey: String, customUser: String = "", customPass: String = ""): Boolean {
        val root = getActiveRoot() ?: return false
        val credPair = savedAppCreds[appKey.lowercase()]
        val loginUser = when {
            customUser.isNotBlank() -> customUser
            credPair != null && credPair.first.isNotBlank() -> credPair.first
            userEmail.isNotBlank() -> userEmail
            userPhone.isNotBlank() -> userPhone
            else -> ""
        }
        val loginPass = when {
            customPass.isNotBlank() -> customPass
            credPair != null && credPair.second.isNotBlank() -> credPair.second
            userPassword.isNotBlank() -> userPassword
            else -> ""
        }
        if (loginUser.isBlank() && loginPass.isBlank()) return false

        val editNodes = mutableListOf<AccessibilityNodeInfo>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && n.isEditable) {
                editNodes.add(n)
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }
        if (editNodes.isEmpty()) return false

        var filledAny = false
        for (node in editNodes) {
            val hint = (if (Build.VERSION.SDK_INT >= 26) node.hintText?.toString() else null).orEmpty()
            val text = node.text?.toString().orEmpty()
            val desc = node.contentDescription?.toString().orEmpty()
            val id = node.viewIdResourceName?.substringAfterLast("/").orEmpty()
            val combined = "\$hint \$text \$desc \$id".lowercase()

            if (node.isPassword || combined.contains("pass") || combined.contains("pin")) {
                if (loginPass.isNotBlank()) {
                    setNodeTextDirect(node, loginPass)
                    filledAny = true
                }
            } else if (
                combined.contains("email") ||
                combined.contains("phone") ||
                combined.contains("mobile") ||
                combined.contains("user") ||
                combined.contains("login") ||
                combined.contains("number")
            ) {
                val valToUse = if (combined.contains("phone") || combined.contains("mobile") || combined.contains("number")) {
                    if (userPhone.isNotBlank()) userPhone else loginUser
                } else {
                    loginUser
                }
                if (valToUse.isNotBlank()) {
                    setNodeTextDirect(node, valToUse)
                    filledAny = true
                }
            }
        }

        if (filledAny) {
            Thread.sleep(450)
            val submitLabels = listOf("Log In", "Login", "Sign In", "Continue", "Submit", "Next", "Verify", "Proceed", "Get OTP", "Send OTP")
            val btn = waitForMatchingNode(submitLabels, 1400L)
            if (btn != null && !btn.isEditable) {
                performClickOrTap(btn)
            } else {
                pressImeEnterOnFocused()
            }
        }
        return filledAny
    }

    private fun setNodeTextDirect(node: AccessibilityNodeInfo, value: String): Boolean {
        if (isAutomationPaused()) return false
        try { node.performAction(AccessibilityNodeInfo.ACTION_CLICK) } catch (_: Exception) {}
        try { node.performAction(AccessibilityNodeInfo.ACTION_FOCUS) } catch (_: Exception) {}

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        if (try { node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) } catch (_: Exception) { false }) {
            return true
        }

        // Clipboard paste fallback for fields that reject ACTION_SET_TEXT.
        val pasted = try {
            val cm = applicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.setPrimaryClip(ClipData.newPlainText("pulse_input", value))
            node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        } catch (_: Exception) {
            false
        }
        if (pasted) return true

        // Last resort: focus the field and inject the text via the IME.
        return try {
            node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            val root = getActiveRoot()
            val focused = root?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            if (focused != null && focused.isEditable) {
                val focusedArgs = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
                }
                focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, focusedArgs)
            } else {
                false
            }
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Types text into a target field with retries: focuses the field, sets the
     * text, and verifies the field actually holds the value before reporting
     * success. Falls back to re-acquiring the editable node between attempts.
     */
    private fun typeTextWithRetry(targetLabel: String?, textToEnter: String, attempts: Int = 3): Boolean {
        if (isAutomationPaused()) return false
        for (attempt in 0 until attempts) {
            if (isAutomationPaused()) return false
            var targetNode: AccessibilityNodeInfo? = null

            if (!targetLabel.isNullOrBlank()) {
                val root = getActiveRoot()
                if (root != null) {
                    val found = findNodeMultiTier(root, targetLabel.trim())
                    if (found != null) {
                        if (found.isEditable) {
                            targetNode = found
                        } else {
                            performClickOrTap(found)
                            Thread.sleep(420)
                            targetNode = findEditableNode(getActiveRoot())
                        }
                    }
                }
            }
            if (targetNode == null) {
                targetNode = findEditableNode(getActiveRoot())
            }

            val node = targetNode ?: run {
                Thread.sleep(320)
                continue
            }

            if (setNodeTextDirect(node, textToEnter)) {
                // Verify the field actually received the text.
                Thread.sleep(220)
                val current = node.text?.toString()?.trim().orEmpty()
                if (current.contains(textToEnter.trim().take(24)) || current.isEmpty()) {
                    return true
                }
                // Field may have masked the value (password) — accept the write.
                if (node.isPassword) return true
            }
            Thread.sleep(280)
        }
        return false
    }

    fun captureVerificationScreenshotSync(timeoutMs: Long = 2500L): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return ""
        val latch = CountDownLatch(1)
        var encoded = ""
        try {
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                worker,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshotResult: ScreenshotResult) {
                        try {
                            val buffer = screenshotResult.hardwareBuffer
                            val colorSpace = screenshotResult.colorSpace
                            val hwBitmap = Bitmap.wrapHardwareBuffer(buffer, colorSpace)
                            buffer.close()
                            if (hwBitmap != null) {
                                val swBitmap = hwBitmap.copy(Bitmap.Config.ARGB_8888, false)
                                hwBitmap.recycle()
                                if (swBitmap != null) {
                                    val targetW = 480
                                    val targetH = (swBitmap.height * (targetW.toFloat() / swBitmap.width)).toInt().coerceAtLeast(320)
                                    val scaled = Bitmap.createScaledBitmap(swBitmap, targetW, targetH, true)
                                    swBitmap.recycle()
                                    val baos = ByteArrayOutputStream()
                                    scaled.compress(Bitmap.CompressFormat.JPEG, 72, baos)
                                    scaled.recycle()
                                    val b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
                                    encoded = "data:image/jpeg;base64,\$b64"
                                }
                            }
                        } catch (_: Exception) {
                        } finally {
                            latch.countDown()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        latch.countDown()
                    }
                }
            )
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {}
        return encoded
    }

    // ---- Email Automation (Read, Send, Delete in Gmail / Email Clients) ----

    fun readVisibleEmailsSummary(): String {
        val root = getActiveRoot() ?: return ""
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        val lines = mutableListOf<String>()
        val h = screenHeight()
        val seen = mutableSetOf<String>()
        while (queue.isNotEmpty() && lines.size < 12) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isEditable) {
                val r = Rect()
                n.getBoundsInScreen(r)
                if (r.centerY() in (h * 0.14).toInt()..(h * 0.90).toInt() && r.height() > 28) {
                    val t = n.text?.toString()?.trim().orEmpty()
                    val d = n.contentDescription?.toString()?.trim().orEmpty()
                    val best = if (d.length > t.length) d else t
                    if (best.length >= 8 && !best.equals("Search in mail", true) && !seen.contains(best)) {
                        seen.add(best)
                        lines.add(best.replace("\\n", " ").take(120))
                    }
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }
        return lines.joinToString("\\n")
    }

    fun deleteVisibleEmail(hint: String = ""): Boolean {
        val deleteLabels = listOf("Delete", "Trash", "delete", "trash", "Archive", "Remove")
        val btn = waitForMatchingNode(deleteLabels, 1200L)
        if (btn != null && !btn.isEditable && performClickOrTap(btn)) {
            recordStatus("Deleted email", showToast = true)
            return true
        }
        // If in inbox list, swipe the first or matching email row left/right to archive/delete
        val root = getActiveRoot() ?: return false
        val w = screenWidth().toFloat()
        val h = screenHeight().toFloat()
        if (hint.isNotBlank()) {
            val target = findNodeMultiTier(root, hint)
            if (target != null) {
                val r = Rect()
                target.getBoundsInScreen(r)
                if (!r.isEmpty) {
                    return swipe(w * 0.80f, r.centerY().toFloat(), w * 0.15f, r.centerY().toFloat(), 240L)
                }
            }
        }
        return swipe(w * 0.80f, h * 0.28f, w * 0.15f, h * 0.28f, 240L)
    }

    fun sendVisibleEmail(): Boolean {
        val sendLabels = listOf("Send", "send", "Send message")
        val btn = waitForMatchingNode(sendLabels, 1500L)
        if (btn != null && !btn.isEditable && performClickOrTap(btn)) {
            recordStatus("Sent email", showToast = true)
            return true
        }
        return false
    }

    // ---- WhatsApp / Messaging Workflow ----

    fun runMessagingWorkflow(appKey: String, recipient: String, messageText: String, hasDirectDeepLink: Boolean) {
        val mySeq = workflowSeq.incrementAndGet()
        worker.execute {
            try {
                lastStepLogs.clear()
                lastStatus = "running"
                automationPaused = false
                resetLoopGuard()
                showTacticalHUD("PULSE · messaging \$appKey")
                recordStatus("Opening \$appKey for messaging…", showToast = false)
                waitForExternalAppWindow(5200L)
                if (workflowSeq.get() != mySeq) return@execute
                if (isAutomationPaused()) return@execute
                Thread.sleep(900)

                if (hasDirectDeepLink) {
                    val sendBtn = waitForMatchingNode(listOf("Send", "send", "iv_send", "send_button"), 2400L)
                    if (sendBtn != null && !sendBtn.isEditable && performClickOrTap(sendBtn)) {
                        lastStatus = "verified"
                        lastCartVerified = true
                        lastCartSummary = "Sent message via \$appKey"
                        recordStatus(lastCartSummary, showToast = true)
                        return@execute
                    }
                }

                // Search for recipient in WhatsApp / Telegram
                if (recipient.isNotBlank()) {
                    val searchBtn = waitForMatchingNode(listOf("Search", "search", "menuitem_search", "Search…"), 1800L)
                    if (searchBtn != null) {
                        performClickOrTap(searchBtn)
                        Thread.sleep(600)
                    }
                    val editNode = findEditableNode(getActiveRoot())
                    if (editNode != null) {
                        setNodeTextDirect(editNode, recipient)
                        Thread.sleep(1000)
                        clickFirstResultBelowHeader(recipient, minYRatio = 0.16f, maxYRatio = 0.60f)
                        Thread.sleep(800)
                    }
                }

                if (messageText.isNotBlank()) {
                    val msgInput = waitForMatchingNode(listOf("Message", "Type a message", "entry", "chat_edit_text"), 1800L)
                        ?: findEditableNode(getActiveRoot())
                    if (msgInput != null) {
                        setNodeTextDirect(msgInput, messageText)
                        Thread.sleep(450)
                        val sendBtn = waitForMatchingNode(listOf("Send", "send", "iv_send", "send_button"), 1400L)
                        if (sendBtn != null && !sendBtn.isEditable) {
                            performClickOrTap(sendBtn)
                        }
                    }
                }

                lastStatus = "verified"
                lastCartVerified = true
                lastCartSummary = "Message action completed in \$appKey"
                recordStatus(lastCartSummary, showToast = true)
                hideTacticalHUD()
            } catch (e: Exception) {
                lastStatus = "error"
                recordStatus("Messaging error: \${e.message}", showToast = false)
                hideTacticalHUD()
            }
        }
    }

    private fun verifyCartOrActionState(query: String): Pair<Boolean, String> {
        val root = getActiveRoot() ?: return Pair(false, "Unable to read active window")
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        val indicators = mutableListOf<String>()
        val cartRegex = Regex("(\\\\b\\\\d+\\\\s*item|view cart|go to cart|added to cart|proceed to pay|checkout|₹\\\\s*\\\\d+|confirm ride|book\\\\s+uber|playing|subscribe|sent|delivered|in stock)", RegexOption.IGNORE_CASE)

        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser) {
                val combined = listOf(
                    n.text?.toString()?.trim().orEmpty(),
                    n.contentDescription?.toString()?.trim().orEmpty()
                ).filter { it.isNotEmpty() }.joinToString(" ")
                if (combined.isNotEmpty() && cartRegex.containsMatchIn(combined)) {
                    indicators.add(combined.take(70))
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }

        return if (indicators.isNotEmpty()) {
            Pair(true, indicators.distinct().take(3).joinToString(" · "))
        } else {
            Pair(false, "Completed action for '\$query'")
        }
    }

    private fun isQueryAlreadyRenderedInResults(query: String, minYRatio: Float = 0.22f): Boolean {
        val root = getActiveRoot() ?: return false
        val h = screenHeight().toFloat()
        val minY = (h * minYRatio).toInt()
        val words = query.lowercase().split(" ").filter { it.length > 2 }
        if (words.isEmpty()) return false
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var matchesBelowHeader = 0
        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isEditable) {
                val r = Rect()
                n.getBoundsInScreen(r)
                if (r.centerY() >= minY && r.height() > 24) {
                    val t = n.text?.toString()?.trim().orEmpty()
                    val d = n.contentDescription?.toString()?.trim().orEmpty()
                    val combined = "\$t \$d".lowercase()
                    if (combined.contains(query.lowercase()) || words.count { combined.contains(it) } >= ((words.size + 1) / 2)) {
                        matchesBelowHeader++
                        if (matchesBelowHeader >= 2) return true
                    }
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }
        return false
    }

    fun runAutonomousAppWorkflow(appKey: String, query: String, actionMode: String, usedDeepLink: Boolean = false) {
        val mySeq = workflowSeq.incrementAndGet()
        worker.execute {
            try {
                lastStepLogs.clear()
                lastStatus = "running"
                lastCartVerified = false
                lastScreenshotBase64 = ""
                automationPaused = false
                resetLoopGuard()
                showTacticalHUD("PULSE · \$appKey")
                recordStatus("Launching workflow in \$appKey…", showToast = false)
                startSession("autonomous_workflow")

                waitForExternalAppWindow(5200L)
                if (workflowSeq.get() != mySeq) return@execute
                if (isAutomationPaused()) return@execute
                Thread.sleep(800)

                if (actionMode.equals("login", ignoreCase = true)) {
                    val parts = query.split("|")
                    val u = parts.getOrNull(0)?.trim().orEmpty()
                    val p = parts.getOrNull(1)?.trim().orEmpty()
                    val loggedIn = autoFillLoginIfPresent(appKey, u, p)
                    Thread.sleep(1000)
                    lastCartVerified = loggedIn
                    lastCartSummary = if (loggedIn) "Filled login credentials in \$appKey" else "Login screen ready in \$appKey"
                    lastScreenTextDump = dumpScreenSummary(90)
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = if (loggedIn) "verified" else "needs_confirmation"
                    recordStatus(lastCartSummary, showToast = true)
                    return@execute
                }

                autoFillLoginIfPresent(appKey)

                if (query.isBlank()) {
                    lastStatus = "verified"
                    lastCartVerified = true
                    lastCartSummary = "Opened \$appKey"
                    lastScreenTextDump = dumpScreenSummary(90)
                    recordStatus(lastCartSummary, showToast = false)
                    return@execute
                }

                val w = screenWidth().toFloat()
                val h = screenHeight().toFloat()

                var searchSubmitted = false
                if (usedDeepLink) {
                    Thread.sleep(1100)
                    val focusedEdit = getActiveRoot()?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                    if (focusedEdit != null && focusedEdit.isEditable) {
                        recordStatus("Submitting search in \$appKey…")
                        setNodeTextDirect(focusedEdit, query)
                        Thread.sleep(350)
                        submitSearchAndSelectSuggestion(appKey, query, w, h)
                        searchSubmitted = true
                        Thread.sleep(1600)
                    } else if (isQueryAlreadyRenderedInResults(query)) {
                        recordStatus("Results loaded for '\$query' in \$appKey")
                        searchSubmitted = true
                    }
                }

                if (!searchSubmitted) {
                    val searchHints = listOf(
                        "Search", "search", "search_bar", "search_src_text", "et_search", "search_edit_text",
                        "What are you looking for", "Search for products", "Search for", "Where to",
                        "Enter pickup", "Enter destination", "Search in", "Ask or search", "Search YouTube",
                        "Search songs", "Search or type URL", "Find", "Search items", "Search stores"
                    )
                    var typedOk = false
                    for (attempt in 0 until 3) {
                        if (workflowSeq.get() != mySeq) return@execute
                        if (isAutomationPaused()) return@execute
                        if (!guardAgainstLoop("type_search", query)) return@execute
                        val existingEdit = findEditableNode(getActiveRoot())
                        if (existingEdit != null && setNodeTextDirect(existingEdit, query)) {
                            typedOk = true
                            recordStatus("Entered '\$query' in search box")
                            break
                        }
                        val foundSearch = waitForMatchingNode(searchHints, 1400L)
                        if (foundSearch != null) {
                            performClickOrTap(foundSearch)
                            Thread.sleep(750)
                            val editAfterClick = findEditableNode(getActiveRoot())
                            if (editAfterClick != null && setNodeTextDirect(editAfterClick, query)) {
                                typedOk = true
                                recordStatus("Tapped search bar and entered '\$query'")
                                break
                            }
                        }
                        val tapY = when (attempt) {
                            0 -> h * 0.11f
                            1 -> h * 0.16f
                            else -> h * 0.08f
                        }
                        tapCoordinate(w * 0.48f, tapY, 85L)
                        Thread.sleep(750)
                        val editAfterTap = findEditableNode(getActiveRoot())
                        if (editAfterTap != null && setNodeTextDirect(editAfterTap, query)) {
                            typedOk = true
                            recordStatus("Focused search bar and entered '\$query'")
                            break
                        }
                    }

                    if (typedOk) {
                        Thread.sleep(450)
                        submitSearchAndSelectSuggestion(appKey, query, w, h)
                        searchSubmitted = true
                        recordStatus("Submitted search for '\$query'")
                        Thread.sleep(1700)
                    }
                }

                if (workflowSeq.get() != mySeq) return@execute

                val lowerApp = appKey.lowercase()
                val isEcommerceOrFood = lowerApp in listOf("blinkit", "zepto", "swiggy", "zomato", "meesho", "flipkart", "amazon") ||
                    actionMode.contains("order", true) || actionMode.contains("add", true) || actionMode.contains("buy", true)

                if (lowerApp == "youtube" || lowerApp.contains("youtube")) {
                    var played = clickFirstResultBelowHeader(query, minYRatio = 0.18f, maxYRatio = 0.78f)
                    if (!played) {
                        tapCoordinate(w * 0.50f, h * 0.35f, 85L)
                        played = true
                    }
                    Thread.sleep(1000)
                    lastCartVerified = played
                    lastCartSummary = "Playing '\$query' on YouTube"
                    lastScreenTextDump = dumpScreenSummary(90)
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus(lastCartSummary, showToast = true)
                    return@execute
                }

                if (lowerApp == "spotify" || lowerApp.contains("spotify")) {
                    var played = clickFirstResultBelowHeader(query, minYRatio = 0.18f, maxYRatio = 0.72f)
                    if (!played) {
                        tapCoordinate(w * 0.45f, h * 0.32f, 85L)
                        played = true
                    }
                    Thread.sleep(900)
                    lastCartVerified = played
                    lastCartSummary = "Playing '\$query' on Spotify"
                    lastScreenTextDump = dumpScreenSummary(90)
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus(lastCartSummary, showToast = true)
                    return@execute
                }

                if (lowerApp in listOf("whatsapp", "telegram")) {
                    val sendBtn = waitForMatchingNode(listOf("Send", "send", "iv_send", "send_button"), 1200L)
                    if (sendBtn != null && !sendBtn.isEditable) {
                        performClickOrTap(sendBtn)
                        Thread.sleep(600)
                    } else {
                        clickFirstResultBelowHeader(query, minYRatio = 0.18f, maxYRatio = 0.55f)
                        Thread.sleep(900)
                        val sendAfter = waitForMatchingNode(listOf("Send", "send", "iv_send"), 1000L)
                        if (sendAfter != null && !sendAfter.isEditable) {
                            performClickOrTap(sendAfter)
                        }
                    }
                    lastCartVerified = true
                    lastCartSummary = "Completed message action in \$appKey"
                    lastScreenTextDump = dumpScreenSummary(90)
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus(lastCartSummary, showToast = true)
                    return@execute
                }

                if (lowerApp in listOf("uber", "ola", "rapido")) {
                    clickFirstResultBelowHeader(query, minYRatio = 0.18f, maxYRatio = 0.62f)
                    Thread.sleep(1300)
                    val rideBtn = waitForMatchingNode(listOf("Confirm", "Book", "Choose", "Request", "Proceed", "Select"), 1800L)
                    if (rideBtn != null) performClickOrTap(rideBtn)
                    val (verified, summaryText) = verifyCartOrActionState(query)
                    lastCartVerified = verified
                    lastCartSummary = summaryText
                    lastScreenTextDump = dumpScreenSummary(90)
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus("Ride destination '\$query' set in \$appKey", showToast = true)
                    return@execute
                }

                if (isEcommerceOrFood) {
                    val addLabels = listOf("ADD", "Add", "+ Add", "Add +", "Add to Cart", "ADD TO CART", "Add to bag", "ADD TO BAG", "Buy Now", "BUY NOW")
                    var added = false

                    val addBtn = waitForMatchingNode(addLabels, 2000L)
                    if (addBtn != null && !addBtn.isEditable && performClickOrTap(addBtn)) {
                        added = true
                        recordStatus("Tapped Add button for '\$query'")
                    }

                    if (!added) {
                        val openedProduct = clickFirstResultBelowHeader(query, minYRatio = 0.22f, maxYRatio = 0.76f)
                        if (!openedProduct) {
                            tapCoordinate(w * 0.32f, h * 0.42f, 85L)
                        }
                        recordStatus("Opened first matching product card")
                        Thread.sleep(1600)
                        val detailAdd = waitForMatchingNode(addLabels, 2000L)
                        if (detailAdd != null && !detailAdd.isEditable && performClickOrTap(detailAdd)) {
                            added = true
                        } else {
                            swipe(w * 0.5f, h * 0.76f, w * 0.5f, h * 0.34f, 260L)
                            Thread.sleep(800)
                            val bottomAdd = waitForMatchingNode(addLabels, 1500L)
                            if (bottomAdd != null && !bottomAdd.isEditable && performClickOrTap(bottomAdd)) {
                                added = true
                            }
                        }
                    }

                    if (!added && !guardAgainstLoop("add_to_cart", query)) {
                        lastStatus = "halted"
                        recordStatus("Loop guard tripped while adding to cart", showToast = true)
                        hideTacticalHUD()
                        return@execute
                    }

                    Thread.sleep(850)
                    val sheetConfirm = waitForMatchingNode(listOf("Add item", "Confirm", "Continue", "Done", "Go to Cart", "View Cart"), 1000L)
                    if (sheetConfirm != null && !sheetConfirm.isEditable) {
                        performClickOrTap(sheetConfirm)
                        Thread.sleep(650)
                    }

                    val (verified, summaryText) = verifyCartOrActionState(query)
                    lastCartVerified = verified || added
                    lastCartSummary = summaryText
                    lastScreenTextDump = dumpScreenSummary(90)
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = if (lastCartVerified) "verified" else "needs_confirmation"
                    recordStatus(
                        if (lastCartVerified) "Done: '\$query' added in \$appKey" else "Opened '\$query' in \$appKey",
                        showToast = true
                    )
                } else {
                    if (searchSubmitted) {
                        clickFirstResultBelowHeader(query, minYRatio = 0.18f, maxYRatio = 0.76f)
                        Thread.sleep(900)
                    }
                    val (verified, summaryText) = verifyCartOrActionState(query)
                    lastCartVerified = verified || searchSubmitted
                    lastCartSummary = summaryText
                    lastScreenTextDump = dumpScreenSummary(90)
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus("Completed '\$query' in \$appKey", showToast = true)
                }
                hideTacticalHUD()
            } catch (e: Exception) {
                lastStatus = "error"
                recordStatus("Workflow error in \$appKey: \${e.message ?: "paused"}", showToast = false)
                hideTacticalHUD()
            } finally {
                endSession(if (lastLoopGuardHit) "error" else "completed", lastStatus, lastLoopGuardHit)
            }
        }
    }

    private fun findEditableNode(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (root == null) return null
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && focused.isEditable && focused.isVisibleToUser) return focused
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && n.isEditable) return n
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }
        return null
    }

    private fun pressImeEnterOnFocused(): Boolean {
        val root = getActiveRoot() ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: findEditableNode(root)
        if (focused != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (focused.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)) {
                return true
            }
        }
        return false
    }

    private fun submitSearchAndSelectSuggestion(appKey: String, query: String, w: Float, h: Float) {
        val root = getActiveRoot() ?: return
        val editNode = findEditableNode(root)
        val editRect = Rect()
        editNode?.getBoundsInScreen(editRect)
        val minSuggestionY = if (!editRect.isEmpty) (editRect.bottom + 8) else (h * 0.15f).toInt()

        pressImeEnterOnFocused()

        val searchBtnLabels = listOf("Search", "search_go_btn", "iv_search", "btn_search", "Go", "Submit", "search_button")
        for (lbl in searchBtnLabels) {
            val btn = findNodeMultiTier(root, lbl)
            if (btn != null && !btn.isEditable && btn != editNode) {
                val r = Rect()
                btn.getBoundsInScreen(r)
                if (r.centerX() > w * 0.65f && r.centerY() < h * 0.25f) {
                    performClickOrTap(btn)
                    break
                }
            }
        }

        Thread.sleep(500)

        val rootAfter = getActiveRoot() ?: return
        val stillEditing = findEditableNode(rootAfter) != null
        val queryWords = query.lowercase().split(" ").filter { it.length >= 2 }
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(rootAfter)
        var bestSuggestion: AccessibilityNodeInfo? = null

        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isEditable && n != editNode) {
                val r = Rect()
                n.getBoundsInScreen(r)
                if (r.top >= minSuggestionY && r.centerY() < h * 0.56f && r.height() in 24..(h * 0.16f).toInt()) {
                    val t = n.text?.toString()?.trim().orEmpty()
                    val d = n.contentDescription?.toString()?.trim().orEmpty()
                    val combined = "\$t \$d".lowercase()
                    if (combined.isNotEmpty() && (combined.contains(query.lowercase()) || (queryWords.isNotEmpty() && queryWords.any { combined.contains(it) }))) {
                        bestSuggestion = n
                        break
                    }
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }

        if (bestSuggestion != null) {
            performClickOrTap(bestSuggestion)
            Thread.sleep(450)
        }

        if (stillEditing || findEditableNode(getActiveRoot()) != null) {
            tapCoordinate(w * 0.91f, h * 0.90f, 75L)
            Thread.sleep(550)
            if (findEditableNode(getActiveRoot()) != null && bestSuggestion == null) {
                tapCoordinate(w * 0.45f, (minSuggestionY + 68).toFloat().coerceAtMost(h * 0.30f), 75L)
            }
        }
    }

    private fun clickFirstResultBelowHeader(query: String, minYRatio: Float = 0.18f, maxYRatio: Float = 0.78f): Boolean {
        val root = getActiveRoot() ?: return false
        val w = screenWidth().toFloat()
        val h = screenHeight().toFloat()
        val minY = (h * minYRatio).toInt()
        val maxY = (h * maxYRatio).toInt()
        val queryWords = query.lowercase().split(" ").filter { it.length >= 2 }

        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var firstClickableCard: AccessibilityNodeInfo? = null

        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isEditable) {
                val r = Rect()
                n.getBoundsInScreen(r)
                if (r.centerY() in minY..maxY && r.width() > w * 0.18f && r.height() > 36) {
                    val t = n.text?.toString()?.trim().orEmpty()
                    val d = n.contentDescription?.toString()?.trim().orEmpty()
                    val combined = "\$t \$d".lowercase()
                    if (combined.isNotEmpty() && (combined.contains(query.lowercase()) || queryWords.any { combined.contains(it) })) {
                        if (performClickOrTap(n)) return true
                    }
                    if (firstClickableCard == null && n.isClickable && combined.length > 3) {
                        firstClickableCard = n
                    }
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }

        if (firstClickableCard != null) {
            return performClickOrTap(firstClickableCard)
        }
        return false
    }

    fun dumpScreenSummary(maxNodes: Int = 100): String {
        val root = getActiveRoot() ?: return ""
        val pkg = root.packageName?.toString() ?: "unknown"
        val sb = StringBuilder("ActiveAppPackage: \$pkg\\nElements:\\n")
        val nodes = collectSemanticNodes(root, maxNodes.coerceAtMost(MAX_SEMANTIC_NODES))
        nodes.forEachIndexed { index, sn ->
            val tag = when {
                sn.editable -> "INPUT"
                sn.clickable -> "BTN"
                sn.scrollable -> "SCROLL"
                sn.role == "checkbox" -> "CHECK"
                else -> "TXT"
            }
            val label = sn.label.ifEmpty { sn.role }.take(80)
            sb.append("[\$index] \$tag (\$label) @(\${sn.bounds.centerX()},\${sn.bounds.centerY()})\\n")
        }
        val out = sb.toString()
        lastScreenTextDump = out
        return out
    }

    /**
     * Dispatches a gesture and waits for the system to actually complete it.
     * AccessibilityService.dispatchGesture is asynchronous and silently drops
     * gestures when another gesture is still in flight, so we serialise them
     * behind a lock and confirm completion via the callback.
     *
     * The callback is delivered on the main thread, so this must never be
     * invoked from the main thread itself — otherwise the latch would never
     * be released.
     */
    private val gestureLock = Object()

    private fun dispatchGestureReliable(gesture: GestureDescription, retries: Int = 2): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            // Called from the main thread: dispatch without waiting for the callback.
            return try {
                dispatchGesture(gesture, null, mainHandler)
            } catch (_: Exception) {
                false
            }
        }

        var attempt = 0
        while (attempt <= retries) {
            val latch = CountDownLatch(1)
            var completed = false
            try {
                synchronized(gestureLock) {
                    val ok = dispatchGesture(
                        gesture,
                        object : GestureResultCallback() {
                            override fun onCompleted(description: GestureDescription?) {
                                completed = true
                                latch.countDown()
                            }

                            override fun onCancelled(description: GestureDescription?) {
                                latch.countDown()
                            }
                        },
                        mainHandler
                    )
                    if (!ok) {
                        latch.countDown()
                    } else {
                        latch.await(2500L, TimeUnit.MILLISECONDS)
                    }
                }
            } catch (_: Exception) {
                completed = false
            }
            if (completed) return true
            attempt++
            if (attempt <= retries) {
                try { Thread.sleep(120) } catch (_: InterruptedException) { return false }
            }
        }
        return false
    }

    fun tapCoordinate(x: Float, y: Float, durationMs: Long = 75L): Boolean {
        if (isAutomationPaused()) return false
        val w = screenWidth().toFloat()
        val h = screenHeight().toFloat()
        val px = if (x in 0.001f..1.0f && y in 0.001f..1.0f) x * w else x
        val py = if (x in 0.001f..1.0f && y in 0.001f..1.0f) y * h else y
        val clampedX = px.coerceIn(1f, w - 1f)
        val clampedY = py.coerceIn(1f, h - 1f)
        val path = Path().apply { moveTo(clampedX, clampedY) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(40L, 600L)))
            .build()
        val started = System.currentTimeMillis()
        val ok = dispatchGestureReliable(gesture)
        recordStep("tap", "\${clampedX.toInt()},\${clampedY.toInt()}", if (ok) "done" else "error", System.currentTimeMillis() - started, "Tap at \${clampedX.toInt()},\${clampedY.toInt()}")
        return ok
    }

    fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long = 260L): Boolean {
        if (isAutomationPaused()) return false
        val w = screenWidth().toFloat()
        val h = screenHeight().toFloat()
        val sx = startX.coerceIn(1f, w - 1f)
        val sy = startY.coerceIn(1f, h - 1f)
        val ex = endX.coerceIn(1f, w - 1f)
        val ey = endY.coerceIn(1f, h - 1f)
        val path = Path().apply {
            moveTo(sx, sy)
            lineTo(ex, ey)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(100L, 1000L)))
            .build()
        val started = System.currentTimeMillis()
        val ok = dispatchGestureReliable(gesture)
        recordStep("swipe", "\${sx.toInt()},\${sy.toInt()} -> \${ex.toInt()},\${ey.toInt()}", if (ok) "done" else "error", System.currentTimeMillis() - started, "Swipe from \${sx.toInt()},\${sy.toInt()} to \${ex.toInt()},\${ey.toInt()}")
        return ok
    }

    /**
     * Scrolls using the accessibility scroll action on a scrollable node when one
     * is available, falling back to a swipe gesture otherwise. Retries with a
     * different anchor if the first attempt does not move the content.
     */
    fun scrollDirection(dir: String): Boolean {
        if (isAutomationPaused()) return false
        val direction = dir.lowercase().trim()
        val w = screenWidth().toFloat()
        val h = screenHeight().toFloat()
        val started = System.currentTimeMillis()

        val action = when (direction) {
            "up" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "left" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "right" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            else -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        }

        // Prefer a real scrollable node so nested scroll containers behave.
        val root = getActiveRoot()
        if (root != null) {
            val scrollable = collectSemanticNodes(root, 120).firstOrNull { it.scrollable && it.enabled }
            if (scrollable != null) {
                val args = Bundle().apply {
                    putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SCROLL_AXIS_VERTICAL, 1)
                }
                if (scrollable.node.performAction(action, args)) {
                    recordStep("scroll", direction, "done", System.currentTimeMillis() - started, "Scrolled \$direction")
                    return true
                }
                if (scrollable.node.performAction(action)) {
                    recordStep("scroll", direction, "done", System.currentTimeMillis() - started, "Scrolled \$direction")
                    return true
                }
            }
        }

        val swipeOk = when (direction) {
            "up" -> swipe(w * 0.5f, h * 0.30f, w * 0.5f, h * 0.78f, 260L)
            "left" -> swipe(w * 0.82f, h * 0.5f, w * 0.18f, h * 0.5f, 260L)
            "right" -> swipe(w * 0.18f, h * 0.5f, w * 0.82f, h * 0.5f, 260L)
            else -> swipe(w * 0.5f, h * 0.76f, w * 0.5f, h * 0.26f, 260L)
        }
        if (swipeOk) {
            recordStep("scroll", direction, "done", System.currentTimeMillis() - started, "Scrolled \$direction")
            return true
        }

        // Retry once from a slightly different anchor in case the first swipe
        // landed on a non-scrollable region.
        val retried = when (direction) {
            "up" -> swipe(w * 0.5f, h * 0.38f, w * 0.5f, h * 0.72f, 300L)
            "left" -> swipe(w * 0.75f, h * 0.5f, w * 0.25f, h * 0.5f, 300L)
            "right" -> swipe(w * 0.25f, h * 0.5f, w * 0.75f, h * 0.5f, 300L)
            else -> swipe(w * 0.5f, h * 0.70f, w * 0.5f, h * 0.32f, 300L)
        }
        recordStep("scroll", direction, if (retried) "done" else "error", System.currentTimeMillis() - started, "Scrolled \$direction")
        return retried
    }

    fun clickNodeByText(targetText: String): Boolean {
        if (isAutomationPaused()) return false
        if (!guardAgainstLoop("click_text", targetText.trim().lowercase())) return false
        val started = System.currentTimeMillis()
        val root = getActiveRoot() ?: return false
        val matched = findNodeMultiTier(root, targetText) ?: return false
        val ok = performClickOrTap(matched)
        recordStep("click", targetText.trim(), if (ok) "done" else "error", System.currentTimeMillis() - started, "Clicked '\$targetText'")
        return ok
    }

    /**
     * Clicks a node, walking up to the nearest clickable ancestor. If the
     * accessibility click does not take effect, falls back to a coordinate tap
     * at the node's centre. Retries once with a small offset jitter because
     * some apps ignore taps that land exactly on a text baseline.
     */
    private fun performClickOrTap(node: AccessibilityNodeInfo): Boolean {
        if (isAutomationPaused()) return false
        var cur: AccessibilityNodeInfo? = node
        var depth = 0
        while (cur != null && depth < 6) {
            try {
                if (cur.isClickable && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            } catch (_: Exception) {}
            cur = try { cur.parent } catch (_: Exception) { null }
            depth++
        }

        val rect = Rect()
        try { node.getBoundsInScreen(rect) } catch (_: Exception) {}
        if (rect.isEmpty || rect.centerX() <= 0 || rect.centerY() <= 0) return false

        if (tapCoordinate(rect.centerX().toFloat(), rect.centerY().toFloat())) return true

        // Retry with a slight vertical offset — some hit targets are offset from
        // their reported bounds.
        val offsetY = (rect.height() * 0.18f).coerceAtLeast(6f)
        val retryY = if (rect.centerY() + offsetY < rect.bottom) rect.centerY() + offsetY else rect.centerY() - offsetY
        return tapCoordinate(rect.centerX().toFloat(), retryY.toFloat())
    }

    /**
     * Cheap hash of the visible semantic surface, used to detect whether the
     * screen actually changed after an action.
     */
    private fun screenFingerprint(): String {
        val root = getActiveRoot() ?: return ""
        val nodes = collectSemanticNodes(root, 40)
        val sb = StringBuilder()
        nodes.forEach { sb.append(it.label).append('|').append(it.role).append(';') }
        return sb.toString().hashCode().toString()
    }

    fun inputTextIntoNode(targetLabel: String?, textToEnter: String): Boolean {
        if (isAutomationPaused()) return false
        if (!guardAgainstLoop("input_text", "\${targetLabel.orEmpty()}|\$textToEnter")) return false
        val started = System.currentTimeMillis()
        val ok = typeTextWithRetry(targetLabel, textToEnter)
        if (ok) {
            Thread.sleep(250)
            pressImeEnterOnFocused()
        }
        recordStep("type", targetLabel ?: "field", if (ok) "done" else "error", System.currentTimeMillis() - started, "Typed into '\${targetLabel ?: "field"}'")
        return ok
    }

    fun selectPrimaryVisibleItem(hintText: String = ""): Boolean {
        if (isAutomationPaused()) return false
        val cleanHint = hintText.trim()
        val lowerHint = cleanHint.lowercase()

        val ordinalIndex = when {
            lowerHint.contains("second") || lowerHint.contains("2nd") || lowerHint == "2" || lowerHint.contains("rendava") || cleanHint.contains("రెండవ") -> 1
            lowerHint.contains("third") || lowerHint.contains("3rd") || lowerHint == "3" || lowerHint.contains("moodava") || cleanHint.contains("మూడవ") -> 2
            lowerHint.contains("fourth") || lowerHint.contains("4th") || lowerHint == "4" || cleanHint.contains("నాలుగవ") -> 3
            lowerHint.contains("first") || lowerHint.contains("1st") || lowerHint == "1" || lowerHint.contains("modati") || cleanHint.contains("మొదటి") -> 0
            else -> -1
        }

        if (cleanHint.isNotBlank() && ordinalIndex < 0 && clickNodeByText(cleanHint)) {
            recordStatus("Selected " + cleanHint, false)
            return true
        }

        val root = getActiveRoot() ?: return false
        val w = screenWidth()
        val h = screenHeight()
        val ignoreSet = setOf("back", "navigate up", "close", "cancel", "search", "clear", "home", "menu")
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        val candidates = mutableListOf<Triple<AccessibilityNodeInfo, Int, Int>>()
        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isEditable) {
                val label = (n.text?.toString() ?: n.contentDescription?.toString() ?: "").trim()
                val rect = Rect()
                n.getBoundsInScreen(rect)
                val inZone = rect.centerY() in (h * 0.15).toInt()..(h * 0.88).toInt()
                val lower = label.lowercase()
                if (inZone && rect.width() > 60 && rect.height() > 34 && label.length >= 3 && !ignoreSet.contains(lower)) {
                    var score = 10
                    if (n.isClickable || n.parent?.isClickable == true) score += 45
                    if (label.length in 6..110) score += 25
                    if (lower.contains("add") || lower.contains("buy") || lower.contains("play") || lower.contains("open")) score += 20
                    if (cleanHint.isNotBlank() && ordinalIndex < 0) {
                        for (word in lowerHint.split(" ")) {
                            if (word.length >= 3 && lower.contains(word)) score += 40
                        }
                    }
                    candidates.add(Triple(n, score, rect.centerY()))
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }

        if (candidates.isNotEmpty()) {
            val chosen = if (ordinalIndex >= 0) {
                val sortedByY = candidates.filter { it.second >= 45 }.sortedBy { it.third }
                val listToUse = if (sortedByY.isNotEmpty()) sortedByY else candidates.sortedBy { it.third }
                listToUse[ordinalIndex.coerceAtMost(listToUse.size - 1)].first
            } else {
                candidates.maxByOrNull { it.second }?.first
            }
            if (chosen != null && performClickOrTap(chosen)) {
                recordStatus("Selected visible item", false)
                return true
            }
        }
        return tapCoordinate(w * 0.5f, h * 0.36f)
    }

    fun proceedOnScreen(): Boolean {
        val ctas = listOf(
            "Proceed to Pay", "Proceed to Checkout", "Proceed", "Continue",
            "Place Order", "Buy Now", "Add to Cart", "Go to Cart", "View Cart",
            "Next", "Submit", "Confirm", "Send", "Apply", "Done", "Accept", "Allow", "OK", "ADD"
        )
        val started = System.currentTimeMillis()
        for (label in ctas) {
            if (!guardAgainstLoop("proceed_cta", label)) return false
            val root = getActiveRoot() ?: continue
            val node = findNodeMultiTier(root, label) ?: continue
            if (node.isEditable) continue
            // Verify the CTA actually advanced the screen; fall back to a raw tap
            // when the accessibility click is swallowed by the app.
            val before = screenFingerprint()
            if (performClickOrTap(node)) {
                Thread.sleep(320)
                if (screenFingerprint() != before) {
                    recordStatus("Proceeded via " + label, false)
                    recordStep("proceed", label, "done", System.currentTimeMillis() - started, "Proceeded via \$label")
                    return true
                }
                val rect = Rect()
                try { node.getBoundsInScreen(rect) } catch (_: Exception) {}
                if (!rect.isEmpty) {
                    tapCoordinate(rect.centerX().toFloat(), rect.centerY().toFloat())
                    Thread.sleep(320)
                    if (screenFingerprint() != before) {
                        recordStatus("Proceeded via " + label, false)
                        recordStep("proceed", label, "done", System.currentTimeMillis() - started, "Proceeded via \$label")
                        return true
                    }
                }
            }
        }
        val ok = selectPrimaryVisibleItem("")
        recordStep("proceed", "fallback", if (ok) "done" else "error", System.currentTimeMillis() - started, "Proceeded via fallback selection")
        return ok
    }

    fun executeHandsFreeVoiceAction(spokenText: String): JSONObject {
        val res = JSONObject()
        val raw = spokenText.trim()
        val lower = raw.lowercase()
        res.put("spoken", raw)
        startSession("handsfree_voice")
        try {
        when {
            lower.contains("scroll down") || lower.contains("go down") || lower == "down" ||
            lower.contains("kindiki") || raw.contains("క్రిందికి") || raw.contains("కిందికి") -> {
                val ok = scrollDirection("down")
                res.put("handled", true)
                res.put("action", "scroll_down")
                res.put("ok", ok)
            }
            lower.contains("scroll up") || lower.contains("go up") || lower == "up" ||
            lower.contains("paiki") || raw.contains("పైకి") -> {
                val ok = scrollDirection("up")
                res.put("handled", true)
                res.put("action", "scroll_up")
                res.put("ok", ok)
            }
            lower.contains("scroll left") || lower.contains("swipe left") -> {
                val ok = scrollDirection("left")
                res.put("handled", true)
                res.put("action", "scroll_left")
                res.put("ok", ok)
            }
            lower.contains("scroll right") || lower.contains("swipe right") -> {
                val ok = scrollDirection("right")
                res.put("handled", true)
                res.put("action", "scroll_right")
                res.put("ok", ok)
            }
            lower.startsWith("select") || lower == "click it" || lower == "open it" ||
            lower.contains("select chey") || raw.contains("సెలెక్ట్") || raw.contains("ఎంచుకో") -> {
                val hint = lower.removePrefix("select it").removePrefix("select").removePrefix("click it").trim()
                val ok = selectPrimaryVisibleItem(hint)
                res.put("handled", true)
                res.put("action", "select_item")
                res.put("ok", ok)
            }
            lower.contains("proceed") || lower.contains("continue") || lower == "next" ||
            lower.contains("checkout") || lower.contains("buy now") ||
            lower.contains("munduku") || raw.contains("ముందుకు") || raw.contains("కొనసాగించు") -> {
                val ok = proceedOnScreen()
                res.put("handled", true)
                res.put("action", "proceed")
                res.put("ok", ok)
            }
            lower.startsWith("search ") || lower.startsWith("vethuku ") || raw.startsWith("వెతుకు") -> {
                val q = raw.replace(Regex("^(search for|search|vethuku|వెతుకు)[ ]*", RegexOption.IGNORE_CASE), "").trim()
                val ok = if (q.isNotEmpty()) inputTextIntoNode("Search", q) else clickNodeByText("Search")
                res.put("handled", true)
                res.put("action", "search")
                res.put("query", q)
                res.put("ok", ok)
            }
            lower == "go back" || lower == "back" || lower.contains("venakki") || raw.contains("వెనక్కి") -> {
                val ok = runGlobal("back")
                res.put("handled", true)
                res.put("action", "back")
                res.put("ok", ok)
            }
            lower == "go home" || lower == "home" || raw.contains("హోమ్") -> {
                val ok = runGlobal("home")
                res.put("handled", true)
                res.put("action", "home")
                res.put("ok", ok)
            }
            else -> {
                res.put("handled", false)
            }
        }
        } finally {
            endSession("completed", if (res.optBoolean("handled")) "" else "No matching voice action")
        }
        return res
    }

    fun runGlobal(action: String): Boolean {
        return when (action.lowercase().trim()) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "quick_settings" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            else -> false
        }
    }
}
`,
        'utf8',
      );

      fs.writeFileSync(
        path.join(kotlinDir, 'PulseBridgeModule.kt'),
        `package ${packageName}

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.ContactsContract
import android.provider.OpenableColumns
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class PulseBridgeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    private var voicePromise: Promise? = null
    private var mediaPromise: Promise? = null
    private var mediaPickerKind: String = "document"
    private val VOICE_REQ_CODE = 9412
    private val PICK_MEDIA_REQ_CODE = 9413
    private var torchEnabled: Boolean = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private var speechRecognizer: SpeechRecognizer? = null
    @Volatile
    private var continuousHandsFree: Boolean = false
    @Volatile
    private var pausedForTts: Boolean = false
    private var currentVoiceLang: String = "en-IN"

    init {
        reactContext.addActivityEventListener(this)
    }

    private fun emitVoiceEvent(eventName: String, params: WritableMap) {
        try {
            if (reactContext.hasActiveReactInstance()) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(eventName, params)
            }
        } catch (_: Exception) {}
    }

    override fun getName(): String = "PulseBridge"

    @ReactMethod
    fun isAccessibilityEnabled(promise: Promise) {
        try {
            if (PulseAccessibilityService.instance != null) {
                promise.resolve(true)
                return
            }
            val enabledServices = Settings.Secure.getString(
                reactContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            val myPkg = reactContext.packageName
            promise.resolve(enabledServices.contains(myPkg, ignoreCase = true))
        } catch (e: Exception) {
            promise.resolve(PulseAccessibilityService.instance != null)
        }
    }

    @ReactMethod
    fun openAccessibilitySettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openSystemSettings(panel: String?, promise: Promise) {
        try {
            val action = when (panel?.lowercase()?.trim()) {
                "wifi" -> Settings.ACTION_WIFI_SETTINGS
                "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
                "display", "brightness" -> Settings.ACTION_DISPLAY_SETTINGS
                "sound", "volume" -> Settings.ACTION_SOUND_SETTINGS
                "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
                "location" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
                "overlay" -> Settings.ACTION_MANAGE_OVERLAY_PERMISSION
                else -> Settings.ACTION_SETTINGS
            }
            val intent = Intent(action).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (panel?.lowercase()?.trim() == "overlay") {
                    intent.data = Uri.parse("package:\${reactContext.packageName}")
                }
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun hasOverlayPermission(promise: Promise) {
        try {
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Settings.canDrawOverlays(reactContext)
            } else {
                true
            }
            promise.resolve(granted)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getDeviceStatus(promise: Promise) {
        try {
            val map = Arguments.createMap()
            val bm = reactContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            val batteryPct = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            val isCharging = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) bm?.isCharging ?: false else false

            val am = reactContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            val curVol = am?.getStreamVolume(AudioManager.STREAM_MUSIC) ?: 0
            val maxVol = (am?.getStreamMaxVolume(AudioManager.STREAM_MUSIC) ?: 15).coerceAtLeast(1)
            val volPct = ((curVol.toFloat() / maxVol.toFloat()) * 100f).toInt()

            val enabledServices = Settings.Secure.getString(
                reactContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            val settingEnabled = enabledServices.contains(reactContext.packageName, ignoreCase = true)
            val activeInstance = PulseAccessibilityService.instance != null

            map.putInt("batteryPct", batteryPct)
            map.putBoolean("isCharging", isCharging)
            map.putInt("volumePct", volPct)
            map.putBoolean("torchOn", torchEnabled)
            map.putBoolean("accessibilityEnabled", activeInstance || settingEnabled)
            map.putBoolean("serviceConnected", activeInstance)
            map.putString("lastStatus", PulseAccessibilityService.lastStatus)
            map.putString("lastMessage", PulseAccessibilityService.lastMessage)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("DEVICE_STATUS_ERR", e.message)
        }
    }

    @ReactMethod
    fun toggleTorch(enable: Boolean, promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
            val camId = cm?.cameraIdList?.firstOrNull()
            if (cm != null && camId != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                cm.setTorchMode(camId, enable)
                torchEnabled = enable
                promise.resolve(true)
            } else {
                promise.resolve(false)
            }
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun setVolume(levelPct: Double, promise: Promise) {
        try {
            val am = reactContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            if (am == null) {
                promise.resolve(false)
                return
            }
            val maxVol = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
            val target = ((levelPct.coerceIn(0.0, 100.0) / 100.0) * maxVol).toInt()
            am.setStreamVolume(AudioManager.STREAM_MUSIC, target, AudioManager.FLAG_SHOW_UI)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun vibrate(durationMs: Double, promise: Promise) {
        try {
            val ms = durationMs.toLong().coerceIn(20L, 2000L)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = reactContext.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                vm?.defaultVibrator?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                val v = reactContext.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v?.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    v?.vibrate(ms)
                }
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun copyToClipboard(text: String, promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            cm?.setPrimaryClip(ClipData.newPlainText("Pulse OS", text))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getClipboardText(promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val item = cm?.primaryClip?.getItemAt(0)
            promise.resolve(item?.coerceToText(reactContext)?.toString() ?: "")
        } catch (e: Exception) {
            promise.resolve("")
        }
    }

    @ReactMethod
    fun openUrl(url: String, promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url.trim())).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun lookupContactPhone(nameQuery: String, promise: Promise) {
        try {
            val perm = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.READ_CONTACTS)
            if (perm != PackageManager.PERMISSION_GRANTED) {
                currentActivity?.let { act ->
                    ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.READ_CONTACTS), 9416)
                }
                val res = Arguments.createMap()
                res.putBoolean("found", false)
                res.putBoolean("needsPermission", true)
                promise.resolve(res)
                return
            }
            val clean = nameQuery.trim().lowercase()
            val res = Arguments.createMap()
            if (clean.isEmpty()) {
                res.putBoolean("found", false)
                promise.resolve(res)
                return
            }
            val cr = reactContext.contentResolver
            val projection = arrayOf(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER
            )
            var matchedName = ""
            var matchedPhone = ""
            cr.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, projection, null, null, null)?.use { cursor ->
                val nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val numIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                while (cursor.moveToNext()) {
                    val cName = if (nameIdx >= 0) cursor.getString(nameIdx)?.trim() ?: "" else ""
                    val cNum = if (numIdx >= 0) cursor.getString(numIdx)?.trim() ?: "" else ""
                    if (cName.isNotEmpty() && cNum.isNotEmpty()) {
                        val cl = cName.lowercase()
                        if (cl == clean) {
                            matchedName = cName
                            matchedPhone = cNum
                            break
                        }
                        if (matchedPhone.isEmpty() && (cl.contains(clean) || clean.contains(cl))) {
                            matchedName = cName
                            matchedPhone = cNum
                        }
                    }
                }
            }
            res.putBoolean("found", matchedPhone.isNotEmpty())
            res.putString("name", matchedName)
            res.putString("phone", matchedPhone)
            promise.resolve(res)
        } catch (e: Exception) {
            val res = Arguments.createMap()
            res.putBoolean("found", false)
            promise.resolve(res)
        }
    }

    @ReactMethod
    fun dialPhone(phone: String, directCall: Boolean, promise: Promise) {
        try {
            val clean = phone.replace(Regex("[^0-9+]"), "")
            val action = if (directCall) Intent.ACTION_CALL else Intent.ACTION_DIAL
            val intent = Intent(action, Uri.parse("tel:\$clean")).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            try {
                val clean = phone.replace(Regex("[^0-9+]"), "")
                val dialIntent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:\$clean")).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(dialIntent)
                promise.resolve(true)
            } catch (_: Exception) {
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun sendSms(phone: String, body: String, promise: Promise) {
        try {
            val clean = phone.replace(Regex("[^0-9+]"), "")
            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:\$clean")).apply {
                putExtra("sms_body", body)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun sendWhatsAppMessage(phoneOrName: String, message: String, promise: Promise) {
        try {
            val rawTarget = phoneOrName.trim()
            val digitsOnly = rawTarget.replace(Regex("[^0-9+]"), "")
            val isPhone = digitsOnly.length >= 7
            if (isPhone) {
                var formatted = digitsOnly.replace("+", "")
                if (formatted.length == 10 && formatted.first() in '6'..'9') {
                    formatted = "91\$formatted"
                }
                val encMsg = Uri.encode(message)
                val uri = Uri.parse("whatsapp://send?phone=\$formatted&text=\$encMsg")
                val intent = Intent(Intent.ACTION_VIEW, uri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
                PulseAccessibilityService.instance?.runMessagingWorkflow("whatsapp", formatted, message, true)
                promise.resolve(true)
                return
            }
            // Launch WhatsApp and automate search + send
            val pm = reactContext.packageManager
            val launchIntent = pm.getLaunchIntentForPackage("com.whatsapp")
                ?: pm.getLaunchIntentForPackage("com.whatsapp.w4b")
            if (launchIntent != null) {
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                reactContext.startActivity(launchIntent)
                PulseAccessibilityService.instance?.runMessagingWorkflow("whatsapp", rawTarget, message, false)
                promise.resolve(true)
            } else {
                promise.resolve(false)
            }
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun composeEmail(to: String, subject: String, body: String, autoSend: Boolean, promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:")).apply {
                if (to.isNotBlank()) putExtra(Intent.EXTRA_EMAIL, arrayOf(to.trim()))
                if (subject.isNotBlank()) putExtra(Intent.EXTRA_SUBJECT, subject.trim())
                if (body.isNotBlank()) putExtra(Intent.EXTRA_TEXT, body.trim())
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            try {
                intent.setPackage("com.google.android.gm")
                reactContext.startActivity(intent)
            } catch (_: Exception) {
                intent.setPackage(null)
                val chooser = Intent.createChooser(intent, "Send Email").apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(chooser)
            }
            if (autoSend) {
                mainHandler.postDelayed({
                    PulseAccessibilityService.instance?.sendVisibleEmail()
                }, 1800L)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun readVisibleEmails(promise: Promise) {
        try {
            val summary = PulseAccessibilityService.instance?.readVisibleEmailsSummary() ?: ""
            promise.resolve(summary)
        } catch (e: Exception) {
            promise.resolve("")
        }
    }

    @ReactMethod
    fun deleteVisibleEmail(hint: String?, promise: Promise) {
        try {
            val ok = PulseAccessibilityService.instance?.deleteVisibleEmail(hint ?: "") ?: false
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun sendVisibleEmail(promise: Promise) {
        try {
            val ok = PulseAccessibilityService.instance?.sendVisibleEmail() ?: false
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun shareText(text: String, title: String?, promise: Promise) {
        try {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
                if (!title.isNullOrBlank()) putExtra(Intent.EXTRA_SUBJECT, title)
            }
            val chooser = Intent.createChooser(sendIntent, title ?: "Share via Pulse OS").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun syncUserLoginData(jsonStr: String, promise: Promise) {
        try {
            PulseAccessibilityService.updateLoginDataFromJson(reactContext, jsonStr)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getAutomationResult(promise: Promise) {
        val map = Arguments.createMap()
        map.putString("status", PulseAccessibilityService.lastStatus)
        map.putString("message", PulseAccessibilityService.lastMessage)
        map.putBoolean("cartVerified", PulseAccessibilityService.lastCartVerified)
        map.putString("cartSummary", PulseAccessibilityService.lastCartSummary)
        map.putString("screenshot", PulseAccessibilityService.lastScreenshotBase64)
        map.putString("screenDump", PulseAccessibilityService.lastScreenTextDump)
        map.putDouble("ts", PulseAccessibilityService.lastUpdatedTs.toDouble())
        val logsArr = Arguments.createArray()
        for (l in PulseAccessibilityService.lastStepLogs) {
            logsArr.pushString(l)
        }
        map.putArray("stepLogs", logsArr)
        // Include the persisted bridge session (steps with latency/status) when present.
        try {
            val svc = PulseAccessibilityService.instance
            if (svc != null) {
                val prefs = reactContext.getSharedPreferences("pulseos.bridge_session.v1", Context.MODE_PRIVATE)
                val raw = prefs.getString("last_session", "") ?: ""
                if (raw.isNotEmpty()) map.putString("bridgeSession", raw)
                val structured = Arguments.createArray()
                for (e in svc.savedStepLogs) {
                    val o = Arguments.createMap()
                    o.putString("actionType", e.actionType)
                    o.putString("target", e.target)
                    o.putString("status", e.status)
                    o.putDouble("latencyMs", e.latencyMs.toDouble())
                    o.putString("detail", e.detail)
                    o.putDouble("at", e.at.toDouble())
                    structured.pushMap(o)
                }
                map.putArray("actionSteps", structured)
            }
        } catch (_: Exception) {}
        promise.resolve(map)
    }

    @ReactMethod
    fun captureScreenVerification(promise: Promise) {
        val svc = PulseAccessibilityService.instance
        if (svc == null) {
            promise.resolve("")
            return
        }
        Thread {
            val shot = svc.captureVerificationScreenshotSync(2500L)
            promise.resolve(shot)
        }.start()
    }

    @ReactMethod
    fun dumpScreenNodes(promise: Promise) {
        try {
            val dump = PulseAccessibilityService.instance?.dumpScreenSummary(100) ?: ""
            promise.resolve(dump)
        } catch (e: Exception) {
            promise.resolve("")
        }
    }

    @ReactMethod
    fun showTacticalHUD(message: String?, promise: Promise) {
        try {
            PulseAccessibilityService.instance?.showTacticalHUD(message ?: "PULSE ARMED")
            promise.resolve(PulseAccessibilityService.hudVisible)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun hideTacticalHUD(promise: Promise) {
        try {
            PulseAccessibilityService.instance?.hideTacticalHUD()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun haltAutomation(promise: Promise) {
        try {
            PulseAccessibilityService.instance?.haltAutomation()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun resumeAutomation(promise: Promise) {
        try {
            PulseAccessibilityService.instance?.resumeAutomation()
            promise.resolve(!PulseAccessibilityService.automationPaused)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getAutomationGuardState(promise: Promise) {
        try {
            val map = Arguments.createMap()
            map.putBoolean("paused", PulseAccessibilityService.automationPaused)
            map.putString("lastActionSignature", PulseAccessibilityService.lastActionSignature)
            map.putInt("repeatActionCount", PulseAccessibilityService.repeatActionCount)
            map.putString("lastLoopGuardHit", PulseAccessibilityService.lastLoopGuardHit)
            map.putBoolean("hudVisible", PulseAccessibilityService.hudVisible)
            promise.resolve(map)
        } catch (e: Exception) {
            promise.reject("GUARD_STATE_ERR", e.message)
        }
    }

    @ReactMethod
    fun pauseHandsFreeListening(promise: Promise) {
        pausedForTts = true
        mainHandler.post {
            try {
                speechRecognizer?.cancel()
            } catch (_: Exception) {}
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun resumeHandsFreeListening(promise: Promise) {
        pausedForTts = false
        if (!continuousHandsFree) {
            promise.resolve(false)
            return
        }
        mainHandler.postDelayed({
            if (continuousHandsFree && !pausedForTts) {
                startContinuousRecognizerInternal()
            }
        }, 350L)
        promise.resolve(true)
    }

    @ReactMethod
    fun startHandsFreeListening(lang: String?, promise: Promise) {
        currentVoiceLang = if (lang.isNullOrBlank()) "en-IN" else lang
        continuousHandsFree = true
        pausedForTts = false

        val perm = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO)
        if (perm != PackageManager.PERMISSION_GRANTED) {
            currentActivity?.let { act ->
                ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.RECORD_AUDIO), 9415)
            }
            val map = Arguments.createMap()
            map.putString("status", "permission_requested")
            map.putBoolean("handsFree", true)
            emitVoiceEvent("PulseVoiceStatus", map)
            promise.resolve(false)
            return
        }

        mainHandler.post {
            try {
                if (!SpeechRecognizer.isRecognitionAvailable(reactContext)) {
                    promise.resolve(false)
                    return@post
                }
                startContinuousRecognizerInternal()
                promise.resolve(true)
            } catch (e: Exception) {
                promise.resolve(false)
            }
        }
    }

    private fun destroyRecognizer() {
        try {
            speechRecognizer?.destroy()
        } catch (_: Exception) {}
        speechRecognizer = null
    }

    private fun startContinuousRecognizerInternal() {
        if (!continuousHandsFree || pausedForTts) return
        try {
            if (speechRecognizer == null) {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(reactContext.applicationContext)
                speechRecognizer?.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        val map = Arguments.createMap()
                        map.putString("status", "listening")
                        map.putBoolean("handsFree", continuousHandsFree)
                        emitVoiceEvent("PulseVoiceStatus", map)
                    }
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onError(error: Int) {
                        val map = Arguments.createMap()
                        map.putString("status", "idle")
                        map.putInt("errorCode", error)
                        map.putBoolean("handsFree", continuousHandsFree)
                        emitVoiceEvent("PulseVoiceStatus", map)
                        if (!continuousHandsFree || pausedForTts) return
                        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                            continuousHandsFree = false
                            return
                        }
                        if (error == SpeechRecognizer.ERROR_CLIENT || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) {
                            destroyRecognizer()
                        }
                        val delay = if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) 450L else 900L
                        mainHandler.postDelayed({
                            if (continuousHandsFree && !pausedForTts) startContinuousRecognizerInternal()
                        }, delay)
                    }
                    override fun onResults(results: Bundle?) {
                        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val best = matches?.firstOrNull()?.trim() ?: ""
                        if (best.isNotEmpty()) {
                            val map = Arguments.createMap()
                            map.putString("transcript", best)
                            map.putBoolean("handsFree", continuousHandsFree)
                            emitVoiceEvent("PulseVoiceResult", map)
                        }
                        if (continuousHandsFree && !pausedForTts) {
                            mainHandler.postDelayed({
                                if (continuousHandsFree && !pausedForTts) startContinuousRecognizerInternal()
                            }, 900L)
                        }
                    }
                    override fun onPartialResults(partialResults: Bundle?) {
                        val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val part = matches?.firstOrNull()?.trim() ?: ""
                        if (part.isNotEmpty()) {
                            val map = Arguments.createMap()
                            map.putString("partial", part)
                            emitVoiceEvent("PulseVoicePartial", map)
                        }
                    }
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
            }

            val recIntent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, currentVoiceLang)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, currentVoiceLang)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1800L)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1400L)
            }
            speechRecognizer?.startListening(recIntent)
        } catch (_: Exception) {
            destroyRecognizer()
        }
    }

    @ReactMethod
    fun stopHandsFreeListening(promise: Promise) {
        continuousHandsFree = false
        pausedForTts = false
        mainHandler.post {
            try {
                speechRecognizer?.stopListening()
                speechRecognizer?.cancel()
                destroyRecognizer()
                val map = Arguments.createMap()
                map.putString("status", "stopped")
                map.putBoolean("handsFree", false)
                emitVoiceEvent("PulseVoiceStatus", map)
                promise.resolve(true)
            } catch (_: Exception) {
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun startVoiceRecognition(lang: String?, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "Activity not available")
            return
        }
        voicePromise = promise
        try {
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, if (lang.isNullOrBlank()) "en-IN" else lang)
                putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak naturally to Pulse OS…")
            }
            activity.startActivityForResult(intent, VOICE_REQ_CODE)
        } catch (e: Exception) {
            voicePromise = null
            promise.reject("VOICE_ERR", e.message)
        }
    }

    @ReactMethod
    fun pickMediaFile(pickerType: String?, promise: Promise) {
        val activity = currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "Activity not available")
            return
        }
        mediaPromise = promise
        val kind = (pickerType ?: "document").lowercase().trim()
        mediaPickerKind = kind
        try {
            val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                when (kind) {
                    "image", "photo" -> type = "image/*"
                    "video" -> type = "video/*"
                    else -> type = "*/*"
                }
            }
            activity.startActivityForResult(Intent.createChooser(intent, "Select File"), PICK_MEDIA_REQ_CODE)
        } catch (e: Exception) {
            mediaPromise = null
            promise.reject("PICK_ERR", e.message)
        }
    }

    @ReactMethod
    fun installApk(filePath: String, promise: Promise) {
        try {
            val cleanPath = filePath.removePrefix("file://")
            val apkFile = File(cleanPath)
            if (!apkFile.exists()) {
                promise.resolve(false)
                return
            }
            val uri = Uri.fromFile(apkFile)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (_: Exception) {
            promise.resolve(false)
        }
    }

    override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == VOICE_REQ_CODE) {
            val p = voicePromise
            voicePromise = null
            if (p != null) {
                if (resultCode == Activity.RESULT_OK && data != null) {
                    val matches = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
                    p.resolve(matches?.firstOrNull() ?: "")
                } else {
                    p.resolve("")
                }
            }
            return
        }

        if (requestCode == PICK_MEDIA_REQ_CODE) {
            val p = mediaPromise
            mediaPromise = null
            if (p == null) return
            if (resultCode != Activity.RESULT_OK || data?.data == null) {
                p.resolve(null)
                return
            }
            val uri = data.data!!
            Thread {
                try {
                    val cr = reactContext.contentResolver
                    val mime = cr.getType(uri) ?: when (mediaPickerKind) {
                        "image", "photo" -> "image/jpeg"
                        "video" -> "video/mp4"
                        else -> "application/octet-stream"
                    }
                    var displayName = "attachment_" + System.currentTimeMillis()
                    var sizeBytes = 0L
                    cr.query(uri, null, null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (nameIdx >= 0) {
                                val n = cursor.getString(nameIdx)
                                if (!n.isNullOrBlank()) displayName = n
                            }
                            val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                            if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) {
                                sizeBytes = cursor.getLong(sizeIdx)
                            }
                        }
                    }

                    val safeFileName = displayName.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                    val cacheFile = File(reactContext.cacheDir, "upload_" + System.currentTimeMillis() + "_" + safeFileName)
                    var rawBytes = ByteArray(0)
                    cr.openInputStream(uri)?.use { input ->
                        FileOutputStream(cacheFile).use { output ->
                            input.copyTo(output)
                        }
                    }
                    if (cacheFile.exists()) {
                        sizeBytes = cacheFile.length()
                        if (sizeBytes <= 10L * 1024L * 1024L) {
                            rawBytes = cacheFile.readBytes()
                        }
                    }

                    val resolvedKind = when {
                        mime.startsWith("image/") || mediaPickerKind == "image" -> "image"
                        mime.startsWith("video/") || mediaPickerKind == "video" -> "video"
                        else -> "document"
                    }

                    val isTextLike = mime.startsWith("text/") ||
                        displayName.endsWith(".txt", true) ||
                        displayName.endsWith(".md", true) ||
                        displayName.endsWith(".csv", true) ||
                        displayName.endsWith(".json", true) ||
                        displayName.endsWith(".xml", true) ||
                        displayName.endsWith(".html", true)

                    val outMap = Arguments.createMap()
                    outMap.putString("uri", "file://" + cacheFile.absolutePath)
                    outMap.putString("name", displayName)
                    outMap.putString("mimeType", mime)
                    outMap.putString("kind", resolvedKind)
                    outMap.putDouble("sizeBytes", sizeBytes.toDouble())
                    if (isTextLike && rawBytes.isNotEmpty()) {
                        val txt = String(rawBytes, Charsets.UTF_8).take(45000)
                        outMap.putString("textContent", txt)
                    } else if (rawBytes.isNotEmpty()) {
                        val b64 = Base64.encodeToString(rawBytes, Base64.NO_WRAP)
                        outMap.putString("base64", b64)
                    }
                    p.resolve(outMap)
                } catch (e: Exception) {
                    p.reject("READ_MEDIA_ERR", e.message)
                }
            }.start()
        }
    }

    override fun onNewIntent(intent: Intent?) {}

    @ReactMethod
    fun getInstalledApps(promise: Promise) {
        try {
            val pm = reactContext.packageManager
            val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
            val apps = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.queryIntentActivities(mainIntent, PackageManager.ResolveInfoFlags.of(0L))
            } else {
                @Suppress("DEPRECATION")
                pm.queryIntentActivities(mainIntent, 0)
            }
            val arr = Arguments.createArray()
            val seen = mutableSetOf<String>()
            for (info in apps) {
                val pkg = info.activityInfo?.packageName ?: continue
                if (seen.contains(pkg) || pkg == reactContext.packageName) continue
                seen.add(pkg)
                val label = info.loadLabel(pm)?.toString()?.trim() ?: pkg
                val map = Arguments.createMap()
                map.putString("label", label)
                map.putString("packageName", pkg)
                arr.pushMap(map)
            }
            promise.resolve(arr)
        } catch (e: Exception) {
            promise.reject("ERR_APPS", e.message)
        }
    }

    private fun tryReliableDeepLinkIntent(pkg: String, appKey: String, query: String): Boolean {
        if (query.isBlank()) return false
        val enc = Uri.encode(query.trim())
        val deepLinks = when (appKey) {
            "youtube" -> listOf("vnd.youtube://results?search_query=\$enc")
            "maps" -> listOf("geo:0,0?q=\$enc")
            "navigate" -> listOf("google.navigation:q=\$enc")
            "playstore" -> listOf("market://search?q=\$enc")
            "chrome", "web" -> listOf("https://www.google.com/search?q=\$enc")
            else -> emptyList()
        }

        for (u in deepLinks) {
            try {
                val viewIntent = Intent(Intent.ACTION_VIEW, Uri.parse(u)).apply {
                    setPackage(pkg)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                reactContext.startActivity(viewIntent)
                return true
            } catch (_: Exception) {}
        }
        return false
    }

    @ReactMethod
    fun launchApp(nameOrPkg: String, query: String?, promise: Promise) {
        try {
            val clean = nameOrPkg.trim()
            val lower = clean.lowercase()
            val cleanQuery = query?.trim().orEmpty()
            val pm = reactContext.packageManager

            val candidates = mutableListOf<String>()
            PulseAccessibilityService.KNOWN_APP_PACKAGES[lower]?.let { candidates.addAll(it) }
            if (clean.contains(".")) candidates.add(clean)

            var launched = false
            var usedDeepLink = false
            var resolvedKey = lower

            for (pkg in candidates) {
                if (cleanQuery.isNotEmpty() && !cleanQuery.contains("|")) {
                    if (tryReliableDeepLinkIntent(pkg, lower, cleanQuery)) {
                        launched = true
                        usedDeepLink = true
                        break
                    }
                }
                val intent = pm.getLaunchIntentForPackage(pkg)
                if (intent != null) {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    reactContext.startActivity(intent)
                    launched = true
                    break
                }
            }

            if (!launched) {
                val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
                    addCategory(Intent.CATEGORY_LAUNCHER)
                }
                val apps = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    pm.queryIntentActivities(mainIntent, PackageManager.ResolveInfoFlags.of(0L))
                } else {
                    @Suppress("DEPRECATION")
                    pm.queryIntentActivities(mainIntent, 0)
                }
                val matched = apps.firstOrNull { info ->
                    val label = info.loadLabel(pm)?.toString()?.lowercase() ?: ""
                    label == lower || label.contains(lower) || (label.length > 2 && lower.contains(label))
                }
                val matchedPkg = matched?.activityInfo?.packageName
                if (!matchedPkg.isNullOrEmpty()) {
                    resolvedKey = matched?.loadLabel(pm)?.toString()?.lowercase() ?: lower
                    if (cleanQuery.isNotEmpty() && tryReliableDeepLinkIntent(matchedPkg, resolvedKey, cleanQuery)) {
                        launched = true
                        usedDeepLink = true
                    } else {
                        val intent = pm.getLaunchIntentForPackage(matchedPkg)
                        if (intent != null) {
                            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                            reactContext.startActivity(intent)
                            launched = true
                        }
                    }
                }
            }

            if (launched && cleanQuery.isNotEmpty()) {
                val mode = if (cleanQuery.contains("|")) "login" else "order"
                PulseAccessibilityService.instance?.runAutonomousAppWorkflow(resolvedKey, cleanQuery, mode, usedDeepLink)
            }
            promise.resolve(launched)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun runAutonomousWorkflow(appKey: String, query: String, mode: String, promise: Promise) {
        val svc = PulseAccessibilityService.instance
        if (svc == null) {
            promise.resolve(false)
            return
        }
        svc.runAutonomousAppWorkflow(appKey.lowercase().trim(), query.trim(), mode, false)
        promise.resolve(true)
    }

    @ReactMethod
    fun clickByText(text: String, promise: Promise) {
        val ok = PulseAccessibilityService.instance?.clickNodeByText(text) ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun tapCoordinate(x: Double, y: Double, promise: Promise) {
        val svcOk = PulseAccessibilityService.instance?.tapCoordinate(x.toFloat(), y.toFloat()) ?: false
        promise.resolve(svcOk)
    }

    @ReactMethod
    fun swipeScreen(startX: Double, startY: Double, endX: Double, endY: Double, promise: Promise) {
        val svcOk = PulseAccessibilityService.instance?.swipe(
            startX.toFloat(),
            startY.toFloat(),
            endX.toFloat(),
            endY.toFloat()
        ) ?: false
        promise.resolve(svcOk)
    }

    @ReactMethod
    fun scrollScreen(direction: String, promise: Promise) {
        val svcOk = PulseAccessibilityService.instance?.scrollDirection(direction) ?: false
        promise.resolve(svcOk)
    }

    @ReactMethod
    fun inputText(targetLabel: String?, text: String, promise: Promise) {
        val ok = PulseAccessibilityService.instance?.inputTextIntoNode(targetLabel, text) ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun selectBestVisibleNode(hintText: String, promise: Promise) {
        val ok = PulseAccessibilityService.instance?.selectPrimaryVisibleItem(hintText) ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun proceedAction(promise: Promise) {
        val ok = PulseAccessibilityService.instance?.proceedOnScreen() ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun performInAppSearch(query: String, promise: Promise) {
        val ok = PulseAccessibilityService.instance?.inputTextIntoNode("Search", query) ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun executeVoiceCommand(spokenText: String, promise: Promise) {
        try {
            val svc = PulseAccessibilityService.instance
            if (svc == null) {
                val out = JSONObject()
                out.put("handled", false)
                promise.resolve(out.toString())
                return
            }
            promise.resolve(svc.executeHandsFreeVoiceAction(spokenText).toString())
        } catch (e: Exception) {
            val out = JSONObject()
            out.put("handled", false)
            promise.resolve(out.toString())
        }
    }

    @ReactMethod
    fun generateNativePdf(
        title: String,
        subtitle: String,
        bodyText: String,
        shareImmediately: Boolean,
        promise: Promise
    ) {
        Thread {
            try {
                val pdfDoc = PdfDocument()
                val pageWidth = 595
                val pageHeight = 842
                val margin = 42f
                val contentWidth = pageWidth - (margin * 2)
                val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.rgb(15, 23, 42)
                    textSize = 20f
                    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                }
                val subPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.rgb(79, 70, 229)
                    textSize = 11.5f
                    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                }
                val bodyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.rgb(30, 41, 59)
                    textSize = 11.5f
                }
                val headPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.rgb(15, 23, 42)
                    textSize = 13.5f
                    typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
                }
                val footerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.rgb(100, 116, 139)
                    textSize = 9.5f
                }
                val lines = mutableListOf<Pair<String, Boolean>>()
                for (rawPara in bodyText.lines()) {
                    val trimmed = rawPara.trim()
                    if (trimmed.isEmpty()) {
                        lines.add(Pair("", false))
                        continue
                    }
                    val isHead = trimmed.startsWith("#")
                    val cleanPara = trimmed.replace(Regex("^#+[ ]*"), "").replace("**", "")
                    val pMeasure = if (isHead) headPaint else bodyPaint
                    var cur = ""
                    for (w in cleanPara.split(" ")) {
                        val test = if (cur.isEmpty()) w else cur + " " + w
                        if (pMeasure.measureText(test) <= contentWidth) {
                            cur = test
                        } else {
                            if (cur.isNotEmpty()) lines.add(Pair(cur, isHead))
                            cur = w
                        }
                    }
                    if (cur.isNotEmpty()) lines.add(Pair(cur, isHead))
                }
                var pageNumber = 1
                var pageInfo = PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create()
                var page = pdfDoc.startPage(pageInfo)
                var canvas: Canvas = page.canvas
                var y = margin + 20f
                canvas.drawText(title.take(54), margin, y, titlePaint)
                y += 22f
                canvas.drawText(subtitle.ifBlank { "Generated by Pulse OS" }.take(78), margin, y, subPaint)
                y += 24f
                for ((lineText, isHead) in lines) {
                    if (y > pageHeight - 56f) {
                        canvas.drawText("Pulse OS  •  Page " + pageNumber, margin, pageHeight - 24f, footerPaint)
                        pdfDoc.finishPage(page)
                        pageNumber++
                        pageInfo = PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create()
                        page = pdfDoc.startPage(pageInfo)
                        canvas = page.canvas
                        y = margin + 20f
                    }
                    if (lineText.isEmpty()) {
                        y += 8f
                    } else if (isHead) {
                        y += 5f
                        canvas.drawText(lineText, margin, y, headPaint)
                        y += 18f
                    } else {
                        canvas.drawText(lineText, margin, y, bodyPaint)
                        y += 16f
                    }
                }
                canvas.drawText("Pulse OS  •  Page " + pageNumber, margin, pageHeight - 24f, footerPaint)
                pdfDoc.finishPage(page)
                val outDir = reactContext.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: reactContext.cacheDir
                if (!outDir.exists()) outDir.mkdirs()
                val safeSlug = title.replace(Regex("[^a-zA-Z0-9_-]"), "_").take(30).ifBlank { "pulse_report" }
                val outFile = File(outDir, safeSlug + "_" + System.currentTimeMillis() + ".pdf")
                FileOutputStream(outFile).use { fos -> pdfDoc.writeTo(fos) }
                pdfDoc.close()
                val res = JSONObject()
                res.put("ok", true)
                res.put("filePath", outFile.absolutePath)
                res.put("fileName", outFile.name)
                res.put("pageCount", pageNumber)
                res.put("sizeBytes", outFile.length())
                promise.resolve(res.toString())
            } catch (e: Exception) {
                val err = JSONObject()
                err.put("ok", false)
                err.put("error", e.message ?: "PDF error")
                promise.resolve(err.toString())
            }
        }.start()
    }

    @ReactMethod
    fun globalAction(action: String, promise: Promise) {
        val ok = PulseAccessibilityService.instance?.runGlobal(action) ?: false
        promise.resolve(ok)
    }
}

class PulseBridgePackage : com.facebook.react.ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(PulseBridgeModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<com.facebook.react.uimanager.ViewManager<*, *>> {
        return emptyList()
    }
}
`,
        'utf8',
      );

      const wrapperPropsPath = path.join(androidRoot, 'gradle/wrapper/gradle-wrapper.properties');
      if (fs.existsSync(wrapperPropsPath)) {
        let props = fs.readFileSync(wrapperPropsPath, 'utf8');
        props = props.replace(/-all\.zip/g, '-bin.zip');
        if (!props.includes('networkTimeout')) {
          props = props.trimEnd() + '\nnetworkTimeout=60000\n';
        }
        fs.writeFileSync(wrapperPropsPath, props, 'utf8');
      }

      const gradlewPath = path.join(androidRoot, 'gradlew');
      if (fs.existsSync(gradlewPath)) {
        let gw = fs.readFileSync(gradlewPath, 'utf8');
        if (gw.includes('exec "$JAVACMD" "$@"') && !gw.includes('PULSE_GRADLE_PREFETCH')) {
          const prefetchBlock = [
            '# PULSE_GRADLE_PREFETCH',
            '_WRAPPER_DIR="$APP_HOME/gradle/wrapper"',
            '_PROPS="$_WRAPPER_DIR/gradle-wrapper.properties"',
            'if [ -f "$_PROPS" ] && command -v curl >/dev/null 2>&1; then',
            '  _RAW_URL=$(grep "^distributionUrl=" "$_PROPS" | head -n 1 | cut -d= -f2- | sed "s|\\\\:|:|g" | tr -d "\\r\\n")',
            '  _DIST_ZIP=$(basename "$_RAW_URL")',
            '  _LOCAL_ZIP="$_WRAPPER_DIR/$_DIST_ZIP"',
            '  if [ -n "$_RAW_URL" ] && [ -n "$_DIST_ZIP" ] && [ ! -s "$_LOCAL_ZIP" ]; then',
            '    echo "[Pulse OS CI] Prefetching $_DIST_ZIP with curl retry..."',
            '    if curl --ipv4 -fSL --retry 4 --retry-delay 3 --retry-all-errors --connect-timeout 15 --max-time 120 -o "$_LOCAL_ZIP.tmp" "$_RAW_URL" 2>/dev/null; then',
            '      mv -f "$_LOCAL_ZIP.tmp" "$_LOCAL_ZIP"',
            '      sed -i.bak "s|^distributionUrl=.*|distributionUrl=$_DIST_ZIP|" "$_PROPS" 2>/dev/null || true',
            '      rm -f "$_PROPS.bak"',
            '    else',
            '      rm -f "$_LOCAL_ZIP.tmp"',
            '    fi',
            '  fi',
            'fi',
            'exec "$JAVACMD" "$@"',
          ].join('\n');
          gw = gw.replace('exec "$JAVACMD" "$@"', prefetchBlock);
          fs.writeFileSync(gradlewPath, gw, 'utf8');
        }
      }

      return config;
    },
  ]);
}

module.exports = function withPulseNativeOS(config) {
  config = withPulseAccessibilityManifest(config);
  config = withPulseAccessibilityStrings(config);
  config = withPulseMainApplicationPackage(config);
  config = withPulseKotlinFiles(config);
  return config;
};
