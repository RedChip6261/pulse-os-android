const { withAndroidManifest, withStringsXml, withMainApplication, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = '.HarkAccessibilityService';
const SERVICE_LABEL = 'Pulse OS Assistive Bridge';
const SERVICE_DESC_KEY = 'hark_accessibility_service_description';
const SERVICE_DESC_VALUE =
  'Pulse OS Assistive Screen Reader, Voice Navigation, and Real-Time Cross-App UI Automation (Blinkit, Uber, Meesho, WhatsApp, Instagram, Telegram, Free Fire, and all installed apps).';

function withHarkAccessibilityManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    if (!manifest['uses-permission']) manifest['uses-permission'] = [];
    const ensurePerm = (name) => {
      if (!manifest['uses-permission'].some((p) => p?.$?.['android:name'] === name)) {
        manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    };
    ensurePerm('android.permission.RECORD_AUDIO');
    ensurePerm('android.permission.QUERY_ALL_PACKAGES');

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
      'com.snapchat.android',
      'com.twitter.android',
      'com.facebook.katana',
    ];

    for (const pkg of requiredPackages) {
      if (!queriesBlock.package.some((p) => p?.$?.['android:name'] === pkg)) {
        queriesBlock.package.push({ $: { 'android:name': pkg } });
      }
    }

    if (
      !queriesBlock.intent.some(
        (it) => it?.action?.[0]?.$?.['android:name'] === 'android.intent.action.MAIN',
      )
    ) {
      queriesBlock.intent.push({
        action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
        category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
      });
    }
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
              'android:resource': '@xml/hark_accessibility_config',
            },
          },
        ],
      });
    }

    return config;
  });
}

function withHarkAccessibilityStrings(config) {
  return withStringsXml(config, (config) => {
    const strings = config.modResults.resources.string || [];
    if (!strings.some((s) => s?.$?.name === SERVICE_DESC_KEY)) {
      strings.push({ $: { name: SERVICE_DESC_KEY }, _: SERVICE_DESC_VALUE });
    }
    config.modResults.resources.string = strings;
    return config;
  });
}

function withHarkMainApplicationPackage(config) {
  return withMainApplication(config, (config) => {
    let src = config.modResults.contents;
    if (!src.includes('HarkBridgePackage')) {
      src = src.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        'PackageList(this).packages.apply {\n              add(HarkBridgePackage())',
      );
      config.modResults.contents = src;
    }
    return config;
  });
}

function withHarkKotlinFiles(config) {
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
        path.join(xmlDir, 'hark_accessibility_config.xml'),
        `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:description="@string/${SERVICE_DESC_KEY}"
    android:accessibilityEventTypes="typeAllMask"
    android:accessibilityFeedbackType="feedbackGeneric|feedbackSpoken"
    android:accessibilityFlags="flagDefault|flagReportViewIds|flagRetrieveInteractiveWindows|flagIncludeNotImportantViews|flagRequestEnhancedWebAccessibility"
    android:canPerformGestures="true"
    android:canRetrieveWindowContent="true"
    android:notificationTimeout="50" />
`,
        'utf8',
      );

      const kotlinDir = path.join(androidRoot, 'app/src/main/java', packagePath);
      fs.mkdirSync(kotlinDir, { recursive: true });

      // 1. Write HarkAccessibilityService.kt with full Window Traversal, Coordinate Taps, Swipes, Text Input & Global Actions
      fs.writeFileSync(
        path.join(kotlinDir, 'HarkAccessibilityService.kt'),
        `package ${packageName}

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import java.util.ArrayDeque

class HarkAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile
        var instance: HarkAccessibilityService? = null
            private set

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
            "maps" to listOf("com.google.android.apps.maps")
        )
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun getActiveRoot(): AccessibilityNodeInfo? {
        rootInActiveWindow?.let { return it }
        try {
            for (w in windows) {
                if (w.isActive || w.type == AccessibilityWindowInfo.TYPE_APPLICATION) {
                    w.root?.let { return it }
                }
            }
        } catch (_: Exception) {}
        return null
    }

    fun dumpScreenSummary(maxNodes: Int = 90): String {
        val root = getActiveRoot() ?: return ""
        val pkg = root.packageName?.toString() ?: "unknown"
        val sb = StringBuilder("ActiveAppPackage: \$pkg\\nElements:\\n")
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var count = 0
        while (queue.isNotEmpty() && count < maxNodes) {
            val node = queue.removeFirst()
            if (node.isVisibleToUser) {
                val t = node.text?.toString()?.trim()?.replace("\\n", " ").orEmpty()
                val d = node.contentDescription?.toString()?.trim()?.replace("\\n", " ").orEmpty()
                val id = node.viewIdResourceName?.substringAfterLast("/").orEmpty()
                val rect = Rect()
                node.getBoundsInScreen(rect)
                if ((t.isNotEmpty() || d.isNotEmpty() || node.isClickable || node.isEditable) && rect.width() > 0 && rect.height() > 0) {
                    val tag = when {
                        node.isEditable -> "INPUT"
                        node.isClickable -> "BTN"
                        else -> "TXT"
                    }
                    val label = listOf(t, d, id).filter { it.isNotEmpty() }.joinToString(" | ").take(75)
                    if (label.isNotEmpty() || node.isEditable) {
                        sb.append("[\$count] \$tag (\$label) @(\${rect.centerX()},\${rect.centerY()})\\n")
                        count++
                    }
                }
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }
        return sb.toString()
    }

    fun tapCoordinate(x: Float, y: Float, durationMs: Long = 90L): Boolean {
        if (x < 0f || y < 0f) return false
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(40L, 600L)))
            .build()
        return dispatchGesture(gesture, null, mainHandler)
    }

    fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long = 320L): Boolean {
        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(100L, 1000L)))
            .build()
        return dispatchGesture(gesture, null, mainHandler)
    }

    fun clickNodeByText(targetText: String): Boolean {
        val query = targetText.trim()
        if (query.isEmpty()) return false
        val root = getActiveRoot() ?: return false

        val fast = root.findAccessibilityNodeInfosByText(query) ?: emptyList()
        for (node in fast) {
            if (!node.isVisibleToUser) continue
            if (performClickOrTap(node)) return true
        }

        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.isVisibleToUser) {
                val t = node.text?.toString()?.trim().orEmpty()
                val d = node.contentDescription?.toString()?.trim().orEmpty()
                val id = node.viewIdResourceName?.substringAfterLast("/").orEmpty()
                if (t.contains(query, ignoreCase = true) || d.contains(query, ignoreCase = true) || id.contains(query, ignoreCase = true)) {
                    if (performClickOrTap(node)) return true
                }
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }
        return false
    }

    private fun performClickOrTap(node: AccessibilityNodeInfo): Boolean {
        var cur: AccessibilityNodeInfo? = node
        var depth = 0
        while (cur != null && depth < 6) {
            if (cur.isClickable && cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            cur = cur.parent
            depth++
        }
        val rect = Rect()
        node.getBoundsInScreen(rect)
        if (!rect.isEmpty && rect.centerX() > 0 && rect.centerY() > 0) {
            return tapCoordinate(rect.centerX().toFloat(), rect.centerY().toFloat())
        }
        return false
    }

    fun inputTextIntoNode(targetLabel: String?, textToEnter: String): Boolean {
        val root = getActiveRoot() ?: return false
        var targetNode: AccessibilityNodeInfo? = null
        if (!targetLabel.isNullOrBlank()) {
            val q = targetLabel.trim()
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            while (queue.isNotEmpty()) {
                val n = queue.removeFirst()
                if (n.isVisibleToUser && n.isEditable) {
                    val t = n.text?.toString().orEmpty()
                    val d = n.contentDescription?.toString().orEmpty()
                    val h = if (Build.VERSION.SDK_INT >= 26) n.hintText?.toString().orEmpty() else ""
                    if (t.contains(q, true) || d.contains(q, true) || h.contains(q, true)) {
                        targetNode = n
                        break
                    }
                }
                for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
            }
        }
        if (targetNode == null) {
            targetNode = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        }
        if (targetNode == null) {
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            while (queue.isNotEmpty()) {
                val n = queue.removeFirst()
                if (n.isVisibleToUser && n.isEditable) {
                    targetNode = n
                    break
                }
                for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
            }
        }
        val node = targetNode ?: return false
        val rect = Rect()
        node.getBoundsInScreen(rect)
        if (!rect.isEmpty) {
            node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, textToEnter)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    fun runGlobal(action: String): Boolean {
        return when (action.lowercase().trim()) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            else -> false
        }
    }
}
`,
        'utf8',
      );

      // 2. Write HarkBridgeModule.kt & HarkBridgePackage.kt with Accessibility Status Check, Screen Dump, Swipe, Tap, Text Input & App Launching
      fs.writeFileSync(
        path.join(kotlinDir, 'HarkBridgeModule.kt'),
        `package ${packageName}

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.speech.RecognizerIntent
import com.facebook.react.bridge.*
import java.io.BufferedReader
import java.io.InputStreamReader

class HarkBridgeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    private var voicePromise: Promise? = null
    private val VOICE_REQ_CODE = 9412

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName(): String = "HarkBridge"

    @ReactMethod
    fun isAccessibilityEnabled(promise: Promise) {
        try {
            if (HarkAccessibilityService.instance != null) {
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
            promise.resolve(HarkAccessibilityService.instance != null)
        }
    }

    @ReactMethod
    fun dumpScreenNodes(promise: Promise) {
        try {
            val dump = HarkAccessibilityService.instance?.dumpScreenSummary(90) ?: ""
            promise.resolve(dump)
        } catch (e: Exception) {
            promise.resolve("")
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
                putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak to Pulse OS…")
            }
            activity.startActivityForResult(intent, VOICE_REQ_CODE)
        } catch (e: Exception) {
            voicePromise = null
            promise.reject("VOICE_ERR", e.message)
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

    @ReactMethod
    fun launchApp(nameOrPkg: String, query: String?, promise: Promise) {
        try {
            val clean = nameOrPkg.trim()
            val lower = clean.lowercase()
            val pm = reactContext.packageManager

            val candidates = mutableListOf<String>()
            HarkAccessibilityService.KNOWN_APP_PACKAGES[lower]?.let { candidates.addAll(it) }
            if (clean.contains(".")) candidates.add(clean)

            for (pkg in candidates) {
                val intent = pm.getLaunchIntentForPackage(pkg)
                if (intent != null) {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    reactContext.startActivity(intent)
                    promise.resolve(true)
                    return
                }
            }

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
                val intent = pm.getLaunchIntentForPackage(matchedPkg)
                if (intent != null) {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    reactContext.startActivity(intent)
                    promise.resolve(true)
                    return
                }
            }
            promise.resolve(false)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun clickByText(text: String, promise: Promise) {
        val ok = HarkAccessibilityService.instance?.clickNodeByText(text) ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun tapCoordinate(x: Double, y: Double, promise: Promise) {
        val svcOk = HarkAccessibilityService.instance?.tapCoordinate(x.toFloat(), y.toFloat()) ?: false
        if (svcOk) {
            promise.resolve(true)
            return
        }
        try {
            val proc = Runtime.getRuntime().exec(arrayOf("su", "-c", "input tap \${x.toInt()} \${y.toInt()}"))
            val code = proc.waitFor()
            promise.resolve(code == 0)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun swipeScreen(startX: Double, startY: Double, endX: Double, endY: Double, promise: Promise) {
        val svcOk = HarkAccessibilityService.instance?.swipe(
            startX.toFloat(),
            startY.toFloat(),
            endX.toFloat(),
            endY.toFloat()
        ) ?: false
        promise.resolve(svcOk)
    }

    @ReactMethod
    fun inputText(targetLabel: String?, text: String, promise: Promise) {
        val ok = HarkAccessibilityService.instance?.inputTextIntoNode(targetLabel, text) ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun globalAction(action: String, promise: Promise) {
        val ok = HarkAccessibilityService.instance?.runGlobal(action) ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun runRootCommand(cmd: String, promise: Promise) {
        try {
            val proc = Runtime.getRuntime().exec(arrayOf("su", "-c", cmd))
            val reader = BufferedReader(InputStreamReader(proc.inputStream))
            val out = reader.readText()
            proc.waitFor()
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("ROOT_ERR", e.message)
        }
    }
}

class HarkBridgePackage : com.facebook.react.ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(HarkBridgeModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<com.facebook.react.uimanager.ViewManager<*, *>> {
        return emptyList()
    }
}
`,
        'utf8',
      );

      return config;
    },
  ]);
}

module.exports = function withHarkNativeOS(config) {
  config = withHarkAccessibilityManifest(config);
  config = withHarkAccessibilityStrings(config);
  config = withHarkMainApplicationPackage(config);
  config = withHarkKotlinFiles(config);
  return config;
};
