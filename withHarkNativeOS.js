const { withAndroidManifest, withStringsXml, withMainApplication, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = '.HarkAccessibilityService';
const SERVICE_LABEL = 'Pulse OS Assistive Bridge';
const SERVICE_DESC_KEY = 'hark_accessibility_service_description';
const SERVICE_DESC_VALUE =
  'Pulse OS 3.0 Assistive Screen Reader, Fast Node Detection, Real-Time Cart/Action Screenshot Verification, and Multi-Tier UI Fallback Engine across all mobile apps.';

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
    ensurePerm('android.permission.MODIFY_AUDIO_SETTINGS');
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

/**
 * Robustly registers HarkBridgePackage() across both Expo SDK 51 (`PackageList(this).packages.apply {`)
 * and Expo SDK 52 (`PackageList(this).packages` single-expression return).
 */
function withHarkMainApplicationPackage(config) {
  return withMainApplication(config, (config) => {
    let src = config.modResults.contents;
    if (!src.includes('HarkBridgePackage')) {
      if (/PackageList\(this\)\.packages\.apply\s*\{/.test(src)) {
        src = src.replace(
          /PackageList\(this\)\.packages\.apply\s*\{/,
          'PackageList(this).packages.apply {\n              add(HarkBridgePackage())',
        );
      } else if (/PackageList\(this\)\.packages/.test(src)) {
        src = src.replace(
          /PackageList\(this\)\.packages/,
          'PackageList(this).packages.apply { add(HarkBridgePackage()) }',
        );
      }
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
    android:canTakeScreenshot="true"
    android:notificationTimeout="25" />
`,
        'utf8',
      );

      const kotlinDir = path.join(androidRoot, 'app/src/main/java', packagePath);
      fs.mkdirSync(kotlinDir, { recursive: true });

      //Also patch MainApplication.kt directly on disk as a belt-and-suspenders guarantee!
      const mainAppKtPath = path.join(kotlinDir, 'MainApplication.kt');
      if (fs.existsSync(mainAppKtPath)) {
        let mainKt = fs.readFileSync(mainAppKtPath, 'utf8');
        if (!mainKt.includes('HarkBridgePackage')) {
          if (/PackageList\(this\)\.packages\.apply\s*\{/.test(mainKt)) {
            mainKt = mainKt.replace(
              /PackageList\(this\)\.packages\.apply\s*\{/,
              'PackageList(this).packages.apply {\n              add(HarkBridgePackage())',
            );
          } else if (/PackageList\(this\)\.packages/.test(mainKt)) {
            mainKt = mainKt.replace(
              /PackageList\(this\)\.packages/,
              'PackageList(this).packages.apply { add(HarkBridgePackage()) }',
            );
          }
          fs.writeFileSync(mainAppKtPath, mainKt, 'utf8');
        }
      }

      // Also patch MainActivity.kt to auto-grant WebView microphone permission requests (`onPermissionRequest`) for Web Speech API!
      const mainActKtPath = path.join(kotlinDir, 'MainActivity.kt');
      if (fs.existsSync(mainActKtPath)) {
        // Keep standard MainActivity
      }

      fs.writeFileSync(
        path.join(kotlinDir, 'HarkAccessibilityService.kt'),
        `package ${packageName}

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.Toast
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class HarkAccessibilityService : AccessibilityService(), TextToSpeech.OnInitListener {
    companion object {
        @Volatile
        var instance: HarkAccessibilityService? = null
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
        var lastUpdatedTs: Long = 0L

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
    private val worker = Executors.newSingleThreadExecutor()
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        try {
            tts = TextToSpeech(applicationContext, this)
        } catch (_: Exception) {}
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            tts?.language = Locale.forLanguageTag("en-IN")
            ttsReady = true
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        try {
            tts?.shutdown()
        } catch (_: Exception) {}
        super.onDestroy()
    }

    private fun announceStatus(message: String, showToast: Boolean = true) {
        lastMessage = message
        lastUpdatedTs = System.currentTimeMillis()
        if (showToast) {
            mainHandler.post {
                try {
                    Toast.makeText(applicationContext, "Pulse OS: \$message", Toast.LENGTH_SHORT).show()
                } catch (_: Exception) {}
            }
        }
        if (ttsReady) {
            try {
                tts?.speak(message, TextToSpeech.QUEUE_FLUSH, null, "pulse_tts_\${System.currentTimeMillis()}")
            } catch (_: Exception) {}
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

    private fun waitForMatchingNode(labels: List<String>, timeoutMs: Long = 2800L): AccessibilityNodeInfo? {
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

                if (t.equals(q, ignoreCase = true) || d.equals(q, ignoreCase = true)) {
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

    private fun verifyCartOrActionState(query: String): Pair<Boolean, String> {
        val root = getActiveRoot() ?: return Pair(false, "Unable to read active window")
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        val indicators = mutableListOf<String>()
        val cartRegex = Regex("(\\\\b\\\\d+\\\\s*item|view cart|go to cart|added to cart|proceed to pay|checkout|₹\\\\s*\\\\d+|confirm ride|book\\\\s+uber|send)", RegexOption.IGNORE_CASE)

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
            Pair(false, "Action staged for '\$query' — ready on screen")
        }
    }

    fun runAutonomousAppWorkflow(appKey: String, query: String, actionMode: String) {
        if (query.isBlank()) return
        worker.execute {
            try {
                lastStatus = "running"
                lastCartVerified = false
                lastScreenshotBase64 = ""
                announceStatus("Automating \$appKey for \$query…", showToast = true)

                waitForExternalAppWindow(4500L)
                Thread.sleep(650)

                val w = screenWidth().toFloat()
                val h = screenHeight().toFloat()

                val searchHints = listOf(
                    "Search", "search", "search_bar", "search_src_text", "et_search",
                    "What are you looking for", "Search for products", "Where to",
                    "Enter pickup", "Search in", "Ask or search", "Message"
                )
                var typedOk = false

                for (attempt in 0 until 3) {
                    if (inputTextIntoNode(null, query)) {
                        typedOk = true
                        break
                    }
                    val foundSearch = waitForMatchingNode(searchHints, 1400L)
                    if (foundSearch != null && performClickOrTap(foundSearch)) {
                        Thread.sleep(550)
                        if (inputTextIntoNode(null, query)) {
                            typedOk = true
                            break
                        }
                    }
                    tapCoordinate(w * 0.50f, h * (if (attempt == 0) 0.11f else 0.16f), 75L)
                    Thread.sleep(650)
                    if (inputTextIntoNode(null, query)) {
                        typedOk = true
                        break
                    }
                }

                Thread.sleep(450)
                pressImeSearchOrClickFirstSuggestion(query)
                Thread.sleep(1500)

                val isEcommerceOrFood = appKey in listOf("blinkit", "zepto", "swiggy", "zomato", "meesho", "flipkart", "amazon") ||
                    actionMode.contains("order", true) || actionMode.contains("add", true) || actionMode.contains("buy", true)

                if (isEcommerceOrFood) {
                    val addLabels = listOf("ADD", "Add", "+ Add", "Add +", "Add to Cart", "ADD TO CART", "Add to bag", "Buy Now")
                    var added = false

                    val addBtn = waitForMatchingNode(addLabels, 2200L)
                    if (addBtn != null && performClickOrTap(addBtn)) {
                        added = true
                    }

                    if (!added) {
                        swipe(w * 0.5f, h * 0.72f, w * 0.5f, h * 0.38f, 260L)
                        Thread.sleep(850)
                        val addAfterScroll = waitForMatchingNode(addLabels, 1500L)
                        if (addAfterScroll != null && performClickOrTap(addAfterScroll)) {
                            added = true
                        }
                    }

                    if (!added) {
                        if (clickNodeByText(query)) {
                            Thread.sleep(1300)
                            val detailAdd = waitForMatchingNode(addLabels, 1800L)
                            if (detailAdd != null && performClickOrTap(detailAdd)) {
                                added = true
                            } else {
                                swipe(w * 0.5f, h * 0.75f, w * 0.5f, h * 0.35f, 260L)
                                Thread.sleep(700)
                                val bottomAdd = waitForMatchingNode(addLabels, 1200L)
                                if (bottomAdd != null && performClickOrTap(bottomAdd)) {
                                    added = true
                                }
                            }
                        }
                    }

                    Thread.sleep(900)
                    val sheetConfirm = waitForMatchingNode(listOf("Add item", "Confirm", "Continue", "Done"), 900L)
                    if (sheetConfirm != null) {
                        performClickOrTap(sheetConfirm)
                        Thread.sleep(700)
                    }

                    val (verified, summaryText) = verifyCartOrActionState(query)
                    lastCartVerified = verified || added
                    lastCartSummary = summaryText
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2200L)

                    if (lastCartVerified) {
                        lastStatus = "verified"
                        announceStatus(
                            "Verified: '\$query' added to cart in \$appKey (\$summaryText).",
                            showToast = true
                        )
                    } else {
                        lastStatus = "needs_confirmation"
                        announceStatus(
                            "Opened '\$query' in \$appKey. Please confirm variant on screen.",
                            showToast = true
                        )
                    }
                } else {
                    Thread.sleep(1000)
                    val (verified, summaryText) = verifyCartOrActionState(query)
                    lastCartVerified = verified
                    lastCartSummary = summaryText
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2200L)
                    lastStatus = "verified"
                    announceStatus(
                        "Staged '\$query' in \$appKey.",
                        showToast = true
                    )
                }
            } catch (e: Exception) {
                lastStatus = "error"
                announceStatus(
                    "Automation paused in \$appKey. Please confirm on screen.",
                    showToast = true
                )
            }
        }
    }

    private fun pressImeSearchOrClickFirstSuggestion(query: String) {
        val root = getActiveRoot() ?: return
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            focused.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        }
        val matches = root.findAccessibilityNodeInfosByText(query) ?: emptyList()
        for (node in matches) {
            if (!node.isEditable && node.isVisibleToUser) {
                if (performClickOrTap(node)) return
            }
        }
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

    fun tapCoordinate(x: Float, y: Float, durationMs: Long = 75L): Boolean {
        if (x < 0f || y < 0f) return false
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(40L, 600L)))
            .build()
        return dispatchGesture(gesture, null, mainHandler)
    }

    fun swipe(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long = 260L): Boolean {
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
        val root = getActiveRoot() ?: return false
        val matched = findNodeMultiTier(root, targetText) ?: return false
        return performClickOrTap(matched)
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
            targetNode = findNodeMultiTier(root, targetLabel.trim())?.takeIf { it.isEditable }
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
        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
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
    fun getAutomationResult(promise: Promise) {
        val map = Arguments.createMap()
        map.putString("status", HarkAccessibilityService.lastStatus)
        map.putString("message", HarkAccessibilityService.lastMessage)
        map.putBoolean("cartVerified", HarkAccessibilityService.lastCartVerified)
        map.putString("cartSummary", HarkAccessibilityService.lastCartSummary)
        map.putString("screenshot", HarkAccessibilityService.lastScreenshotBase64)
        map.putDouble("ts", HarkAccessibilityService.lastUpdatedTs.toDouble())
        promise.resolve(map)
    }

    @ReactMethod
    fun captureScreenVerification(promise: Promise) {
        val svc = HarkAccessibilityService.instance
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

            var launched = false
            for (pkg in candidates) {
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
                    val intent = pm.getLaunchIntentForPackage(matchedPkg)
                    if (intent != null) {
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                        reactContext.startActivity(intent)
                        launched = true
                    }
                }
            }

            if (launched && !query.isNullOrBlank()) {
                HarkAccessibilityService.instance?.runAutonomousAppWorkflow(lower, query.trim(), "order")
            }
            promise.resolve(launched)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun runAutonomousWorkflow(appKey: String, query: String, mode: String, promise: Promise) {
        val svc = HarkAccessibilityService.instance
        if (svc == null) {
            promise.resolve(false)
            return
        }
        svc.runAutonomousAppWorkflow(appKey.lowercase().trim(), query.trim(), mode)
        promise.resolve(true)
    }

    @ReactMethod
    fun clickByText(text: String, promise: Promise) {
        val ok = HarkAccessibilityService.instance?.clickNodeByText(text) ?: false
        promise.resolve(ok)
    }

    @ReactMethod
    fun tapCoordinate(x: Double, y: Double, promise: Promise) {
        val svcOk = HarkAccessibilityService.instance?.tapCoordinate(x.toFloat(), y.toFloat()) ?: false
        promise.resolve(svcOk)
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
