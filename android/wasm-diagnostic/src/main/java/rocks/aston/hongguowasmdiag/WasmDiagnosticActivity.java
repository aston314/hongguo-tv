package rocks.aston.hongguowasmdiag;

import android.app.Activity;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.IOException;

public final class WasmDiagnosticActivity extends Activity {
    private AssetHttpServer assetServer;
    private WebView webView;
    private volatile String pageReport = "";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        applyFullscreen();
        try {
            assetServer = new AssetHttpServer(getAssets(), new AssetHttpServer.ResultsProvider() {
                @Override public String getResultsJson() { return buildRemoteReport(); }
            });
            assetServer.start();
        } catch (IOException failure) {
            TextView error = new TextView(this);
            error.setText("本地测试服务启动失败：" + failure.getMessage());
            setContentView(error);
            return;
        }
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.addJavascriptInterface(new DiagnosticBridge(), "HongguoWasmDiag");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetServer != null && assetServer.isLocalUrl(request.getUrl())
                        ? null : AssetHttpServer.forbiddenResponse();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return assetServer == null || request == null
                        || !assetServer.isLocalUrl(request.getUrl());
            }
        });
        setContentView(webView);
        webView.loadUrl(assetServer.getBaseUrl() + "/index.html");
    }

    private void applyFullscreen() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyFullscreen();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        if (assetServer != null) {
            assetServer.close();
            assetServer = null;
        }
        super.onDestroy();
    }

    private final class DiagnosticBridge {
        @JavascriptInterface
        public String getDeviceInfo() {
            JSONObject result = new JSONObject();
            try {
                result.put("manufacturer", Build.MANUFACTURER);
                result.put("model", Build.MODEL);
                result.put("android", Build.VERSION.RELEASE);
                result.put("api", Build.VERSION.SDK_INT);
                result.put("abi", Build.VERSION.SDK_INT >= 21 ? Build.SUPPORTED_ABIS[0] : Build.CPU_ABI);
                DisplayMetrics metrics = getResources().getDisplayMetrics();
                result.put("screen", metrics.widthPixels + "x" + metrics.heightPixels);
                PackageInfo info = currentWebViewPackage();
                if (info != null) result.put("webview", info.packageName + " " + info.versionName);
                else result.put("webview", "不可读取");
            } catch (Exception ignored) {
                // Keep the diagnostic useful if one optional package field is unavailable.
            }
            return result.toString();
        }

        @JavascriptInterface
        public int getRangeRequestCount() {
            return assetServer == null ? 0 : assetServer.getRangeRequestCount();
        }

        @JavascriptInterface
        public String getLastRequest() {
            return assetServer == null ? "本地服务未启动" : assetServer.getLastRequest();
        }

        @JavascriptInterface
        public void setPageReport(String report) {
            pageReport = report == null ? "" : report.substring(0, Math.min(report.length(), 6000));
        }
    }

    private String buildRemoteReport() {
        JSONObject result = new JSONObject();
        try {
            result.put("app", "HEVC WebView diagnostic");
            result.put("schemaVersion", 1);
            result.put("capturedAtEpochMs", System.currentTimeMillis());
            result.put("device", new JSONObject(new DiagnosticBridge().getDeviceInfo()));
            result.put("http206Range", assetServer == null ? 0 : assetServer.getRangeRequestCount());
            result.put("lastRequest", assetServer == null ? "本地服务未启动" : assetServer.getLastRequest());
            result.put("report", pageReport);
        } catch (Exception failure) {
            return "{\"error\":\"诊断结果生成失败\"}";
        }
        return result.toString();
    }

    private PackageInfo currentWebViewPackage() {
        if (Build.VERSION.SDK_INT >= 26) return WebView.getCurrentWebViewPackage();
        String[] candidates = {"com.google.android.webview", "com.android.webview"};
        for (String name : candidates) {
            try {
                return getPackageManager().getPackageInfo(name, 0);
            } catch (Exception ignored) {
                // Try the next system package name.
            }
        }
        return null;
    }
}