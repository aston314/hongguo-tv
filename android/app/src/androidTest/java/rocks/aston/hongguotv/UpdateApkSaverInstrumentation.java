package rocks.aston.hongguotv;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;

/** Runs against real public Downloads storage on API 23 and 29 CI emulators. */
public final class UpdateApkSaverInstrumentation extends Instrumentation {
    private String mode;
    private final UpdateFiles.Monitor normal = new UpdateFiles.Monitor() {
        public void check() { }
        public void progress(long bytes) { }
    };
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        mode = arguments == null ? "save" : arguments.getString("mode", "save");
        start();
    }
    @Override public void onStart() {
        Bundle report = new Bundle();
        try {
            verify();
            report.putString("stream", "UPDATE_EXPORT_OK sdk=" + Build.VERSION.SDK_INT + " mode=" + mode + "\n");
            finish(Activity.RESULT_OK, report);
        } catch (Exception | AssertionError failure) {
            report.putString("stream", "UPDATE_EXPORT_FAILED " + android.util.Log.getStackTraceString(failure));
            finish(Activity.RESULT_CANCELED, report);
        }
    }

    private void verify() throws Exception {
        Context context = getTargetContext();
        File source = new File(context.getCacheDir(), "export-check-source.apk");
        try (InputStream input = new FileInputStream(context.getApplicationInfo().sourceDir);
             FileOutputStream output = new FileOutputStream(source)) {
            byte[] buffer = new byte[32768]; int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
        }
        String prefix = "hongguo-export-check-" + System.nanoTime();
        String sha;
        try (InputStream input = new FileInputStream(source)) { sha = hash(input); }
        try {
            if ("denied".equals(mode)) {
                try {
                    UpdateApkSaver.save(context, source, prefix + ".apk", source.length(), sha, normal);
                    throw new AssertionError("saved without the required legacy storage permission");
                } catch (IOException | SecurityException expected) { }
                require(source.isFile(), "permission denial removed the cached APK");
                return;
            }
            UpdateApkSaver.SavedApk first = UpdateApkSaver.save(context, source, prefix + ".apk", source.length(), sha, normal);
            UpdateApkSaver.SavedApk second = UpdateApkSaver.save(context, source, prefix + ".apk", source.length(), sha, normal);
            require(!first.name.equals(second.name), "same-name download was overwritten");
            require(first.location.contains(Environment.DIRECTORY_DOWNLOADS), "missing public download location");
            verifySaved(context, first, sha);
            verifySaved(context, second, sha);
            for (boolean cancel : new boolean[]{false, true}) {
                try {
                    UpdateApkSaver.save(context, source, prefix + "-bad.apk", source.length(), cancel ? sha : "wrong hash",
                            cancel ? new UpdateFiles.Monitor() {
                                public void check() throws IOException { throw new IOException("cancelled"); }
                                public void progress(long bytes) { }
                            } : normal);
                    throw new AssertionError("invalid/cancelled export was published");
                } catch (IOException expected) { }
            }
            require(source.isFile(), "export removed the cached APK");
            require(countAndCleanup(context, prefix, false) == 2, "failed export left a file or MediaStore row");
        } finally {
            if (!"denied".equals(mode)) countAndCleanup(context, prefix, true);
            source.delete();
        }
    }

    private void verifySaved(Context context, UpdateApkSaver.SavedApk saved, String sha) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            try (Cursor cursor = context.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    new String[]{MediaStore.Downloads._ID, MediaStore.Downloads.IS_PENDING},
                    MediaStore.Downloads.DISPLAY_NAME + "=?", new String[]{saved.name}, null)) {
                require(cursor != null && cursor.moveToFirst(), "published download not found");
                require(cursor.getInt(1) == 0, "download still pending");
                Uri uri = android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cursor.getLong(0));
                try (InputStream input = context.getContentResolver().openInputStream(uri)) {
                    require(sha.equals(hash(input)), "exported download bytes differ");
                }
            }
        } else {
            try (InputStream input = new FileInputStream(saved.location)) {
                require(sha.equals(hash(input)), "exported download bytes differ");
            }
        }
    }

    private int countAndCleanup(Context context, String prefix, boolean delete) {
        if (Build.VERSION.SDK_INT >= 29) {
            Uri collection = MediaStore.setIncludePending(MediaStore.Downloads.EXTERNAL_CONTENT_URI);
            String selection = MediaStore.Downloads.DISPLAY_NAME + " LIKE ?";
            String[] args = new String[]{prefix + "%"};
            try (Cursor cursor = context.getContentResolver().query(collection, new String[]{MediaStore.Downloads._ID}, selection, args, null)) {
                int count = cursor == null ? 0 : cursor.getCount();
                if (delete) context.getContentResolver().delete(collection, selection, args);
                return count;
            }
        }
        File[] files = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).listFiles();
        int count = 0;
        if (files != null) for (File file : files) {
            if (file.getName().startsWith(prefix) || file.getName().startsWith(".hongguo-update-")) {
                count++;
                if (delete) file.delete();
            }
        }
        return count;
    }

    private String hash(InputStream input) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[32768]; int count;
        while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        return UpdatePolicy.hex(digest.digest());
    }
    private void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
