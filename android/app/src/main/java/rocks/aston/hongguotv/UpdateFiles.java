package rocks.aston.hongguotv;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;

final class UpdateFiles {
    interface Monitor { void check() throws IOException; void progress(long bytes); }
    static void copyChecked(InputStream input, File partial, long size, String sha, Monitor monitor) throws Exception {
        boolean complete = false;
        try (FileOutputStream output = new FileOutputStream(partial)) {
            copyChecked(input, output, size, sha, monitor);
            output.getFD().sync();
            complete = true;
        } finally { if (!complete) partial.delete(); }
    }

    /** The caller owns both streams and publishes the destination only after this succeeds. */
    static void copyChecked(InputStream input, OutputStream output, long size, String sha, Monitor monitor) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32768]; int count; long total = 0;
        while ((count = input.read(buffer)) != -1) {
            monitor.check(); total += count;
            if (total > size || total > UpdatePolicy.MAX_APK_BYTES) throw new IOException("安装包超过预期大小");
            output.write(buffer, 0, count); digest.update(buffer, 0, count); monitor.progress(total);
        }
        monitor.check();
        if (total != size || !UpdatePolicy.hex(digest.digest()).equals(sha)) throw new IOException("安装包完整性校验失败");
    }

    /** Never overwrite another download or expose an unchecked APK under its final name. */
    static File saveVerified(InputStream input, File downloads, String name, long size, String sha, Monitor monitor) throws Exception {
        if (!name.endsWith(".apk") || !new File(name).getName().equals(name)) throw new IOException("安装包文件名无效");
        if (!downloads.isDirectory() && !downloads.mkdirs()) throw new IOException("无法写入下载目录，请检查存储空间和权限");
        File temporary = File.createTempFile(".hongguo-update-", ".part", downloads);
        File destination = null;
        boolean complete = false;
        try {
            copyChecked(input, temporary, size, sha, monitor);
            for (int i = 0; i < 100; i++) {
                String candidate = i == 0 ? name : name.substring(0, name.length() - 4) + "-" + i + ".apk";
                File file = new File(downloads, candidate);
                if (file.createNewFile()) { destination = file; break; }
            }
            if (destination == null) throw new IOException("同名安装包过多，请清理下载目录后重试");
            monitor.check();
            if (!temporary.renameTo(destination)) throw new IOException("无法保存安装包，请检查下载目录");
            complete = true;
            return destination;
        } finally {
            temporary.delete();
            if (!complete && destination != null) destination.delete();
        }
    }
}
