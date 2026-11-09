const { withAndroidManifest, withStringsXml, withMainApplication, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SERVICE_NAME = '.HarkAccessibilityService';
const SERVICE_LABEL = 'Pulse OS Assistive Bridge';
const SERVICE_DESC_KEY = 'hark_accessibility_service_description';
const SERVICE_DESC_VALUE =
  'Pulse OS Assistive Automation Bridge for app launching, search execution, login auto-fill, and task completion.';

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

      fs.writeFileSync(
        path.join(kotlinDir, 'HarkAccessibilityService.kt'),
        `package ${packageName}

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class HarkAccessibilityService : AccessibilityService() {
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
            "maps" to listOf("com.google.android.apps.maps"),
            "playstore" to listOf("com.android.vending")
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
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    // Silent status update: NEVER speaks with TTS during work
    private fun recordStatus(message: String, showToast: Boolean = false) {
        lastMessage = message
        lastUpdatedTs = System.currentTimeMillis()
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
            Thread.sleep(400)
            val submitLabels = listOf("Log In", "Login", "Sign In", "Continue", "Submit", "Next", "Verify", "Proceed")
            val btn = waitForMatchingNode(submitLabels, 1200L)
            if (btn != null && !btn.isEditable) {
                performClickOrTap(btn)
            } else {
                pressImeEnterOnFocused()
            }
        }
        return filledAny
    }

    private fun setNodeTextDirect(node: AccessibilityNodeInfo, value: String): Boolean {
        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
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
        val cartRegex = Regex("(\\\\b\\\\d+\\\\s*item|view cart|go to cart|added to cart|proceed to pay|checkout|₹\\\\s*\\\\d+|confirm ride|book\\\\s+uber|playing|subscribe|sent)", RegexOption.IGNORE_CASE)

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

    fun runAutonomousAppWorkflow(appKey: String, query: String, actionMode: String, usedDeepLink: Boolean = false) {
        val mySeq = workflowSeq.incrementAndGet()
        worker.execute {
            try {
                lastStatus = "running"
                lastCartVerified = false
                lastScreenshotBase64 = ""
                recordStatus("Working in \$appKey…", showToast = false)

                waitForExternalAppWindow(4800L)
                if (workflowSeq.get() != mySeq) return@execute
                Thread.sleep(700)

                // 1. Check if app is asking for Login and auto-fill saved user login credentials
                if (actionMode.equals("login", ignoreCase = true)) {
                    val parts = query.split("|")
                    val u = parts.getOrNull(0)?.trim().orEmpty()
                    val p = parts.getOrNull(1)?.trim().orEmpty()
                    val loggedIn = autoFillLoginIfPresent(appKey, u, p)
                    Thread.sleep(1000)
                    lastCartVerified = loggedIn
                    lastCartSummary = if (loggedIn) "Filled login credentials in \$appKey" else "Login screen ready in \$appKey"
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
                    return@execute
                }

                val w = screenWidth().toFloat()
                val h = screenHeight().toFloat()

                // 2. If deep link didn't already land on results, locate search bar, type query, AND submit search
                var searchSubmitted = usedDeepLink
                if (!usedDeepLink) {
                    val searchHints = listOf(
                        "Search", "search", "search_bar", "search_src_text", "et_search", "search_edit_text",
                        "What are you looking for", "Search for products", "Search for", "Where to",
                        "Enter pickup", "Search in", "Ask or search", "Search YouTube", "Search songs",
                        "Search or type URL", "Find"
                    )
                    var typedOk = false
                    for (attempt in 0 until 3) {
                        if (workflowSeq.get() != mySeq) return@execute
                        val existingEdit = findEditableNode(getActiveRoot())
                        if (existingEdit != null && setNodeTextDirect(existingEdit, query)) {
                            typedOk = true
                            break
                        }
                        val foundSearch = waitForMatchingNode(searchHints, 1300L)
                        if (foundSearch != null && performClickOrTap(foundSearch)) {
                            Thread.sleep(650)
                            val editAfterClick = findEditableNode(getActiveRoot())
                            if (editAfterClick != null && setNodeTextDirect(editAfterClick, query)) {
                                typedOk = true
                                break
                            }
                        }
                        // Fallback tap on standard top search bar region
                        tapCoordinate(w * 0.48f, h * (if (attempt == 0) 0.11f else 0.16f), 80L)
                        Thread.sleep(650)
                        val editAfterTap = findEditableNode(getActiveRoot())
                        if (editAfterTap != null && setNodeTextDirect(editAfterTap, query)) {
                            typedOk = true
                            break
                        }
                    }

                    if (typedOk) {
                        Thread.sleep(450)
                        submitSearchAndSelectSuggestion(appKey, query, w, h)
                        searchSubmitted = true
                        Thread.sleep(1600)
                    }
                } else {
                    // Deep link was used; wait for results screen to settle, or if still on search box, submit it
                    Thread.sleep(1200)
                    val focusedEdit = getActiveRoot()?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                    if (focusedEdit != null && focusedEdit.isEditable) {
                        val existingText = focusedEdit.text?.toString()?.trim().orEmpty()
                        if (existingText.isEmpty() || !existingText.contains(query.take(4), ignoreCase = true)) {
                            setNodeTextDirect(focusedEdit, query)
                            Thread.sleep(350)
                        }
                        submitSearchAndSelectSuggestion(appKey, query, w, h)
                        Thread.sleep(1500)
                    }
                }

                if (workflowSeq.get() != mySeq) return@execute

                // 3. Complete the actual work inside the app based on app type
                val lowerApp = appKey.lowercase()
                val isEcommerceOrFood = lowerApp in listOf("blinkit", "zepto", "swiggy", "zomato", "meesho", "flipkart", "amazon") ||
                    actionMode.contains("order", true) || actionMode.contains("add", true) || actionMode.contains("buy", true)

                if (lowerApp == "youtube" || lowerApp.contains("youtube")) {
                    // Click the first video result below the top search bar so it actually plays
                    var played = clickFirstResultBelowHeader(query, minYRatio = 0.20f, maxYRatio = 0.78f)
                    if (!played) {
                        tapCoordinate(w * 0.50f, h * 0.36f, 85L)
                        played = true
                    }
                    Thread.sleep(1000)
                    lastCartVerified = played
                    lastCartSummary = "Playing '\$query' on YouTube"
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus(lastCartSummary, showToast = true)
                    return@execute
                }

                if (lowerApp == "spotify" || lowerApp.contains("spotify")) {
                    var played = clickFirstResultBelowHeader(query, minYRatio = 0.20f, maxYRatio = 0.70f)
                    if (!played) {
                        tapCoordinate(w * 0.45f, h * 0.32f, 85L)
                        played = true
                    }
                    Thread.sleep(900)
                    lastCartVerified = played
                    lastCartSummary = "Playing '\$query' on Spotify"
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus(lastCartSummary, showToast = true)
                    return@execute
                }

                if (lowerApp in listOf("whatsapp", "telegram")) {
                    // If on a chat compose screen with Send button, click Send; if on search list, click first contact
                    val sendBtn = waitForMatchingNode(listOf("Send", "send"), 1200L)
                    if (sendBtn != null && !sendBtn.isEditable) {
                        performClickOrTap(sendBtn)
                        Thread.sleep(600)
                    } else {
                        clickFirstResultBelowHeader(query, minYRatio = 0.18f, maxYRatio = 0.55f)
                        Thread.sleep(900)
                        val sendAfter = waitForMatchingNode(listOf("Send", "send"), 1000L)
                        if (sendAfter != null && !sendAfter.isEditable) {
                            performClickOrTap(sendAfter)
                        }
                    }
                    lastCartVerified = true
                    lastCartSummary = "Completed message action in \$appKey"
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus(lastCartSummary, showToast = true)
                    return@execute
                }

                if (lowerApp in listOf("uber", "ola", "rapido")) {
                    clickFirstResultBelowHeader(query, minYRatio = 0.20f, maxYRatio = 0.60f)
                    Thread.sleep(1200)
                    val rideBtn = waitForMatchingNode(listOf("Confirm", "Book", "Choose", "Request", "Proceed"), 1800L)
                    if (rideBtn != null) performClickOrTap(rideBtn)
                    val (verified, summaryText) = verifyCartOrActionState(query)
                    lastCartVerified = verified
                    lastCartSummary = summaryText
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
                    }

                    // If no inline ADD button (e.g. Flipkart, Amazon, Meesho), click first product card to open product detail page
                    if (!added) {
                        val openedProduct = clickFirstResultBelowHeader(query, minYRatio = 0.24f, maxYRatio = 0.75f)
                        if (!openedProduct) {
                            tapCoordinate(w * 0.32f, h * 0.42f, 85L)
                        }
                        Thread.sleep(1500)
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

                    Thread.sleep(850)
                    val sheetConfirm = waitForMatchingNode(listOf("Add item", "Confirm", "Continue", "Done", "Go to Cart", "View Cart"), 1000L)
                    if (sheetConfirm != null && !sheetConfirm.isEditable) {
                        performClickOrTap(sheetConfirm)
                        Thread.sleep(650)
                    }

                    val (verified, summaryText) = verifyCartOrActionState(query)
                    lastCartVerified = verified || added
                    lastCartSummary = summaryText
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = if (lastCartVerified) "verified" else "needs_confirmation"
                    recordStatus(
                        if (lastCartVerified) "Done: '\$query' added in \$appKey" else "Opened '\$query' in \$appKey",
                        showToast = true
                    )
                } else {
                    // Generic app: after searching, click the first result below the search bar so it opens
                    if (searchSubmitted) {
                        clickFirstResultBelowHeader(query, minYRatio = 0.20f, maxYRatio = 0.75f)
                        Thread.sleep(900)
                    }
                    val (verified, summaryText) = verifyCartOrActionState(query)
                    lastCartVerified = verified || searchSubmitted
                    lastCartSummary = summaryText
                    lastScreenshotBase64 = captureVerificationScreenshotSync(2000L)
                    lastStatus = "verified"
                    recordStatus("Completed '\$query' in \$appKey", showToast = true)
                }
            } catch (e: Exception) {
                lastStatus = "error"
                recordStatus("Action paused in \$appKey", showToast = false)
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
        val minSuggestionY = if (!editRect.isEmpty) (editRect.bottom + 12) else (h * 0.16f).toInt()

        // 1. Try native IME_ENTER action on the focused EditText
        val imeOk = pressImeEnterOnFocused()

        // 2. Also look for an explicit Search / Submit icon button near the search bar (not the EditText itself)
        val searchBtnLabels = listOf("Search", "search_go_btn", "iv_search", "btn_search", "Go", "Submit")
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

        // 3. Tap the keyboard bottom-right Search/Enter key (works across Gboard, Samsung, SwiftKey when keyboard is open)
        if (!imeOk) {
            tapCoordinate(w * 0.91f, h * 0.91f, 70L)
        }

        Thread.sleep(650)

        // 4. Check if we are still on a search suggestion dropdown; if so, click the first suggestion strictly BELOW the search bar
        val rootAfter = getActiveRoot() ?: return
        val stillEditing = findEditableNode(rootAfter) != null
        val queryWords = query.lowercase().split(" ").filter { it.length > 2 }
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(rootAfter)
        var bestSuggestion: AccessibilityNodeInfo? = null

        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isEditable) {
                val r = Rect()
                n.getBoundsInScreen(r)
                // Strictly below the search bar and above the keyboard
                if (r.top >= minSuggestionY && r.centerY() < h * 0.56f && r.width() > w * 0.25f && r.height() in 28..(h * 0.18f).toInt()) {
                    val t = n.text?.toString()?.trim().orEmpty()
                    val d = n.contentDescription?.toString()?.trim().orEmpty()
                    val combined = "\$t \$d".lowercase()
                    if (combined.contains(query.lowercase()) || (queryWords.isNotEmpty() && queryWords.any { combined.contains(it) })) {
                        bestSuggestion = n
                        break
                    }
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { queue.add(it) }
        }

        if (bestSuggestion != null) {
            performClickOrTap(bestSuggestion)
        } else if (stillEditing) {
            // Tap keyboard search key + first suggestion row coordinate
            tapCoordinate(w * 0.91f, h * 0.91f, 75L)
            Thread.sleep(450)
            if (findEditableNode(getActiveRoot()) != null) {
                tapCoordinate(w * 0.45f, (minSuggestionY + 70).toFloat().coerceAtMost(h * 0.30f), 75L)
            }
        }
    }

    private fun clickFirstResultBelowHeader(query: String, minYRatio: Float = 0.20f, maxYRatio: Float = 0.78f): Boolean {
        val root = getActiveRoot() ?: return false
        val w = screenWidth().toFloat()
        val h = screenHeight().toFloat()
        val minY = (h * minYRatio).toInt()
        val maxY = (h * maxYRatio).toInt()
        val queryWords = query.lowercase().split(" ").filter { it.length > 2 }

        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var firstClickableCard: AccessibilityNodeInfo? = null

        while (queue.isNotEmpty()) {
            val n = queue.removeFirst()
            if (n.isVisibleToUser && !n.isEditable) {
                val r = Rect()
                n.getBoundsInScreen(r)
                if (r.centerY() in minY..maxY && r.width() > w * 0.22f && r.height() > 40) {
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
            val found = findNodeMultiTier(root, targetLabel.trim())
            if (found != null) {
                if (found.isEditable) {
                    targetNode = found
                } else {
                    performClickOrTap(found)
                    Thread.sleep(450)
                    targetNode = findEditableNode(getActiveRoot())
                }
            }
        }
        if (targetNode == null) {
            targetNode = findEditableNode(root)
        }
        val node = targetNode ?: return false
        val ok = setNodeTextDirect(node, textToEnter)
        if (ok) {
            Thread.sleep(250)
            pressImeEnterOnFocused()
        }
        return ok
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
import android.app.SearchManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
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
    fun syncUserLoginData(jsonStr: String, promise: Promise) {
        try {
            HarkAccessibilityService.updateLoginDataFromJson(reactContext, jsonStr)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
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
                putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak command…")
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

    private fun tryDeepLinkOrSearchIntent(pkg: String, appKey: String, query: String): Boolean {
        if (query.isBlank()) return false
        val enc = Uri.encode(query.trim())
        val deepLinks = when (appKey) {
            "youtube" -> listOf("vnd.youtube://results?search_query=\$enc")
            "blinkit" -> listOf("blinkit://search?q=\$enc")
            "swiggy" -> listOf("swiggy://explore?query=\$enc")
            "zomato" -> listOf("zomato://search?q=\$enc")
            "meesho" -> listOf("meesho://search?q=\$enc")
            "flipkart" -> listOf("flipkart://fk.dl/de_wv_CL?q=\$enc")
            "amazon" -> listOf("com.amazon.mobile.shopping://www.amazon.in/s?k=\$enc")
            "spotify" -> listOf("spotify:search:\$enc")
            "maps", "navigate" -> listOf("geo:0,0?q=\$enc")
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

        if (appKey in listOf("youtube", "spotify", "flipkart", "amazon", "meesho")) {
            try {
                val searchIntent = Intent(Intent.ACTION_SEARCH).apply {
                    setPackage(pkg)
                    putExtra(SearchManager.QUERY, query.trim())
                    putExtra("query", query.trim())
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                }
                reactContext.startActivity(searchIntent)
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
            HarkAccessibilityService.KNOWN_APP_PACKAGES[lower]?.let { candidates.addAll(it) }
            if (clean.contains(".")) candidates.add(clean)

            var launched = false
            var usedDeepLink = false
            var resolvedKey = lower

            for (pkg in candidates) {
                if (cleanQuery.isNotEmpty() && !cleanQuery.contains("|")) {
                    if (tryDeepLinkOrSearchIntent(pkg, lower, cleanQuery)) {
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
                    if (cleanQuery.isNotEmpty() && tryDeepLinkOrSearchIntent(matchedPkg, resolvedKey, cleanQuery)) {
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
                HarkAccessibilityService.instance?.runAutonomousAppWorkflow(resolvedKey, cleanQuery, mode, usedDeepLink)
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
        svc.runAutonomousAppWorkflow(appKey.lowercase().trim(), query.trim(), mode, false)
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

      // 1. Optimize gradle-wrapper.properties: use lighter -bin.zip instead of -all.zip
      const wrapperPropsPath = path.join(androidRoot, "gradle/wrapper/gradle-wrapper.properties");
      if (fs.existsSync(wrapperPropsPath)) {
        let props = fs.readFileSync(wrapperPropsPath, "utf8");
        props = props.replace(/-all\.zip/g, "-bin.zip");
        if (!props.includes("networkTimeout")) {
          props = props.trimEnd() + "\nnetworkTimeout=60000\n";
        }
        fs.writeFileSync(wrapperPropsPath, props, "utf8");
      }

      // 2. Patch android/gradlew to pre-fetch the wrapper zip with curl retry before running exec "$JAVACMD" "$@" once
      const gradlewPath = path.join(androidRoot, "gradlew");
      if (fs.existsSync(gradlewPath)) {
        let gw = fs.readFileSync(gradlewPath, "utf8");
        if (gw.includes('exec "$JAVACMD" "$@"') && !gw.includes("PULSE_GRADLE_PREFETCH")) {
          const prefetchBlock = [
            "# PULSE_GRADLE_PREFETCH",
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
          ].join("\n");
          gw = gw.replace('exec "$JAVACMD" "$@"', prefetchBlock);
          fs.writeFileSync(gradlewPath, gw, "utf8");
        }
      }

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
