const {
  withAndroidManifest,
  withMainApplication,
  withDangerousMod,
  withGradleProperties,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

const ACCESSIBILITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeAllMask"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagDefault|flagIncludeNotImportantViews|flagReportViewIds|flagRetrieveInteractiveWindows|flagRequestEnhancedWebAccessibility"
    android:canPerformGestures="true"
    android:canRetrieveWindowContent="true"
    android:canTakeScreenshot="true"
    android:description="@string/hark_accessibility_desc"
    android:notificationTimeout="80" />
`;

const HARK_ACCESSIBILITY_SERVICE_KT = `package __PACKAGE__

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.util.Base64
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class HarkAccessibilityService : AccessibilityService(), TextToSpeech.OnInitListener {

    companion object {
        @Volatile
        var instance: HarkAccessibilityService? = null
        val stepLogs = CopyOnWriteArrayList<String>()
        @Volatile
        var voiceNarrationEnabled: Boolean = true
        @Volatile
        var preferredVoiceLang: String = "te-IN"
        @Volatile
        var lastActivePackage: String = ""

        fun logStep(msg: String) {
            val ts = java.text.SimpleDateFormat("HH:mm:ss", Locale.US).format(java.util.Date())
            val entry = "[\$ts] \$msg"
            stepLogs.add(entry)
            while (stepLogs.size > 80) {
                stepLogs.removeAt(0)
            }
            Log.d("HarkAccessibility", entry)
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ttsReady: Boolean = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        try {
            tts = TextToSpeech(applicationContext, this)
        } catch (e: Exception) {
            Log.w("HarkAccessibility", "TTS init failed: \${e.message}")
        }
        logStep("Hark Pro OmniCore Accessibility Bridge connected.")
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            ttsReady = true
            try {
                val teLocale = Locale.forLanguageTag("te-IN")
                val res = tts?.setLanguage(teLocale)
                if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                    tts?.setLanguage(Locale.forLanguageTag("en-IN"))
                }
                tts?.setPitch(1.02f)
                tts?.setSpeechRate(0.97f)
            } catch (_: Exception) {}
        }
    }

    fun containsTeluguScript(text: String): Boolean {
        for (ch in text) {
            if (ch.code in 0x0C00..0x0C7F) return true
        }
        return false
    }

    fun narrateStep(enMessage: String, teMessage: String = "") {
        logStep(enMessage)
        if (!voiceNarrationEnabled || !ttsReady) return
        mainHandler.post {
            try {
                val useTelugu = preferredVoiceLang.startsWith("te", ignoreCase = true) && teMessage.isNotBlank()
                val textToSpeak = if (useTelugu) teMessage else enMessage
                val targetLocale = if (containsTeluguScript(textToSpeak) || useTelugu) {
                    Locale.forLanguageTag("te-IN")
                } else {
                    Locale.forLanguageTag("en-IN")
                }
                val langSupport = tts?.isLanguageAvailable(targetLocale) ?: TextToSpeech.LANG_NOT_SUPPORTED
                if (langSupport >= TextToSpeech.LANG_AVAILABLE) {
                    tts?.language = targetLocale
                    tts?.speak(textToSpeak, TextToSpeech.QUEUE_ADD, null, "hark_step_\${System.currentTimeMillis()}")
                } else {
                    tts?.language = Locale.forLanguageTag("en-IN")
                    tts?.speak(enMessage, TextToSpeech.QUEUE_ADD, null, "hark_step_\${System.currentTimeMillis()}")
                }
            } catch (e: Exception) {
                Log.w("HarkAccessibility", "Narrate error: \${e.message}")
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        val pkg = event.packageName?.toString() ?: ""
        if (pkg.isNotBlank() && pkg != packageName) {
            lastActivePackage = pkg
        }
    }

    override fun onInterrupt() {
        logStep("Accessibility service interrupted.")
    }

    override fun onDestroy() {
        super.onDestroy()
        if (instance === this) {
            instance = null
        }
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (_: Exception) {}
    }

    private fun getAllRootNodes(): List<AccessibilityNodeInfo> {
        val roots = mutableListOf<AccessibilityNodeInfo>()
        try {
            val active = rootInActiveWindow
            if (active != null) roots.add(active)
        } catch (_: Exception) {}
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                val winList = windows
                if (winList != null) {
                    for (w in winList) {
                        val r = w.root
                        if (r != null && !roots.contains(r)) {
                            roots.add(r)
                        }
                    }
                }
            }
        } catch (_: Exception) {}
        return roots
    }

    fun dumpScreenSummary(): String {
        val obj = JSONObject()
        val texts = JSONArray()
        val clickables = JSONArray()
        val editables = JSONArray()
        val nodesArray = JSONArray()
        var activePkg = lastActivePackage

        try {
            val roots = getAllRootNodes()
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            for (r in roots) {
                if (activePkg.isBlank() && r.packageName != null) {
                    activePkg = r.packageName.toString()
                }
                queue.add(r)
            }

            var visited = 0
            val seenTexts = HashSet<String>()
            while (queue.isNotEmpty() && visited < 260) {
                val node = queue.removeFirst()
                visited++
                val rawText = node.text?.toString()?.trim() ?: ""
                val rawDesc = node.contentDescription?.toString()?.trim() ?: ""
                val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    node.hintText?.toString()?.trim() ?: ""
                } else ""
                val label = when {
                    rawText.isNotEmpty() -> rawText
                    rawDesc.isNotEmpty() -> rawDesc
                    hint.isNotEmpty() -> hint
                    else -> ""
                }
                val viewId = node.viewIdResourceName ?: ""
                val rect = Rect()
                node.getBoundsInScreen(rect)

                if (label.isNotEmpty() && seenTexts.add(label)) {
                    texts.put(label)
                }
                if (node.isEditable) {
                    val ed = JSONObject()
                    ed.put("label", label)
                    ed.put("viewId", viewId)
                    ed.put("focused", node.isFocused)
                    ed.put("cx", rect.centerX())
                    ed.put("cy", rect.centerY())
                    editables.put(ed)
                }
                if (node.isClickable && label.isNotEmpty()) {
                    clickables.put(label)
                }
                if ((label.isNotEmpty() || node.isEditable || node.isClickable) && nodesArray.length() < 90) {
                    val nObj = JSONObject()
                    nObj.put("text", label)
                    nObj.put("id", viewId.substringAfterLast("/"))
                    nObj.put("clickable", node.isClickable)
                    nObj.put("editable", node.isEditable)
                    nObj.put("scrollable", node.isScrollable)
                    nObj.put("cx", rect.centerX())
                    nObj.put("cy", rect.centerY())
                    nObj.put("w", rect.width())
                    nObj.put("h", rect.height())
                    nodesArray.put(nObj)
                }

                for (i in 0 until node.childCount) {
                    val child = node.getChild(i)
                    if (child != null) {
                        queue.add(child)
                    }
                }
            }
        } catch (e: Exception) {
            obj.put("error", e.message ?: "dump error")
        }

        obj.put("packageName", activePkg)
        obj.put("texts", texts)
        obj.put("clickables", clickables)
        obj.put("editables", editables)
        obj.put("nodes", nodesArray)
        return obj.toString()
    }

    private fun resolveCoords(x: Double, y: Double): Pair<Float, Float> {
        val dm = resources.displayMetrics
        val w = dm.widthPixels.toFloat().coerceAtLeast(1080f)
        val h = dm.heightPixels.toFloat().coerceAtLeast(1920f)
        val px = if (x in 0.0..1.0 && y in 0.0..1.0 && (x < 1.0 || y < 1.0)) {
            (x * w).toFloat()
        } else {
            x.toFloat()
        }
        val py = if (x in 0.0..1.0 && y in 0.0..1.0 && (x < 1.0 || y < 1.0)) {
            (y * h).toFloat()
        } else {
            y.toFloat()
        }
        return Pair(px.coerceIn(2f, w - 2f), py.coerceIn(2f, h - 2f))
    }

    fun tap(x: Double, y: Double): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val (px, py) = resolveCoords(x, y)
        val path = Path().apply { moveTo(px, py) }
        val stroke = GestureDescription.StrokeDescription(path, 0L, 65L)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        val latch = CountDownLatch(1)
        var ok = false
        mainHandler.post {
            try {
                ok = dispatchGesture(gesture, object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        latch.countDown()
                    }
                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        latch.countDown()
                    }
                }, null)
            } catch (_: Exception) {
                latch.countDown()
            }
        }
        latch.await(900, TimeUnit.MILLISECONDS)
        logStep("Tapped screen at (\${px.toInt()}, \${py.toInt()})")
        return ok
    }

    fun longPress(x: Double, y: Double, durationMs: Long = 650L): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val (px, py) = resolveCoords(x, y)
        val path = Path().apply { moveTo(px, py) }
        val stroke = GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(400L, 3000L))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        var ok = false
        val latch = CountDownLatch(1)
        mainHandler.post {
            try {
                ok = dispatchGesture(gesture, object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        latch.countDown()
                    }
                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        latch.countDown()
                    }
                }, null)
            } catch (_: Exception) {
                latch.countDown()
            }
        }
        latch.await(durationMs + 500L, TimeUnit.MILLISECONDS)
        logStep("Long-pressed at (\${px.toInt()}, \${py.toInt()})")
        return ok
    }

    fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Long = 320L): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false
        val (sx, sy) = resolveCoords(x1, y1)
        val (ex, ey) = resolveCoords(x2, y2)
        val path = Path().apply {
            moveTo(sx, sy)
            lineTo(ex, ey)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0L, durationMs.coerceIn(120L, 2500L))
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        var ok = false
        val latch = CountDownLatch(1)
        mainHandler.post {
            try {
                ok = dispatchGesture(gesture, object : GestureResultCallback() {
                    override fun onCompleted(gestureDescription: GestureDescription?) {
                        latch.countDown()
                    }
                    override fun onCancelled(gestureDescription: GestureDescription?) {
                        latch.countDown()
                    }
                }, null)
            } catch (_: Exception) {
                latch.countDown()
            }
        }
        latch.await(durationMs + 500L, TimeUnit.MILLISECONDS)
        logStep("Swiped (\${sx.toInt()},\${sy.toInt()}) -> (\${ex.toInt()},\${ey.toInt()})")
        return ok
    }

    private fun clickNodeOrParent(node: AccessibilityNodeInfo): Boolean {
        var curr: AccessibilityNodeInfo? = node
        var depth = 0
        while (curr != null && depth < 6) {
            if (curr.isClickable && curr.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return true
            }
            curr = curr.parent
            depth++
        }
        val rect = Rect()
        node.getBoundsInScreen(rect)
        if (rect.width() > 0 && rect.height() > 0) {
            return tap(rect.centerX().toDouble(), rect.centerY().toDouble())
        }
        return false
    }

    fun clickByText(target: String, exact: Boolean = false): Boolean {
        val query = target.trim()
        if (query.isEmpty()) return false
        val roots = getAllRootNodes()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        for (r in roots) queue.add(r)

        var bestCandidate: AccessibilityNodeInfo? = null
        var bestScore = 0

        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val txt = node.text?.toString()?.trim() ?: ""
            val desc = node.contentDescription?.toString()?.trim() ?: ""
            val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                node.hintText?.toString()?.trim() ?: ""
            } else ""

            val candidates = listOf(txt, desc, hint).filter { it.isNotEmpty() }
            for (c in candidates) {
                val score = when {
                    c.equals(query, ignoreCase = true) -> 100
                    !exact && c.startsWith(query, ignoreCase = true) -> 85
                    !exact && c.contains(query, ignoreCase = true) -> 70
                    !exact && query.contains(c, ignoreCase = true) && c.length >= 4 -> 55
                    else -> 0
                }
                if (score > bestScore) {
                    bestScore = score
                    bestCandidate = node
                }
            }

            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }

        if (bestCandidate != null) {
            val clicked = clickNodeOrParent(bestCandidate)
            if (clicked) {
                logStep("Clicked node matching '\$query' (score=\$bestScore)")
                return true
            }
        }
        return false
    }

    fun clickByViewId(viewId: String): Boolean {
        val roots = getAllRootNodes()
        for (r in roots) {
            val list = r.findAccessibilityNodeInfosByViewId(viewId)
            if (!list.isNullOrEmpty()) {
                for (n in list) {
                    if (clickNodeOrParent(n)) {
                        logStep("Clicked viewId '\$viewId'")
                        return true
                    }
                }
            }
        }
        return false
    }

    fun scrollScreen(direction: String): Boolean {
        val dir = direction.lowercase(Locale.US).trim()
        val roots = getAllRootNodes()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        for (r in roots) queue.add(r)

        val action = when (dir) {
            "up", "backward", "right" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            else -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
        }

        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.isScrollable && node.performAction(action)) {
                logStep("Scrolled scrollable container (\$dir)")
                return true
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }

        val dm = resources.displayMetrics
        val cx = dm.widthPixels * 0.5
        val h = dm.heightPixels.toDouble()
        return when (dir) {
            "up", "backward" -> swipe(cx, h * 0.28, cx, h * 0.78, 320L)
            "left" -> swipe(dm.widthPixels * 0.82, h * 0.5, dm.widthPixels * 0.18, h * 0.5, 280L)
            "right" -> swipe(dm.widthPixels * 0.18, h * 0.5, dm.widthPixels * 0.82, h * 0.5, 280L)
            else -> swipe(cx, h * 0.78, cx, h * 0.24, 320L)
        }
    }

    fun selectPrimaryVisibleItem(hintText: String = ""): Boolean {
        if (hintText.isNotBlank() && clickByText(hintText, false)) {
            narrateStep("Selected \$hintText", "\$hintText సెలెక్ట్ చేశాను")
            return true
        }
        val dm = resources.displayMetrics
        val screenH = dm.heightPixels
        val screenW = dm.widthPixels
        val ignoreWords = setOf(
            "back", "navigate up", "close", "cancel", "search", "clear",
            "home", "menu", "more options", "profile", "cart", "filter", "sort"
        )

        val roots = getAllRootNodes()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        for (r in roots) queue.add(r)

        var bestNode: AccessibilityNodeInfo? = null
        var bestScore = -1
        var bestLabel = ""

        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val label = (node.text?.toString() ?: node.contentDescription?.toString() ?: "").trim()
            val rect = Rect()
            node.getBoundsInScreen(rect)

            val inContentZone = rect.centerY() in (screenH * 0.16).toInt()..(screenH * 0.86).toInt()
            val validSize = rect.width() > 60 && rect.height() > 36
            val lower = label.lowercase(Locale.US)

            if (inContentZone && validSize && label.length >= 3 && !ignoreWords.contains(lower) && !node.isEditable) {
                var score = 10
                if (node.isClickable || node.parent?.isClickable == true) score += 45
                if (label.length in 6..90) score += 25
                if (rect.centerX() in (screenW * 0.15).toInt()..(screenW * 0.85).toInt()) score += 15
                if (lower.contains("add") || lower.contains("buy") || lower.contains("play") || lower.contains("open")) {
                    score += 20
                }
                if (score > bestScore) {
                    bestScore = score
                    bestNode = node
                    bestLabel = label
                }
            }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }

        if (bestNode != null && clickNodeOrParent(bestNode)) {
            val shortName = if (bestLabel.length > 28) bestLabel.take(28) + "..." else bestLabel
            narrateStep("Selected item: \$shortName", "\$shortName ఎంచుకున్నాను")
            return true
        }

        val fallbackOk = tap(screenW * 0.5, screenH * 0.36)
        narrateStep("Selected top item on screen", "స్క్రీన్ పై ఉన్న మొదటి ఐటమ్ సెలెక్ట్ చేశాను")
        return fallbackOk
    }

    fun proceedOnScreen(): Boolean {
        val priorityTargets = listOf(
            "Proceed to Pay", "Proceed to Checkout", "Proceed", "Continue",
            "Place Order", "Buy Now", "Add to Cart", "Go to Cart", "View Cart",
            "Next", "Submit", "Confirm", "Send", "Apply", "Done", "Accept", "Allow", "OK", "ADD"
        )
        for (label in priorityTargets) {
            if (clickByText(label, false)) {
                narrateStep("Proceeding via '\$label'", "'\$label' బటన్ నొక్కాను, ముందుకు వెళ్తున్నాను")
                return true
            }
        }
        return selectPrimaryVisibleItem("")
    }

    private fun findSearchNode(): AccessibilityNodeInfo? {
        val roots = getAllRootNodes()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        for (r in roots) queue.add(r)

        var editableCandidate: AccessibilityNodeInfo? = null
        var searchBarCandidate: AccessibilityNodeInfo? = null

        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val txt = (node.text?.toString() ?: "").lowercase(Locale.US)
            val desc = (node.contentDescription?.toString() ?: "").lowercase(Locale.US)
            val vid = (node.viewIdResourceName ?: "").lowercase(Locale.US)
            val hint = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                (node.hintText?.toString() ?: "").lowercase(Locale.US)
            } else ""

            val combined = "\$txt \$desc \$vid \$hint"
            if (node.isEditable) {
                if (combined.contains("search") || combined.contains("find") || combined.contains("query") || combined.contains("ask")) {
                    return node
                }
                if (editableCandidate == null) editableCandidate = node
            } else if (combined.contains("search") || combined.contains("find_in") || combined.contains("search_bar") || combined.contains("search_box")) {
                if (searchBarCandidate == null) searchBarCandidate = node
            }

            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.add(it) }
            }
        }
        return editableCandidate ?: searchBarCandidate
    }

    fun typeText(text: String, submit: Boolean = true): Boolean {
        val roots = getAllRootNodes()
        var targetNode: AccessibilityNodeInfo? = null

        for (r in roots) {
            val focused = r.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            if (focused != null && focused.isEditable) {
                targetNode = focused
                break
            }
        }
        if (targetNode == null) {
            targetNode = findSearchNode()
        }

        if (targetNode != null && !targetNode.isEditable) {
            clickNodeOrParent(targetNode)
            try { Thread.sleep(450) } catch (_: Exception) {}
            targetNode = findSearchNode()
        }

        var typedOk = false
        if (targetNode != null) {
            clickNodeOrParent(targetNode)
            val args = Bundle()
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            typedOk = targetNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)

            if (!typedOk) {
                try {
                    val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    cm.setPrimaryClip(ClipData.newPlainText("hark_input", text))
                    targetNode.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                    typedOk = targetNode.performAction(AccessibilityNodeInfo.ACTION_PASTE)
                } catch (_: Exception) {}
            }
        }

        if (submit) {
            try { Thread.sleep(320) } catch (_: Exception) {}
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && targetNode != null) {
                targetNode.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            }
            val dm = resources.displayMetrics
            tap(dm.widthPixels * 0.91, dm.heightPixels * 0.93)
        }
        logStep("Typed '\$text' (ok=\$typedOk, submit=\$submit)")
        return typedOk
    }

    fun performInAppSearch(query: String): Boolean {
        val cleanQuery = query.trim()
        if (cleanQuery.isEmpty()) return false
        narrateStep("Searching for \$cleanQuery", "\$cleanQuery కోసం వెతుకుతున్నాను")

        val searchNode = findSearchNode()
        if (searchNode != null) {
            clickNodeOrParent(searchNode)
            try { Thread.sleep(500) } catch (_: Exception) {}
        } else {
            val dm = resources.displayMetrics
            tap(dm.widthPixels * 0.5, dm.heightPixels * 0.11)
            try { Thread.sleep(500) } catch (_: Exception) {}
        }

        val ok = typeText(cleanQuery, true)
        try { Thread.sleep(750) } catch (_: Exception) {}
        clickByText(cleanQuery, false)
        return ok
    }

    fun performGlobal(actionName: String): Boolean {
        val act = when (actionName.lowercase(Locale.US).trim()) {
            "back" -> GLOBAL_ACTION_BACK
            "home" -> GLOBAL_ACTION_HOME
            "recents", "recent" -> GLOBAL_ACTION_RECENTS
            "notifications", "notification" -> GLOBAL_ACTION_NOTIFICATIONS
            "quick_settings", "settings" -> GLOBAL_ACTION_QUICK_SETTINGS
            "power", "power_dialog" -> GLOBAL_ACTION_POWER_DIALOG
            "lock", "lock_screen" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_LOCK_SCREEN else GLOBAL_ACTION_BACK
            "screenshot" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) GLOBAL_ACTION_TAKE_SCREENSHOT else GLOBAL_ACTION_BACK
            else -> GLOBAL_ACTION_BACK
        }
        val ok = performGlobalAction(act)
        logStep("Performed global action '\$actionName' (ok=\$ok)")
        return ok
    }

    fun executeHandsFreeVoiceAction(spokenText: String): JSONObject {
        val res = JSONObject()
        val raw = spokenText.trim()
        val lower = raw.lowercase(Locale.US)
        res.put("spoken", raw)

        when {
            lower.contains("scroll down") || lower.contains("go down") || lower == "down" ||
            lower.contains("kindiki") || raw.contains("క్రిందికి") || raw.contains("కిందికి") -> {
                narrateStep("Scrolling down", "కిందికి స్క్రోల్ చేస్తున్నాను")
                val ok = scrollScreen("down")
                res.put("handled", true)
                res.put("action", "scroll_down")
                res.put("ok", ok)
            }
            lower.contains("scroll up") || lower.contains("go up") || lower == "up" ||
            lower.contains("paiki") || raw.contains("పైకి") -> {
                narrateStep("Scrolling up", "పైకి స్క్రోల్ చేస్తున్నాను")
                val ok = scrollScreen("up")
                res.put("handled", true)
                res.put("action", "scroll_up")
                res.put("ok", ok)
            }
            lower.startsWith("select ") || lower == "select it" || lower == "select" ||
            lower == "click it" || lower == "open it" || lower == "choose it" ||
            lower.contains("select chey") || raw.contains("సెలెక్ట్") || raw.contains("ఎంచుకో") -> {
                val targetHint = lower
                    .removePrefix("select it")
                    .removePrefix("select")
                    .removePrefix("click it")
                    .removePrefix("open it")
                    .trim()
                val ok = selectPrimaryVisibleItem(targetHint)
                res.put("handled", true)
                res.put("action", "select_item")
                res.put("ok", ok)
            }
            lower.contains("proceed") || lower.contains("continue") || lower == "next" ||
            lower.contains("checkout") || lower.contains("buy now") || lower.contains("add to cart") ||
            lower.contains("munduku") || raw.contains("ముందుకు") || raw.contains("కొనసాగించు") -> {
                val ok = proceedOnScreen()
                res.put("handled", true)
                res.put("action", "proceed")
                res.put("ok", ok)
            }
            lower.startsWith("search for ") || lower.startsWith("search ") ||
            lower.startsWith("vethuku ") || raw.startsWith("వెతుకు") -> {
                val q = raw.replace(Regex("^(search for|search|vethuku|వెతుకు)\\s*", RegexOption.IGNORE_CASE), "").trim()
                val ok = if (q.isNotEmpty()) performInAppSearch(q) else clickByText("Search", false)
                res.put("handled", true)
                res.put("action", "search")
                res.put("query", q)
                res.put("ok", ok)
            }
            lower.startsWith("click ") || lower.startsWith("tap ") || lower.startsWith("press ") -> {
                val target = raw.replace(Regex("^(click|tap|press)\\s+", RegexOption.IGNORE_CASE), "").trim()
                narrateStep("Clicking \$target", "\$target నొక్కుతున్నాను")
                val ok = clickByText(target, false)
                res.put("handled", true)
                res.put("action", "click_text")
                res.put("target", target)
                res.put("ok", ok)
            }
            lower == "go back" || lower == "back" || lower.contains("venakki") || raw.contains("వెనక్కి") -> {
                narrateStep("Going back", "వెనక్కి వెళ్తున్నాను")
                val ok = performGlobal("back")
                res.put("handled", true)
                res.put("action", "back")
                res.put("ok", ok)
            }
            lower == "go home" || lower == "home screen" || raw.contains("హోమ్") -> {
                narrateStep("Going to home screen", "హోమ్ స్క్రీన్ కు వెళ్తున్నాను")
                val ok = performGlobal("home")
                res.put("handled", true)
                res.put("action", "home")
                res.put("ok", ok)
            }
            lower.contains("read screen") || lower.contains("what is on screen") || raw.contains("స్క్రీన్ చదువు") -> {
                val summaryJson = JSONObject(dumpScreenSummary())
                val arr = summaryJson.optJSONArray("texts")
                val topItems = mutableListOf<String>()
                if (arr != null) {
                    for (i in 0 until minOf(6, arr.length())) {
                        topItems.add(arr.optString(i))
                    }
                }
                val readText = if (topItems.isEmpty()) "Screen appears empty" else "On screen: " + topItems.joinToString(", ")
                narrateStep(readText, "స్క్రీన్ పైన ఉన్నవి: " + topItems.joinToString(", "))
                res.put("handled", true)
                res.put("action", "read_screen")
                res.put("ok", true)
            }
            else -> {
                res.put("handled", false)
            }
        }
        return res
    }

    fun captureScreenshotBase64(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return ""
        val latch = CountDownLatch(1)
        var encoded = ""
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(screenshotResult: ScreenshotResult) {
                    try {
                        val hwBuffer = screenshotResult.hardwareBuffer
                        val colorSpace = screenshotResult.colorSpace
                        val bmp = Bitmap.wrapHardwareBuffer(hwBuffer, colorSpace)
                        if (bmp != null) {
                            val softBmp = bmp.copy(Bitmap.Config.ARGB_8888, false)
                            val scaled = Bitmap.createScaledBitmap(
                                softBmp,
                                (softBmp.width * 0.45).toInt().coerceAtLeast(320),
                                (softBmp.height * 0.45).toInt().coerceAtLeast(560),
                                true
                            )
                            val baos = ByteArrayOutputStream()
                            scaled.compress(Bitmap.CompressFormat.JPEG, 68, baos)
                            encoded = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
                            scaled.recycle()
                            softBmp.recycle()
                            bmp.recycle()
                        }
                        hwBuffer.close()
                    } catch (_: Exception) {}
                    latch.countDown()
                }
                override fun onFailure(errorCode: Int) {
                    latch.countDown()
                }
            })
            latch.await(2200, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {}
        return encoded
    }

    fun runAutonomousAppWorkflow(
        appName: String,
        searchQuery: String,
        targetAction: String,
        autoProceed: Boolean
    ) {
        Thread {
            try {
                narrateStep(
                    "Opening \$appName and starting your work",
                    "\$appName ఓపెన్ చేసి మీ పని ప్రారంభిస్తున్నాను"
                )
                Thread.sleep(2400)

                if (searchQuery.isNotBlank()) {
                    performInAppSearch(searchQuery)
                    Thread.sleep(2200)
                }

                if (targetAction.isNotBlank()) {
                    val clickedSpecific = clickByText(targetAction, false)
                    if (!clickedSpecific) {
                        selectPrimaryVisibleItem(searchQuery)
                    }
                    Thread.sleep(1600)
                } else if (searchQuery.isNotBlank()) {
                    selectPrimaryVisibleItem(searchQuery)
                    Thread.sleep(1600)
                }

                if (autoProceed) {
                    proceedOnScreen()
                }
                narrateStep(
                    "Completed task in \$appName",
                    "\$appName లో పని పూర్తయింది"
                )
            } catch (e: Exception) {
                logStep("Workflow error: \${e.message}")
            }
        }.start()
    }
}
`;

const HARK_BRIDGE_MODULE_KT = `package __PACKAGE__

import android.Manifest
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
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.Locale

class HarkBridgeModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), TextToSpeech.OnInitListener {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var ttsInitialized = false
    private var speechRecognizer: SpeechRecognizer? = null
    private var continuousHandsFree = false
    private var autoExecuteVoiceCommands = true
    private var currentVoiceLang = "te-IN"
    private var isCurrentlySpeaking = false

    init {
        mainHandler.post {
            try {
                tts = TextToSpeech(reactContext.applicationContext, this)
            } catch (_: Exception) {}
        }
    }

    override fun getName(): String = "HarkBridge"

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            ttsInitialized = true
            try {
                val te = Locale.forLanguageTag("te-IN")
                val avail = tts?.isLanguageAvailable(te) ?: TextToSpeech.LANG_NOT_SUPPORTED
                if (avail >= TextToSpeech.LANG_AVAILABLE) {
                    tts?.language = te
                } else {
                    tts?.language = Locale.forLanguageTag("en-IN")
                }
                tts?.setPitch(1.02f)
                tts?.setSpeechRate(0.97f)
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {
                        isCurrentlySpeaking = true
                    }
                    override fun onDone(utteranceId: String?) {
                        isCurrentlySpeaking = false
                    }
                    override fun onError(utteranceId: String?) {
                        isCurrentlySpeaking = false
                    }
                })
            } catch (_: Exception) {}
        }
    }

    private fun emitEvent(eventName: String, params: WritableMap) {
        try {
            if (reactContext.hasActiveCatalystInstance()) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit(eventName, params)
            }
        } catch (_: Exception) {}
    }

    private fun hasTeluguChars(text: String): Boolean {
        for (c in text) {
            if (c.code in 0x0C00..0x0C7F) return true
        }
        return false
    }

    @ReactMethod
    fun isAccessibilityEnabled(promise: Promise) {
        try {
            val serviceLive = HarkAccessibilityService.instance != null
            val enabledServices = Settings.Secure.getString(
                reactContext.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            ) ?: ""
            val inSettings = enabledServices.contains(reactContext.packageName, ignoreCase = true)
            promise.resolve(serviceLive || inSettings)
        } catch (e: Exception) {
            promise.resolve(false)
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
    fun canDrawOverlays(promise: Promise) {
        try {
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Settings.canDrawOverlays(reactContext)
            } else true
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun requestOverlayPermission(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:\${reactContext.packageName}")
                ).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(intent)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun setNarrationConfig(enabled: Boolean, lang: String, promise: Promise) {
        HarkAccessibilityService.voiceNarrationEnabled = enabled
        HarkAccessibilityService.preferredVoiceLang = lang.ifBlank { "te-IN" }
        currentVoiceLang = lang.ifBlank { "te-IN" }
        promise.resolve(true)
    }

    @ReactMethod
    fun speak(text: String, lang: String, rate: Double, pitch: Double, queueMode: Boolean, promise: Promise) {
        mainHandler.post {
            try {
                if (!ttsInitialized || tts == null) {
                    promise.resolve(false)
                    return@post
                }
                val clean = text.replace(Regex("[#*_\`~]+"), " ").trim()
                if (clean.isEmpty()) {
                    promise.resolve(false)
                    return@post
                }
                val useTe = hasTeluguChars(clean) || lang.startsWith("te", ignoreCase = true)
                val targetLocale = if (useTe) Locale.forLanguageTag("te-IN") else Locale.forLanguageTag("en-IN")
                val avail = tts?.isLanguageAvailable(targetLocale) ?: TextToSpeech.LANG_NOT_SUPPORTED
                if (avail >= TextToSpeech.LANG_AVAILABLE) {
                    tts?.language = targetLocale
                } else {
                    tts?.language = Locale.forLanguageTag("en-IN")
                }
                tts?.setSpeechRate(rate.toFloat().coerceIn(0.6f, 1.6f))
                tts?.setPitch(pitch.toFloat().coerceIn(0.7f, 1.4f))
                val qMode = if (queueMode) TextToSpeech.QUEUE_ADD else TextToSpeech.QUEUE_FLUSH
                tts?.speak(clean, qMode, null, "hark_utt_\${System.currentTimeMillis()}")
                promise.resolve(true)
            } catch (e: Exception) {
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun stopSpeaking(promise: Promise) {
        mainHandler.post {
            try {
                tts?.stop()
                isCurrentlySpeaking = false
                promise.resolve(true)
            } catch (_: Exception) {
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun startVoiceRecognition(
        lang: String,
        handsFreeLoop: Boolean,
        autoExecuteOS: Boolean,
        promise: Promise
    ) {
        currentVoiceLang = lang.ifBlank { "te-IN" }
        continuousHandsFree = handsFreeLoop
        autoExecuteVoiceCommands = autoExecuteOS

        val perm = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO)
        if (perm != PackageManager.PERMISSION_GRANTED) {
            currentActivity?.let { act ->
                ActivityCompat.requestPermissions(act, arrayOf(Manifest.permission.RECORD_AUDIO), 701)
            }
            promise.resolve(false)
            return
        }

        mainHandler.post {
            try {
                startListeningInternal()
                promise.resolve(true)
            } catch (e: Exception) {
                promise.resolve(false)
            }
        }
    }

    private fun startListeningInternal() {
        try {
            if (speechRecognizer == null) {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(reactContext.applicationContext)
                speechRecognizer?.setRecognitionListener(object : RecognitionListener {
                    override fun onReadyForSpeech(params: Bundle?) {
                        val map = Arguments.createMap()
                        map.putString("status", "listening")
                        map.putBoolean("handsFree", continuousHandsFree)
                        emitEvent("HarkVoiceStatus", map)
                    }
                    override fun onBeginningOfSpeech() {}
                    override fun onRmsChanged(rmsdB: Float) {}
                    override fun onBufferReceived(buffer: ByteArray?) {}
                    override fun onEndOfSpeech() {}
                    override fun onError(error: Int) {
                        val map = Arguments.createMap()
                        map.putString("status", "idle")
                        map.putInt("errorCode", error)
                        emitEvent("HarkVoiceStatus", map)
                        if (continuousHandsFree) {
                            mainHandler.postDelayed({
                                if (continuousHandsFree) startListeningInternal()
                            }, 950L)
                        }
                    }
                    override fun onResults(results: Bundle?) {
                        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val best = matches?.firstOrNull()?.trim() ?: ""
                        if (best.isNotEmpty()) {
                            var handledDirectly = false
                            var actionType = ""
                            if (autoExecuteVoiceCommands) {
                                val svc = HarkAccessibilityService.instance
                                if (svc != null) {
                                    val actionRes = svc.executeHandsFreeVoiceAction(best)
                                    handledDirectly = actionRes.optBoolean("handled", false)
                                    actionType = actionRes.optString("action", "")
                                }
                            }
                            val map = Arguments.createMap()
                            map.putString("transcript", best)
                            map.putBoolean("handledByOS", handledDirectly)
                            map.putString("osAction", actionType)
                            map.putBoolean("handsFree", continuousHandsFree)
                            emitEvent("HarkVoiceResult", map)
                        }
                        if (continuousHandsFree) {
                            mainHandler.postDelayed({
                                if (continuousHandsFree) startListeningInternal()
                            }, 850L)
                        }
                    }
                    override fun onPartialResults(partialResults: Bundle?) {
                        val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        val part = matches?.firstOrNull()?.trim() ?: ""
                        if (part.isNotEmpty()) {
                            val map = Arguments.createMap()
                            map.putString("partial", part)
                            emitEvent("HarkVoicePartial", map)
                        }
                    }
                    override fun onEvent(eventType: Int, params: Bundle?) {}
                })
            }

            val recIntent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, currentVoiceLang)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            }
            speechRecognizer?.startListening(recIntent)
        } catch (_: Exception) {}
    }

    @ReactMethod
    fun stopVoiceRecognition(promise: Promise) {
        continuousHandsFree = false
        mainHandler.post {
            try {
                speechRecognizer?.stopListening()
                speechRecognizer?.cancel()
                val map = Arguments.createMap()
                map.putString("status", "stopped")
                map.putBoolean("handsFree", false)
                emitEvent("HarkVoiceStatus", map)
                promise.resolve(true)
            } catch (_: Exception) {
                promise.resolve(false)
            }
        }
    }

    @ReactMethod
    fun executeVoiceCommand(spokenText: String, promise: Promise) {
        Thread {
            try {
                val svc = HarkAccessibilityService.instance
                if (svc == null) {
                    val out = JSONObject()
                    out.put("handled", false)
                    out.put("error", "Accessibility Service not enabled")
                    promise.resolve(out.toString())
                    return@Thread
                }
                val res = svc.executeHandsFreeVoiceAction(spokenText)
                promise.resolve(res.toString())
            } catch (e: Exception) {
                promise.resolve("{\\"handled\\":false}")
            }
        }.start()
    }

    @ReactMethod
    fun dumpScreenSummary(promise: Promise) {
        Thread {
            try {
                val svc = HarkAccessibilityService.instance
                if (svc == null) {
                    promise.resolve("{\\"error\\":\\"Accessibility Service disabled\\",\\"texts\\":[],\\"clickables\\":[],\\"editables\\":[]}")
                } else {
                    promise.resolve(svc.dumpScreenSummary())
                }
            } catch (e: Exception) {
                promise.resolve("{\\"error\\":\\"\${e.message}\\"}")
            }
        }.start()
    }

    @ReactMethod
    fun getScreenContent(promise: Promise) {
        dumpScreenSummary(promise)
    }

    @ReactMethod
    fun getStepLogs(promise: Promise) {
        try {
            val arr = JSONArray()
            for (item in HarkAccessibilityService.stepLogs) {
                arr.put(item)
            }
            promise.resolve(arr.toString())
        } catch (_: Exception) {
            promise.resolve("[]")
        }
    }

    @ReactMethod
    fun clearStepLogs(promise: Promise) {
        HarkAccessibilityService.stepLogs.clear()
        promise.resolve(true)
    }

    @ReactMethod
    fun captureScreenBase64(promise: Promise) {
        Thread {
            try {
                val svc = HarkAccessibilityService.instance
                if (svc == null) {
                    promise.resolve("")
                } else {
                    promise.resolve(svc.captureScreenshotBase64())
                }
            } catch (_: Exception) {
                promise.resolve("")
            }
        }.start()
    }

    @ReactMethod
    fun clickByText(text: String, exact: Boolean, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.clickByText(text, exact) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun clickByViewId(viewId: String, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.clickByViewId(viewId) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun selectBestVisibleNode(hintText: String, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.selectPrimaryVisibleItem(hintText) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun proceedAction(promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.proceedOnScreen() ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun performInAppSearch(query: String, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.performInAppSearch(query) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun tap(x: Double, y: Double, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.tap(x, y) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun longPress(x: Double, y: Double, durationMs: Double, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.longPress(x, y, durationMs.toLong()) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun swipe(x1: Double, y1: Double, x2: Double, y2: Double, durationMs: Double, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.swipe(x1, y1, x2, y2, durationMs.toLong()) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun scroll(direction: String, promise: Promise) {
        Thread {
            val svc = HarkAccessibilityService.instance
            if (svc != null) {
                svc.narrateStep("Scrolling \$direction", "\$direction స్క్రోల్ చేస్తున్నాను")
                promise.resolve(svc.scrollScreen(direction))
            } else {
                promise.resolve(false)
            }
        }.start()
    }

    @ReactMethod
    fun typeText(text: String, submit: Boolean, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.typeText(text, submit) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun performGlobal(action: String, promise: Promise) {
        Thread {
            val ok = HarkAccessibilityService.instance?.performGlobal(action) ?: false
            promise.resolve(ok)
        }.start()
    }

    @ReactMethod
    fun getInstalledApps(promise: Promise) {
        Thread {
            try {
                val pm = reactContext.packageManager
                val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
                    addCategory(Intent.CATEGORY_LAUNCHER)
                }
                val resolved = pm.queryIntentActivities(mainIntent, 0)
                val arr = JSONArray()
                val seen = HashSet<String>()
                for (info in resolved) {
                    val pkg = info.activityInfo?.packageName ?: continue
                    if (seen.add(pkg)) {
                        val label = info.loadLabel(pm)?.toString() ?: pkg
                        val item = JSONObject()
                        item.put("packageName", pkg)
                        item.put("label", label)
                        arr.put(item)
                    }
                }
                promise.resolve(arr.toString())
            } catch (e: Exception) {
                promise.resolve("[]")
            }
        }.start()
    }

    private fun resolveAppPackage(nameOrPkg: String): Pair<String, String>? {
        val clean = nameOrPkg.trim()
        val pm = reactContext.packageManager
        try {
            val direct = pm.getLaunchIntentForPackage(clean)
            if (direct != null) return Pair(clean, clean.substringAfterLast("."))
        } catch (_: Exception) {}

        val knownMap = mapOf(
            "youtube" to "com.google.android.youtube",
            "whatsapp" to "com.whatsapp",
            "instagram" to "com.instagram.android",
            "chrome" to "com.android.chrome",
            "maps" to "com.google.android.apps.maps",
            "gmail" to "com.google.android.gm",
            "spotify" to "com.spotify.music",
            "flipkart" to "com.flipkart.android",
            "amazon" to "in.amazon.mShop.android.shopping",
            "meesho" to "com.meesho.supply",
            "blinkit" to "com.grofers.customerapp",
            "zepto" to "com.zeptoconsumerapp",
            "swiggy" to "in.swiggy.android",
            "zomato" to "com.application.zomato",
            "uber" to "com.ubercab",
            "ola" to "com.olacabs.customer",
            "rapido" to "com.rapido.passenger",
            "phonepe" to "com.phonepe.app",
            "gpay" to "com.google.android.apps.nbu.paisa.user",
            "paytm" to "net.one97.paytm",
            "telegram" to "org.telegram.messenger"
        )
        val lower = clean.lowercase(Locale.US)
        for ((k, pkg) in knownMap) {
            if (lower.contains(k)) {
                val launch = pm.getLaunchIntentForPackage(pkg)
                if (launch != null) return Pair(pkg, k.replaceFirstChar { it.uppercase() })
            }
        }

        val mainIntent = Intent(Intent.ACTION_MAIN, null).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }
        val list = pm.queryIntentActivities(mainIntent, 0)
        for (info in list) {
            val pkg = info.activityInfo?.packageName ?: continue
            val label = info.loadLabel(pm)?.toString() ?: ""
            if (label.equals(clean, ignoreCase = true) ||
                label.contains(clean, ignoreCase = true) ||
                pkg.contains(clean, ignoreCase = true)
            ) {
                return Pair(pkg, label)
            }
        }
        return null
    }

    @ReactMethod
    fun launchApp(packageOrName: String, promise: Promise) {
        try {
            val resolved = resolveAppPackage(packageOrName)
            if (resolved != null) {
                val intent = reactContext.packageManager.getLaunchIntentForPackage(resolved.first)
                if (intent != null) {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                    reactContext.startActivity(intent)
                    HarkAccessibilityService.logStep("Launched app \${resolved.second} (\${resolved.first})")
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
    fun runAppWorkflow(
        appNameOrPkg: String,
        searchQuery: String,
        targetClick: String,
        autoProceed: Boolean,
        promise: Promise
    ) {
        try {
            val resolved = resolveAppPackage(appNameOrPkg)
            val pm = reactContext.packageManager
            if (resolved != null) {
                val intent = pm.getLaunchIntentForPackage(resolved.first)
                if (intent != null) {
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                    reactContext.startActivity(intent)
                    val svc = HarkAccessibilityService.instance
                    if (svc != null && (searchQuery.isNotBlank() || targetClick.isNotBlank() || autoProceed)) {
                        svc.runAutonomousAppWorkflow(resolved.second, searchQuery, targetClick, autoProceed)
                    }
                    promise.resolve(true)
                    return
                }
            }
            if (appNameOrPkg.lowercase(Locale.US).contains("youtube") && searchQuery.isNotBlank()) {
                val webUri = Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(searchQuery))
                val viewIntent = Intent(Intent.ACTION_VIEW, webUri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                reactContext.startActivity(viewIntent)
                promise.resolve(true)
                return
            }
            promise.resolve(false)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openUrl(url: String, promise: Promise) {
        try {
            val finalUrl = if (url.startsWith("http://") || url.startsWith("https://")) url else "https://\$url"
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(finalUrl)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun openSystemSettings(panel: String, promise: Promise) {
        try {
            val action = when (panel.lowercase(Locale.US).trim()) {
                "wifi" -> Settings.ACTION_WIFI_SETTINGS
                "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
                "display" -> Settings.ACTION_DISPLAY_SETTINGS
                "sound" -> Settings.ACTION_SOUND_SETTINGS
                "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
                "battery" -> Settings.ACTION_BATTERY_SAVER_SETTINGS
                else -> Settings.ACTION_SETTINGS
            }
            val intent = Intent(action).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun dialNumber(phone: String, directCall: Boolean, promise: Promise) {
        try {
            val clean = phone.replace(Regex("[^0-9+]"), "")
            val action = if (directCall && ContextCompat.checkSelfPermission(reactContext, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) {
                Intent.ACTION_CALL
            } else {
                Intent.ACTION_DIAL
            }
            val intent = Intent(action, Uri.parse("tel:\$clean")).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun sendSmsIntent(phone: String, body: String, promise: Promise) {
        try {
            val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:\$phone")).apply {
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
    fun shareText(text: String, title: String, promise: Promise) {
        try {
            val sendIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TITLE, title)
                putExtra(Intent.EXTRA_TEXT, text)
            }
            val chooser = Intent.createChooser(sendIntent, title.ifBlank { "Share via Hark Pro" }).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(chooser)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getDeviceStatus(promise: Promise) {
        try {
            val bm = reactContext.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            val battery = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val charging = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) bm.isCharging else false
            val am = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val curVol = am.getStreamVolume(AudioManager.STREAM_MUSIC)
            val maxVol = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
            val volPct = ((curVol.toDouble() / maxVol.toDouble()) * 100.0).toInt()

            val obj = JSONObject()
            obj.put("battery", battery)
            obj.put("charging", charging)
            obj.put("volumePercent", volPct)
            obj.put("accessibilityConnected", HarkAccessibilityService.instance != null)
            obj.put("voiceNarrationEnabled", HarkAccessibilityService.voiceNarrationEnabled)
            obj.put("preferredVoiceLang", HarkAccessibilityService.preferredVoiceLang)
            obj.put("handsFreeActive", continuousHandsFree)
            obj.put("deviceModel", "\${Build.MANUFACTURER} \${Build.MODEL}")
            obj.put("androidVersion", Build.VERSION.RELEASE)
            promise.resolve(obj.toString())
        } catch (e: Exception) {
            promise.resolve("{}")
        }
    }

    @ReactMethod
    fun setVolume(levelPercent: Double, promise: Promise) {
        try {
            val am = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val maxVol = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            val target = ((levelPercent.coerceIn(0.0, 100.0) / 100.0) * maxVol).toInt()
            am.setStreamVolume(AudioManager.STREAM_MUSIC, target, AudioManager.FLAG_SHOW_UI)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun toggleTorch(enabled: Boolean, promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val cm = reactContext.getSystemService(Context.CAMERA_SERVICE) as CameraManager
                val camId = cm.cameraIdList.firstOrNull()
                if (camId != null) {
                    cm.setTorchMode(camId, enabled)
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
    fun vibrate(durationMs: Double, promise: Promise) {
        try {
            val vib = reactContext.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            val ms = durationMs.toLong().coerceIn(20L, 2000L)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vib.vibrate(ms)
            }
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun copyToClipboard(text: String, promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("hark_clip", text))
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getClipboardText(promise: Promise) {
        try {
            val cm = reactContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val txt = cm.primaryClip?.getItemAt(0)?.coerceToText(reactContext)?.toString() ?: ""
            promise.resolve(txt)
        } catch (e: Exception) {
            promise.resolve("")
        }
    }

    @ReactMethod
    fun saveVaultData(jsonStr: String, promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("hark_omni_vault", Context.MODE_PRIVATE)
            prefs.edit().putString("vault_json", jsonStr).apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun getVaultData(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences("hark_omni_vault", Context.MODE_PRIVATE)
            promise.resolve(prefs.getString("vault_json", "{}") ?: "{}")
        } catch (e: Exception) {
            promise.resolve("{}")
        }
    }

    @ReactMethod
    fun generateNativePdf(
        title: String,
        subtitle: String,
        bodyText: String,
        ShareImmediately: Boolean,
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
                    typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL)
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
                val accentPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.rgb(99, 102, 241)
                    style = Paint.Style.FILL
                }

                val lines = mutableListOf<Pair<String, Boolean>>()
                val rawParagraphs = bodyText.replace("\\r\\n", "\\n").split("\\n")
                for (rawPara in rawParagraphs) {
                    val trimmed = rawPara.trim()
                    if (trimmed.isEmpty()) {
                        lines.add(Pair("", false))
                        continue
                    }
                    val isHeading = trimmed.startsWith("#") || (trimmed.endsWith(":") && trimmed.length < 65)
                    val cleanPara = trimmed.replace(Regex("^#+\\s*"), "").replace("**", "")
                    val paintToMeasure = if (isHeading) headPaint else bodyPaint
                    val words = cleanPara.split(" ")
                    var currentLine = ""
                    for (w in words) {
                        val test = if (currentLine.isEmpty()) w else "\$currentLine \$w"
                        if (paintToMeasure.measureText(test) <= contentWidth) {
                            currentLine = test
                        } else {
                            if (currentLine.isNotEmpty()) lines.add(Pair(currentLine, isHeading))
                            currentLine = w
                        }
                    }
                    if (currentLine.isNotEmpty()) {
                        lines.add(Pair(currentLine, isHeading))
                    }
                }

                var pageNumber = 1
                var pageInfo = PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create()
                var page = pdfDoc.startPage(pageInfo)
                var canvas: Canvas = page.canvas
                var y = margin + 18f

                canvas.drawRect(margin, margin - 10f, pageWidth - margin, margin - 6f, accentPaint)
                canvas.drawText(title.take(56), margin, y + 8f, titlePaint)
                y += 28f
                val subLine = if (subtitle.isNotBlank()) subtitle else "Generated by Hark Pro 5.0 OmniCore PDF Engine"
                canvas.drawText(subLine.take(80), margin, y, subPaint)
                y += 24f

                for ((lineText, isHead) in lines) {
                    if (y > pageHeight - 58f) {
                        canvas.drawText("Hark Pro 5.0 OmniCore  •  Page \$pageNumber", margin, pageHeight - 24f, footerPaint)
                        pdfDoc.finishPage(page)
                        pageNumber++
                        pageInfo = PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create()
                        page = pdfDoc.startPage(pageInfo)
                        canvas = page.canvas
                        y = margin + 16f
                    }
                    if (lineText.isEmpty()) {
                        y += 9f
                    } else if (isHead) {
                        y += 6f
                        canvas.drawText(lineText, margin, y, headPaint)
                        y += 18f
                    } else {
                        canvas.drawText(lineText, margin, y, bodyPaint)
                        y += 16f
                    }
                }

                canvas.drawText("Hark Pro 5.0 OmniCore  •  Page \$pageNumber", margin, pageHeight - 24f, footerPaint)
                pdfDoc.finishPage(page)

                val outDir = reactContext.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: reactContext.cacheDir
                if (!outDir.exists()) outDir.mkdirs()
                val safeSlug = title.replace(Regex("[^a-zA-Z0-9_-]"), "_").take(32).ifBlank { "hark_document" }
                val outFile = File(outDir, "\${safeSlug}_\${System.currentTimeMillis()}.pdf")
                FileOutputStream(outFile).use { fos ->
                    pdfDoc.writeTo(fos)
                }
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
                err.put("error", e.message ?: "PDF generation failed")
                promise.resolve(err.toString())
            }
        }.start()
    }
}
`;

const HARK_PACKAGE_KT = `package __PACKAGE__

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class HarkBridgePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(HarkBridgeModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

module.exports = function withHarkNativeOS(config) {
  config = withGradleProperties(config, (mod) => {
    const props = mod.modResults || [];
    const setProp = (key, value) => {
      const idx = props.findIndex((p) => p.type === 'property' && p.key === key);
      if (idx >= 0) {
        props[idx].value = value;
      } else {
        props.push({ type: 'property', key, value });
      }
    };
    setProp('org.gradle.jvmargs', '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8');
    setProp('org.gradle.parallel', 'true');
    setProp('newArchEnabled', 'false');
    mod.modResults = props;
    return mod;
  });

  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    if (!manifest['uses-permission']) {
      manifest['uses-permission'] = [];
    }
    const neededPerms = [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.CAMERA',
      'android.permission.VIBRATE',
      'android.permission.WAKE_LOCK',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.QUERY_ALL_PACKAGES',
      'android.permission.CALL_PHONE',
    ];
    for (const perm of neededPerms) {
      const exists = manifest['uses-permission'].some(
        (p) => p.$ && p.$['android:name'] === perm
      );
      if (!exists) {
        manifest['uses-permission'].push({ $: { 'android:name': perm } });
      }
    }

    manifest.queries = [
      {
        intent: [
          {
            action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
            category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
          },
          {
            action: [{ $: { 'android:name': 'android.speech.RecognitionService' } }],
          },
          {
            action: [{ $: { 'android:name': 'android.intent.action.TTS_SERVICE' } }],
          },
          {
            action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
            data: [{ $: { 'android:scheme': 'https' } }],
          },
        ],
      },
    ];

    const app = manifest.application && manifest.application[0];
    if (app) {
      if (!app.service) app.service = [];
      const hasAcc = app.service.some(
        (s) => s.$ && s.$['android:name'] === '.HarkAccessibilityService'
      );
      if (!hasAcc) {
        app.service.push({
          $: {
            'android:name': '.HarkAccessibilityService',
            'android:permission': 'android.permission.BIND_ACCESSIBILITY_SERVICE',
            'android:label': 'Hark Pro OmniCore Assistive Bridge',
            'android:exported': 'false',
          },
          'intent-filter': [
            {
              action: [
                { $: { 'android:name': 'android.accessibilityservice.AccessibilityService' } },
              ],
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
    }
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    let contents = mod.modResults.contents;
    const pkg = mod.android?.package || 'com.ismartanji.harkos';
    const importLine = `import ${pkg}.HarkBridgePackage`;
    if (!contents.includes(importLine)) {
      contents = contents.replace(/(package\s+[\w.]+\s*\n)/, `$1\n${importLine}\n`);
    }
    if (!contents.includes('HarkBridgePackage()')) {
      if (contents.includes('PackageList(this).packages.apply {')) {
        contents = contents.replace(
          'PackageList(this).packages.apply {',
          'PackageList(this).packages.apply {\n              add(HarkBridgePackage())'
        );
      } else if (contents.includes('PackageList(this).packages')) {
        contents = contents.replace(
          'PackageList(this).packages',
          'PackageList(this).packages.apply { add(HarkBridgePackage()) }'
        );
      }
    }
    mod.modResults.contents = contents;
    return mod;
  });

  config = withDangerousMod(config, [
    'android',
    async (mod) => {
      const projectRoot = mod.modRequest.projectRoot;
      const androidRoot = path.join(projectRoot, 'android');
      const pkg = mod.android?.package || 'com.ismartanji.harkos';
      const pkgRel = pkg.replace(/\./g, '/');
      const javaDir = path.join(androidRoot, 'app', 'src', 'main', 'java', pkgRel);
      ensureDir(javaDir);

      fs.writeFileSync(
        path.join(javaDir, 'HarkAccessibilityService.kt'),
        HARK_ACCESSIBILITY_SERVICE_KT.replace(/__PACKAGE__/g, pkg),
        'utf8'
      );
      fs.writeFileSync(
        path.join(javaDir, 'HarkBridgeModule.kt'),
        HARK_BRIDGE_MODULE_KT.replace(/__PACKAGE__/g, pkg),
        'utf8'
      );
      fs.writeFileSync(
        path.join(javaDir, 'HarkBridgePackage.kt'),
        HARK_PACKAGE_KT.replace(/__PACKAGE__/g, pkg),
        'utf8'
      );

      const xmlDir = path.join(androidRoot, 'app', 'src', 'main', 'res', 'xml');
      ensureDir(xmlDir);
      fs.writeFileSync(path.join(xmlDir, 'hark_accessibility_config.xml'), ACCESSIBILITY_XML, 'utf8');

      const valuesDir = path.join(androidRoot, 'app', 'src', 'main', 'res', 'values');
      ensureDir(valuesDir);
      const stringsPath = path.join(valuesDir, 'strings.xml');
      if (fs.existsSync(stringsPath)) {
        let strXml = fs.readFileSync(stringsPath, 'utf8');
        if (!strXml.includes('hark_accessibility_desc')) {
          strXml = strXml.replace(
            '</resources>',
            '  <string name="hark_accessibility_desc">Hark Pro 5.0 OmniCore Hands-Free Voice &amp; Autonomous Screen Assistant</string>\n</resources>'
          );
          fs.writeFileSync(stringsPath, strXml, 'utf8');
        }
      }

      const wrapperPropPath = path.join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
      if (fs.existsSync(wrapperPropPath)) {
        let wp = fs.readFileSync(wrapperPropPath, 'utf8');
        wp = wp.replace(/-all\.zip/g, '-bin.zip');
        if (wp.includes('networkTimeout=')) {
          wp = wp.replace(/networkTimeout=\d+/g, 'networkTimeout=120000');
        } else {
          wp += '\nnetworkTimeout=120000\n';
        }
        fs.writeFileSync(wrapperPropPath, wp, 'utf8');
      }

      return mod;
    },
  ]);

  return config;
};
