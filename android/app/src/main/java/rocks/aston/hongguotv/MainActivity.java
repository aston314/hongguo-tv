package rocks.aston.hongguotv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.AnimatedVectorDrawable;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.view.ViewTreeObserver;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Button;
import android.widget.ImageView;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private String coreUrl;
    private WebView webView;
    private Bitmap defaultVideoPoster;
    private NativePlayerAdapter playerBridge;
    private boolean backPending;
    private volatile boolean activityForeground;
    private volatile boolean playbackPageActive;
    private boolean playbackActive;
    private AlertDialog exitDialog;
    private boolean keyboardVisible;
    private final InputEditingState inputEditingState = new InputEditingState();
    private final SearchNavigationState searchNavigationState = new SearchNavigationState();
    private final SearchInputFocusPolicy searchInputFocusPolicy = new SearchInputFocusPolicy();
    private LinearLayout startupPanel;
    private TextView startupMessage;
    private Button startupRetry;
    private Thread startupThread;
    private volatile boolean destroyed;
    private boolean pageLoadFailed;
    private volatile boolean pageReady;
    private int routedVerticalKeys;
    private int routedHorizontalKeys;
    private int routedConfirmKeys;
    private AnimatedVectorDrawable startupAnimation;
    private AppUpdater appUpdater;
    private TvHomeChannelManager homeChannelManager;
    private String pendingHomeProgram;
    private volatile String diagnosticDeviceJSON = "{}";
    private final Runnable restoreFullscreen = () -> {
        if (activityForeground && hasWindowFocus() && !isFinishing() && !isDestroyed() && !inputEditingState.snapshot().isEditing() && !isKeyboardVisible()) {
            applyFullscreen();
        }
    };
    private final ViewTreeObserver.OnGlobalLayoutListener keyboardLayoutListener = () -> {
        boolean visible = isKeyboardVisible();
        if (keyboardVisible && !visible) {
            if (inputEditingState.snapshot().isSearchEditing()) completeSearchEditing(true);
            else completeAccountEditing();
            scheduleFullscreen();
        }
        keyboardVisible = visible;
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        JSONObject initialHomeProgram = TvHomeChannelManager.parseLaunchIntent(getIntent());
        pendingHomeProgram = initialHomeProgram == null ? null : initialHomeProgram.toString();
        homeChannelManager = new TvHomeChannelManager(this);
        homeChannelManager.ensureDefaultChannel(false);
        startCoreService();
        webView = new WebView(this) {
            @Override
            public boolean onKeyPreIme(int keyCode, KeyEvent event) {
                // Floating TV keyboards have no reliable resize/hide signal.
                // Finish explicitly before Back can be consumed by the IME.
                if (InputKeyPolicy.isBackKey(keyCode) && InputKeyPolicy.shouldDismissInputBack(inputEditingState.snapshot())) {
                    if (event.getAction() == KeyEvent.ACTION_DOWN) inputEditingState.beginBack();
                    if (event.getAction() == KeyEvent.ACTION_UP) {
                        InputEditingState.Snapshot editing = inputEditingState.snapshot();
                        inputEditingState.cancelBack();
                        if (editing.isAccountEditing()) completeAccountEditing();
                        else completeSearchEditing(true);
                    }
                    return true;
                }
                return super.onKeyPreIme(keyCode, event);
            }
        };
        // The native Media3 layer is placed behind the WebView and remains
        // hidden until the HTML video path explicitly requests a fallback.
        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        WebSettings settings = webView.getSettings();
        settings.setUserAgentString(settings.getUserAgentString() + " HongguoTV-Android");
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // Fetch UI assets from the core embedded in this APK after updates.
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        diagnosticDeviceJSON = DeviceDiagnostics.snapshot(this);
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface public String readDevice() {
                return pageReady && !destroyed ? diagnosticDeviceJSON : "{}";
            }
        }, "HongguoTVDiagnostics");
        webView.addJavascriptInterface(new PlaybackPreferences(this), "HongguoTVPreferences");
        webView.addJavascriptInterface(new InputBridge(), "HongguoTVInput");
        webView.addJavascriptInterface(new HomeChannelBridge(), "HongguoTVHome");
        appUpdater = new AppUpdater(this, new AppUpdater.Host() {
            public boolean trusted() { return pageReady; }
            public boolean foreground() { return activityForeground; }
            public void restoreFocus() { if (!destroyed && webView != null) { grantWebViewFocus(false); scheduleFullscreen(); } }
            public void allowPrompt(AppUpdater.PromptCheck check) {
                if (!pageReady || webView == null) { check.result(false); return; }
                webView.evaluateJavascript("!!(window.HongguoTV && window.HongguoTV.canShowAppUpdate())", result -> check.result("true".equals(result)));
            }
        });
        webView.addJavascriptInterface(appUpdater.new Bridge(), "HongguoTVUpdates");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                pageLoadFailed = false;
                pageReady = false;
                inputEditingState.reset();
                searchNavigationState.reset();
                routedVerticalKeys = 0;
                routedHorizontalKeys = 0;
                routedConfirmKeys = 0;
                searchInputFocusPolicy.reset();
                super.onPageStarted(view, url, favicon);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) { pageLoadFailed = true; showStartupFailure(); }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!pageLoadFailed && coreUrl != null && url.startsWith(coreUrl)) {
                    startupPanel.setVisibility(View.GONE);
                    startupAnimation.stop();
                    pageReady = true;
                    grantWebViewFocus(false);
                    appUpdater.start();
                    homeChannelManager.ensureDefaultChannel(true);
                }
                view.evaluateJavascript("window.HongguoTV && window.HongguoTV." +
                        (activityForeground ? "resumeFromBackground()" : "pauseForBackground()"), null);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public Bitmap getDefaultVideoPoster() {
                // Some system WebView builds take the poster from this callback
                // and call Bitmap.getWidth() without a null check. The page
                // creates its first <video> as soon as it loads, so a null
                // poster crashes the process right after launch. A transparent
                // 1x1 bitmap keeps that path safe and stays invisible.
                if (defaultVideoPoster == null) {
                    defaultVideoPoster = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
                    defaultVideoPoster.eraseColor(Color.TRANSPARENT);
                }
                return defaultVideoPoster;
            }
        });
        FrameLayout content = new FrameLayout(this);
        content.setBackgroundColor(Color.BLACK);
        FrameLayout nativeVideoLayer = new FrameLayout(this);
        content.addView(nativeVideoLayer, new FrameLayout.LayoutParams(-1, -1));
        content.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        playerBridge = PlayerFactory.create(webView, nativeVideoLayer);
        webView.addJavascriptInterface(playerBridge, "HongguoNativePlayer");
        startupPanel = new LinearLayout(this);
        startupPanel.setOrientation(LinearLayout.VERTICAL);
        startupPanel.setGravity(Gravity.CENTER);
        int startupInset = Math.round(24 * getResources().getDisplayMetrics().density);
        startupPanel.setPadding(startupInset, startupInset, startupInset, startupInset);
        startupPanel.setBackgroundColor(0xFF0C0D12);
        ImageView startupLogo = new ImageView(this);
        startupAnimation = (AnimatedVectorDrawable) getDrawable(R.drawable.startup_loading);
        startupLogo.setImageDrawable(startupAnimation);
        int logoSize = Math.round(72 * getResources().getDisplayMetrics().density);
        LinearLayout.LayoutParams logoLayout = new LinearLayout.LayoutParams(logoSize, logoSize);
        logoLayout.bottomMargin = Math.round(20 * getResources().getDisplayMetrics().density);
        startupPanel.addView(startupLogo, logoLayout);
        startupMessage = new TextView(this);
        startupMessage.setTextColor(Color.WHITE);
        startupMessage.setTextSize(22);
        startupMessage.setGravity(Gravity.CENTER);
        startupPanel.addView(startupMessage, new LinearLayout.LayoutParams(-2, -2));
        TextView versionLabel = new TextView(this);
        versionLabel.setText("版本 " + BuildConfig.VERSION_NAME);
        versionLabel.setTextColor(0xFFA9A9B3);
        versionLabel.setTextSize(14);
        versionLabel.setGravity(Gravity.CENTER);
        versionLabel.setPadding(0, 16, 0, 16);
        startupPanel.addView(versionLabel, new LinearLayout.LayoutParams(-2, -2));
        startupRetry = new Button(this);
        startupRetry.setText("重试");
        startupRetry.setOnClickListener(view -> { startCoreService(); waitForCore(); });
        startupPanel.addView(startupRetry, new LinearLayout.LayoutParams(-2, -2));
        content.addView(startupPanel, new FrameLayout.LayoutParams(-1, -1));
        setContentView(content);
        View decor = getWindow().getDecorView();
        decor.setOnSystemUiVisibilityChangeListener(visibility -> {
            // Android 6 WebView/IME can clear these flags after the initial launch.
            int hiddenBars = View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION;
            if ((visibility & hiddenBars) != hiddenBars) scheduleFullscreen();
        });
        decor.getViewTreeObserver().addOnGlobalLayoutListener(keyboardLayoutListener);
        applyFullscreen();
        grantWebViewFocus(false);
        waitForCore();
    }

    private void showStartupFailure() {
        if (destroyed) return;
        startupMessage.setText("本机服务连接失败，请重试");
        pageReady = false;
        startupAnimation.stop();
        startupRetry.setVisibility(View.VISIBLE);
        startupPanel.setVisibility(View.VISIBLE);
        startupRetry.requestFocus();
    }

    private void waitForCore() {
        if (startupThread != null && startupThread.isAlive()) return;
        startupMessage.setText("正在启动红果短剧…");
        startupRetry.setVisibility(View.GONE);
        startupPanel.setVisibility(View.VISIBLE);
        if (activityForeground) startupAnimation.start();
        startupThread = new Thread(() -> {
            long deadline = SystemClock.elapsedRealtime() + 30000;
            CoreEndpoint ready = null;
            String failure = "本机服务连接失败，请重试";
            while (!Thread.currentThread().isInterrupted() && SystemClock.elapsedRealtime() < deadline) {
                HttpURLConnection connection = null;
                CoreEndpoint candidate = CoreService.endpoint();
                String error = CoreService.startupError();
                if (error != null) { failure = error; break; }
                try {
                    if (candidate != null) {
                        connection = (HttpURLConnection) new URL(candidate.url + "api/v1/status").openConnection();
                        connection.setConnectTimeout(1000);
                        connection.setReadTimeout(1000);
                        connection.setUseCaches(false);
                        if (connection.getResponseCode() == 200) {
                            StringBuilder body = new StringBuilder();
                            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"))) {
                                String line;
                                while ((line = reader.readLine()) != null && body.length() < 8192) body.append(line);
                            }
                            JSONObject status = new JSONObject(body.toString());
                            if (status.optBoolean("ok") && candidate.matches(status.optString("service"),
                                    status.optString("instance_id"), status.optString("version"), BuildConfig.CORE_VERSION)
                                    && candidate == CoreService.endpoint()) ready = candidate;
                            else { failure = "本机服务版本不匹配，请重试"; break; }
                        }
                    }
                } catch (Exception ignored) {
                    // Retry only the local process; no external endpoints here.
                } finally {
                    if (connection != null) connection.disconnect();
                }
                if (ready != null) break;
                try { Thread.sleep(250); } catch (InterruptedException interrupted) { return; }
            }
            final CoreEndpoint coreReady = ready;
            final String failureMessage = failure;
            runOnUiThread(() -> {
                if (destroyed || isFinishing()) return;
                if (coreReady != null) {
                    if (coreReady != CoreService.endpoint()) { showStartupFailure(); return; }
                    coreUrl = coreReady.url;
                    webView.loadUrl(coreUrl);
                    grantWebViewFocus(false);
                } else { showStartupFailure(); startupMessage.setText(failureMessage); }
            });
        }, "hongguo-tv-startup");
        startupThread.start();
    }

    private void applyFullscreen() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        View decor = getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
        } else {
            // API 19+ immersive mode also works on our minimum version, Android 6 (API 23).
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN |
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    private void scheduleFullscreen() {
        View decor = getWindow().getDecorView();
        decor.removeCallbacks(restoreFullscreen);
        decor.post(restoreFullscreen);
    }

    private void syncKeepScreenOn() {
        if (playbackActive && activityForeground && !destroyed) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private void setKeepScreenOn(boolean active) {
        playbackActive = active;
        syncKeepScreenOn();
    }

    private void grantWebViewFocus(boolean repairingSearchInput) {
        if (destroyed || webView == null) return;
        if (!repairingSearchInput && (inputEditingState.snapshot().isEditing() || isKeyboardVisible())) return;
        webView.clearFocus();
        webView.requestFocus(View.FOCUS_DOWN);
    }

    private boolean isKeyboardVisible() {
        View decor = getWindow().getDecorView();
        Rect visibleFrame = new Rect();
        decor.getWindowVisibleDisplayFrame(visibleFrame);
        int height = decor.getRootView().getHeight();
        return height > 0 && height - visibleFrame.height() > height / 4;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && activityForeground && !inputEditingState.snapshot().isEditing() && !isKeyboardVisible()) {
            grantWebViewFocus(false);
            applyFullscreen();
        }
    }

    private void startCoreService() {
        CoreService.prepareStart();
        Intent intent = new Intent(this, CoreService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent);
        else startService(intent);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        JSONObject launch = TvHomeChannelManager.parseLaunchIntent(intent);
        if (launch == null) return;
        synchronized (this) { pendingHomeProgram = launch.toString(); }
        if (pageReady) dispatchPendingHomeProgram();
    }

    private String takePendingHomeProgram() {
        synchronized (this) {
            String launch = pendingHomeProgram;
            pendingHomeProgram = null;
            return launch;
        }
    }

    private void dispatchPendingHomeProgram() {
        if (!pageReady || destroyed || webView == null) return;
        String launch = takePendingHomeProgram();
        if (launch != null) webView.evaluateJavascript("!!(window.HongguoTV && window.HongguoTV.openHomeProgram(" + launch + "))", result -> {
            if (!"true".equals(result)) {
                synchronized (MainActivity.this) {
                    if (pendingHomeProgram == null && !destroyed) pendingHomeProgram = launch;
                }
            }
        });
    }

    public final class HomeChannelBridge {
        @JavascriptInterface
        public String consumeHomeProgram() {
            return destroyed ? "" : takePendingHomeProgram();
        }

        @JavascriptInterface
        public void syncRecommendations(String json) {
            if (!destroyed && homeChannelManager != null) homeChannelManager.syncRecommendations(json);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int verticalBit = event.getKeyCode() == KeyEvent.KEYCODE_DPAD_UP ? 1 : event.getKeyCode() == KeyEvent.KEYCODE_DPAD_DOWN ? 2 : 0;
        int horizontalBit = event.getKeyCode() == KeyEvent.KEYCODE_DPAD_LEFT ? 1 : event.getKeyCode() == KeyEvent.KEYCODE_DPAD_RIGHT ? 2 : 0;
        InputEditingState.Snapshot editing = inputEditingState.snapshot();
        boolean fallbackNavigation = searchNavigationState.routeFallbackNavigationKey(editing.isEditing());
        if (horizontalBit != 0) {
            if (event.getAction() == KeyEvent.ACTION_UP && (routedHorizontalKeys & horizontalBit) != 0) {
                routedHorizontalKeys &= ~horizontalBit;
                return true;
            }
            if (event.getAction() == KeyEvent.ACTION_DOWN && pageReady && webView != null && fallbackNavigation) {
                routedHorizontalKeys |= horizontalBit;
                webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.remoteKey(" + event.getKeyCode() + "," + (event.getRepeatCount() > 0) + ")", null);
                return true;
            }
        }
        if (verticalBit != 0) {
            if (event.getAction() == KeyEvent.ACTION_UP && (routedVerticalKeys & verticalBit) != 0) {
                routedVerticalKeys &= ~verticalBit;
                return true;
            }
            // Old WebView can consume vertical keys as input caret movement.
            // The account page uses an app-owned HTML numeric keypad, so use
            // the same JS router as browser keys after native editing ends.
            boolean pageFocus = webView != null && webView.hasFocus() ||
                    searchNavigationState.routeSearchKey(editing.isSearchEditing());
            if (event.getAction() == KeyEvent.ACTION_DOWN && pageReady && pageFocus &&
                    InputKeyPolicy.routeVerticalKey(editing.isAccountEditing(), isKeyboardVisible())) {
                routedVerticalKeys |= verticalBit;
                webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.remoteKey(" + event.getKeyCode() + "," + (event.getRepeatCount() > 0) + ")", null);
                return true;
            }
        }
        int confirmBit = searchConfirmKeyBit(event.getKeyCode());
        if (confirmBit != 0) {
            if (event.getAction() == KeyEvent.ACTION_UP && (routedConfirmKeys & confirmBit) != 0) {
                routedConfirmKeys &= ~confirmBit;
                return true;
            }
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && pageReady && webView != null && fallbackNavigation) {
                routedConfirmKeys |= confirmBit;
                webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.remoteKey(" + event.getKeyCode() + ",false)", null);
                return true;
            }
        }
        if (InputKeyPolicy.routePlaybackMenuKey(playbackPageActive, event.getKeyCode())) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && pageReady && webView != null) {
                webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.togglePlaybackCommandMenu()", null);
            }
            return true;
        }
        if (InputKeyPolicy.isBackKey(event.getKeyCode())) {
            if (InputKeyPolicy.shouldDismissInputBack(editing)) {
                if (event.getAction() == KeyEvent.ACTION_UP) {
                    if (editing.isAccountEditing()) completeAccountEditing();
                    else completeSearchEditing(true);
                }
                return true;
            }
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) requestPageBack();
            return true;
        }
        String command = mediaCommand(event.getKeyCode());
        if (command != null && webView != null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN &&
                    (event.getRepeatCount() == 0 || "forward".equals(command) || "rewind".equals(command))) {
                webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.mediaCommand('" + command + "')", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    private static int searchConfirmKeyBit(int keyCode) {
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER) return 1;
        if (keyCode == KeyEvent.KEYCODE_ENTER) return 2;
        if (keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER) return 4;
        return 0;
    }

    public final class InputBridge {
        @JavascriptInterface
        public void startAccountEditing() {
            runOnUiThread(() -> {
                if (destroyed || !pageReady || !activityForeground || webView == null) return;
                inputEditingState.beginAccount();
                routedVerticalKeys = 0;
                // Observe the original editable WebView field. Its natural
                // activation creates the numeric IME connection; do not
                // steal focus, restart that connection or force an IME open.
            });
        }

        @JavascriptInterface
        public void startSearchEditing() {
            requestSearchEditing(true);
        }

        @JavascriptInterface
        public void beginSearchEditing(boolean documentHasFocus) {
            requestSearchEditing(documentHasFocus);
        }

        @JavascriptInterface
        public void setRemoteNavigationTarget(boolean active) {
            if (destroyed) return;
            searchNavigationState.setRemoteNavigationTarget(active && pageReady && activityForeground);
        }

        @JavascriptInterface
        public void setPlaybackPageActive(boolean active) {
            if (destroyed) return;
            playbackPageActive = active;
        }

        @JavascriptInterface
        public void setPlaybackActive(boolean active) {
            runOnUiThread(() -> setKeepScreenOn(active));
        }

        @JavascriptInterface
        public void finishEditing() {
            boolean wasSearchEditing = inputEditingState.finishCurrent() == InputEditingState.Target.SEARCH;
            runOnUiThread(() -> {
                if (destroyed || webView == null) return;
                if (inputEditingState.snapshot().isEditing()) return;
                if (wasSearchEditing) searchInputFocusPolicy.onImeDismissed(SystemClock.uptimeMillis());
                else searchInputFocusPolicy.onEditingFinished();
                InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (keyboard != null) keyboard.hideSoftInputFromWindow(webView.getWindowToken(), 0);
                scheduleFullscreen();
            });
        }

        @JavascriptInterface
        public void finishSearchEditing() {
            runOnUiThread(() -> {
                if (destroyed || webView == null) return;
                completeSearchEditing(false);
            });
        }
    }

    private void requestSearchEditing(boolean documentHasFocus) {
        if (destroyed || !pageReady || !activityForeground || webView == null ||
                searchInputFocusPolicy.shouldIgnoreFocusRequest(SystemClock.uptimeMillis())) return;
        inputEditingState.beginSearch();
        searchNavigationState.arm();
        runOnUiThread(() -> beginSearchEditingOnUiThread(documentHasFocus));
    }

    private void beginSearchEditingOnUiThread(boolean documentHasFocus) {
        if (destroyed || !pageReady || !activityForeground || webView == null || !inputEditingState.snapshot().isSearchEditing()) return;
        searchNavigationState.arm();
        routedVerticalKeys = 0;
        if (searchInputFocusPolicy.shouldRepairRendererFocus(documentHasFocus)) {
            grantWebViewFocus(true);
        }
    }

    private void completeAccountEditing() {
        if (inputEditingState.finishAccount() != InputEditingState.Target.ACCOUNT) return;
        if (!destroyed && pageReady && webView != null) {
            webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.finishAccountEditing()", null);
        }
    }

    private void completeSearchEditing(boolean returnFocusToSearchActions) {
        boolean wasEditing = inputEditingState.finishSearch() == InputEditingState.Target.SEARCH;
        if (!wasEditing && inputEditingState.snapshot().isAccountEditing()) return;
        if (wasEditing) searchInputFocusPolicy.onImeDismissed(SystemClock.uptimeMillis());
        routedVerticalKeys = 0;
        InputMethodManager keyboard = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (keyboard != null && webView != null) keyboard.hideSoftInputFromWindow(webView.getWindowToken(), 0);
        if (returnFocusToSearchActions && wasEditing && pageReady && webView != null) {
            webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.finishSearchEditing()", null);
        }
        scheduleFullscreen();
    }

    private String mediaCommand(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return "toggle";
            case KeyEvent.KEYCODE_MEDIA_PLAY: return "play";
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "pause";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return "forward";
            case KeyEvent.KEYCODE_MEDIA_REWIND: return "rewind";
            default: return null;
        }
    }

    @Override
    public void onBackPressed() {
        requestPageBack();
    }

    private void requestPageBack() {
        if (backPending || isFinishing()) return;
        if (appUpdater != null && appUpdater.back()) return;
        if (exitDialog != null && exitDialog.isShowing()) {
            exitDialog.cancel();
            return;
        }
        if (webView == null) {
            showExitConfirmation();
            return;
        }
        backPending = true;
        webView.evaluateJavascript("!!(window.HongguoTV && window.HongguoTV.requestBack())", result -> {
            backPending = false;
            if (!isFinishing() && !isDestroyed() && !"true".equals(result)) showExitConfirmation();
        });
    }

    private void showExitConfirmation() {
        exitDialog = new AlertDialog.Builder(this)
                .setTitle("退出红果短剧？")
                .setNegativeButton("取消", (dialog, which) -> dialog.dismiss())
                .setPositiveButton("退出", (dialog, which) -> finish())
                .create();
        exitDialog.setOnShowListener(dialog -> exitDialog.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus());
        exitDialog.setOnDismissListener(dialog -> scheduleFullscreen());
        exitDialog.show();
    }

    @Override
    protected void onPause() {
        activityForeground = false;
        // Release the actual window flag while backgrounded, but retain the
        // playback intent so a foreground return can restore it immediately.
        syncKeepScreenOn();
        inputEditingState.cancelBack();
        routedVerticalKeys = 0;
        routedHorizontalKeys = 0;
        routedConfirmKeys = 0;
        searchNavigationState.reset();
        completeAccountEditing();
        completeSearchEditing(true);
        if (startupAnimation != null) startupAnimation.stop();
        if (playerBridge != null) playerBridge.onPause();
        if (webView != null) {
            webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.pauseForBackground()", null);
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        activityForeground = true;
        // Reapply the flag before WebView/native playback is resumed. This
        // covers the case where no new `playing` callback is emitted after a
        // short background/foreground transition.
        syncKeepScreenOn();
        if (startupAnimation != null && startupPanel.getVisibility() == View.VISIBLE && startupRetry.getVisibility() != View.VISIBLE) startupAnimation.start();
        applyFullscreen();
        if (webView != null) {
            webView.onResume();
            webView.evaluateJavascript("window.HongguoTV && window.HongguoTV.resumeFromBackground()", null);
        }
        if (playerBridge != null) playerBridge.onResume();
        if (appUpdater != null) appUpdater.resume();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        pageReady = false;
        playbackPageActive = false;
        inputEditingState.reset();
        searchNavigationState.reset();
        if (appUpdater != null) appUpdater.destroy();
        if (homeChannelManager != null) {
            homeChannelManager.destroy();
            homeChannelManager = null;
        }
        if (startupAnimation != null) startupAnimation.stop();
        if (startupThread != null) startupThread.interrupt();
        View decor = getWindow().getDecorView();
        decor.removeCallbacks(restoreFullscreen);
        decor.setOnSystemUiVisibilityChangeListener(null);
        if (decor.getViewTreeObserver().isAlive()) {
            decor.getViewTreeObserver().removeOnGlobalLayoutListener(keyboardLayoutListener);
        }
        if (playerBridge != null) {
            playerBridge.destroy();
            playerBridge = null;
        }
        if (webView != null) {
            webView.removeJavascriptInterface("HongguoNativePlayer");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
