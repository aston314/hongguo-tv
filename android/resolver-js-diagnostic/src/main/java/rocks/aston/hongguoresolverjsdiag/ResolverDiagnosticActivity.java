package rocks.aston.hongguoresolverjsdiag;

import android.app.Activity;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.Arrays;

/** Isolated test package: no access to production accounts or playback data. */
public final class ResolverDiagnosticActivity extends Activity {
    private volatile java.lang.Process core;
    private volatile boolean closed;
    private WebView web;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        TextView waiting = new TextView(this);
        waiting.setText("native".equals(getIntent().getStringExtra("engine")) ? "正在启动原生解析对照…" : "正在加载本地 resolver.js…");
        waiting.setTextSize(24);
        waiting.setPadding(40, 40, 40, 40);
        setContentView(waiting);
        WebView.setWebContentsDebuggingEnabled(true);
        new Thread(() -> startCore(waiting), "resolver-probe-core").start();
    }

    private void startCore(TextView waiting) {
        try {
            File binary = new File(getApplicationInfo().nativeLibraryDir, "libresolverjsprobe.so");
            File data = new File(getFilesDir(), "resolver-probe");
            ArrayList<String> command = new ArrayList<>(Arrays.asList(binary.getAbsolutePath(), "-port", "0", "-parent-pid", Integer.toString(Process.myPid()), "-data-dir", data.getAbsolutePath()));
            command.add("-engine");
            command.add("native".equals(getIntent().getStringExtra("engine")) ? "native" : "js");
            if (getIntent().getBooleanExtra("update_lab", false)) command.add("-update-lab");
            if (getIntent().getBooleanExtra("simulate_stale", false)) command.add("-simulate-stale");
            String moduleVersion = getIntent().getStringExtra("module_version");
            if (moduleVersion != null) { command.add("-module-version"); command.add(moduleVersion); }
            if (getIntent().getBooleanExtra("private_module_override", false)) {
                command.add("-js-file");
                command.add(new File(data, "candidate.js").getAbsolutePath());
            }
            java.lang.Process child = new ProcessBuilder(command).redirectErrorStream(true).start();
            core = child;
            if (closed) { child.destroy(); return; }
            try (BufferedReader lines = new BufferedReader(new InputStreamReader(child.getInputStream()))) {
                String line;
                while ((line = lines.readLine()) != null && !closed) {
                    Log.i("ResolverJSProbe", line);
                    if (line.startsWith("HONGGUO_TV_READY ")) {
                        String[] fields = line.split(" ");
                        int port = Integer.parseInt(fields[1]);
                        runOnUiThread(() -> showPage(port));
                    }
                }
            }
        } catch (Exception error) {
            Log.e("ResolverJSProbe", "Diagnostic core failed", error);
            runOnUiThread(() -> { if (!closed) waiting.setText("测试服务启动失败：" + error.getClass().getSimpleName()); });
        }
    }

    private void showPage(int port) {
        if (closed || web != null) return;
        String origin = "http://127.0.0.1:" + port;
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !url.startsWith(origin + "/");
            }
        });
        setContentView(web);
        web.loadUrl(origin + "/");
    }

    @Override protected void onDestroy() {
        closed = true;
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        if (core != null) { core.destroy(); core = null; }
        super.onDestroy();
    }
}
