package rocks.aston.hongguowasmdiag;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

final class AssetHttpServer implements AutoCloseable {
    static final int PORT = 18998;

    interface ResultsProvider {
        String getResultsJson();
    }

    private final AssetManager assets;
    private final ResultsProvider resultsProvider;
    private final AtomicInteger rangeRequests = new AtomicInteger();
    private volatile String lastRequest = "尚无媒体请求";
    private volatile boolean running;
    private ServerSocket server;
    private Thread acceptThread;

    AssetHttpServer(AssetManager assets, ResultsProvider resultsProvider) {
        this.assets = assets;
        this.resultsProvider = resultsProvider;
    }

    void start() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(java.net.InetAddress.getByName("0.0.0.0"), PORT), 8);
        running = true;
        acceptThread = new Thread(new Runnable() {
            @Override public void run() {
                while (running) {
                    try {
                        final Socket socket = server.accept();
                        Thread requestThread = new Thread(new Runnable() {
                            @Override public void run() { handle(socket); }
                        }, "wasm-http-request");
                        requestThread.start();
                    } catch (IOException failure) {
                        if (running) lastRequest = "本地服务接收失败：" + failure.getMessage();
                    }
                }
            }
        }, "wasm-http-accept");
        acceptThread.start();
    }

    String getBaseUrl() {
        return "http://127.0.0.1:" + PORT;
    }

    int getRangeRequestCount() {
        return rangeRequests.get();
    }

    String getLastRequest() {
        return lastRequest;
    }

    boolean isLocalUrl(Uri uri) {
        return uri != null && "http".equalsIgnoreCase(uri.getScheme())
                && "127.0.0.1".equals(uri.getHost()) && server != null
                && uri.getPort() == PORT;
    }

    private void handle(Socket socket) {
        try (Socket client = socket;
             BufferedInputStream input = new BufferedInputStream(client.getInputStream());
             BufferedOutputStream output = new BufferedOutputStream(client.getOutputStream())) {
            client.setSoTimeout(5000);
            String requestLine = readLine(input);
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2 || !("GET".equals(parts[0]) || "HEAD".equals(parts[0]))) {
                writeResponse(output, 405, "Method Not Allowed", "text/plain", new byte[0], null);
                lastRequest = "不支持的请求方法：" + requestLine;
                return;
            }
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(input)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) headers.put(line.substring(0, colon).trim().toLowerCase(Locale.US),
                        line.substring(colon + 1).trim());
            }
            String path = Uri.parse(parts[1]).getPath();
            if (path == null || path.contains("..") || path.contains("\\")) {
                writeResponse(output, 400, "Bad Request", "text/plain", new byte[0], null);
                lastRequest = "拒绝非法路径：" + parts[1];
                return;
            }
            java.net.InetAddress remoteAddress = client.getInetAddress();
            boolean loopback = remoteAddress.isLoopbackAddress();
            boolean localNetwork = remoteAddress.isSiteLocalAddress() || remoteAddress.isLinkLocalAddress();
            if (!loopback && !localNetwork) {
                writeResponse(output, 403, "Forbidden", "application/json", new byte[0], null);
                return;
            }
            if (!loopback && !"/api/results".equals(path)) {
                writeResponse(output, 403, "Forbidden", "application/json", new byte[0], null);
                lastRequest = "拒绝局域网读取资源：" + path;
                return;
            }
            if ("/api/results".equals(path)) {
                if (!"GET".equals(parts[0])) {
                    writeResponse(output, 405, "Method Not Allowed", "application/json", new byte[0],
                            "Allow: GET\r\n");
                    return;
                }
                byte[] json = resultsProvider.getResultsJson().getBytes(StandardCharsets.UTF_8);
                writeResponse(output, 200, "OK", "application/json; charset=utf-8", json, null);
                return;
            }
            byte[] body;
            try {
                body = readAsset("www" + path);
            } catch (IOException missing) {
                writeResponse(output, 404, "Not Found", "text/plain", new byte[0], null);
                lastRequest = path + " -> HTTP 404";
                return;
            }

            int start = 0;
            int end = body.length - 1;
            int status = 200;
            String reason = "OK";
            String range = headers.get("range");
            if (range != null && path.startsWith("/samples/")) {
                int[] bounds = parseRange(range, body.length);
                if (bounds == null) {
                    writeResponse(output, 416, "Range Not Satisfiable", "video/mp4",
                            new byte[0], "Content-Range: bytes */" + body.length + "\r\n");
                    lastRequest = range + " -> HTTP 416";
                    return;
                }
                start = bounds[0];
                end = bounds[1];
                status = 206;
                reason = "Partial Content";
            }
            int length = end - start + 1;
            byte[] response = new byte[length];
            System.arraycopy(body, start, response, 0, length);
            String extra = "Accept-Ranges: bytes\r\n";
            if (status == 206) extra += "Content-Range: bytes " + start + "-" + end + "/" + body.length + "\r\n";
            writeResponse(output, status, reason, mimeFor(path),
                    "HEAD".equals(parts[0]) ? new byte[0] : response, extra);
            if (status == 206) rangeRequests.incrementAndGet();
            lastRequest = path + (range == null ? "" : " " + range) + " -> HTTP " + status + ", " + length + " bytes sent";
        } catch (Exception failure) {
            lastRequest = "本地 HTTP 响应失败：" + failure.getMessage();
        }
    }

    private byte[] readAsset(String name) throws IOException {
        try (InputStream input = assets.open(name); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return output.toByteArray();
        }
    }

    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int value;
        while ((value = input.read()) != -1) {
            if (value == '\n') break;
            if (value != '\r') line.write(value);
            if (line.size() > 8192) throw new IOException("HTTP header too large");
        }
        if (value == -1 && line.size() == 0) return null;
        return new String(line.toByteArray(), StandardCharsets.US_ASCII);
    }

    private static int[] parseRange(String value, int total) {
        if (!value.startsWith("bytes=")) return null;
        String[] bounds = value.substring(6).split("-", 2);
        try {
            int start = Integer.parseInt(bounds[0]);
            int end = bounds.length > 1 && !bounds[1].isEmpty()
                    ? Integer.parseInt(bounds[1]) : total - 1;
            if (start < 0 || start >= total || end < start) return null;
            return new int[]{start, Math.min(end, total - 1)};
        } catch (RuntimeException invalid) {
            return null;
        }
    }

    private static String mimeFor(String path) {
        if (path.endsWith(".html")) return "text/html; charset=utf-8";
        if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (path.endsWith(".css")) return "text/css; charset=utf-8";
        if (path.endsWith(".wasm")) return "application/wasm";
        if (path.endsWith(".mp4")) return "video/mp4";
        return "application/octet-stream";
    }

    private static void writeResponse(BufferedOutputStream output, int status, String reason,
                                      String contentType, byte[] body, String extraHeaders) throws IOException {
        String headers = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Connection: close\r\n"
                + "Cache-Control: no-store\r\n"
                + (extraHeaders == null ? "" : extraHeaders)
                + "\r\n";
        output.write(headers.getBytes(StandardCharsets.US_ASCII));
        output.write(body);
        output.flush();
    }

    static WebResourceResponse forbiddenResponse() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
                java.util.Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    @Override public void close() {
        running = false;
        if (server != null) {
            try { server.close(); } catch (IOException ignored) {}
            server = null;
        }
        if (acceptThread != null) {
            acceptThread.interrupt();
            acceptThread = null;
        }
    }
}