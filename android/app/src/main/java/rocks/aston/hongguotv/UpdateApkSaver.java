package rocks.aston.hongguotv;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

/** Exports the verified update to public Downloads. Does not launch an installer. */
final class UpdateApkSaver {
    static final class SavedApk {
        final String name, location;
        SavedApk(String name, String location) { this.name = name; this.location = location; }
    }

    static SavedApk save(Context context, File apk, String name, long size, String sha, UpdateFiles.Monitor monitor) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) return saveMediaStore(context, apk, name, size, sha, monitor);
        if (!Environment.MEDIA_MOUNTED.equals(Environment.getExternalStorageState()))
            throw new IOException("设备存储不可写，请检查存储空间和权限");
        try (FileInputStream input = new FileInputStream(apk)) {
            File saved = UpdateFiles.saveVerified(input,
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), name, size, sha, monitor);
            return new SavedApk(saved.getName(), saved.getAbsolutePath());
        }
    }

    @android.annotation.TargetApi(29)
    private static SavedApk saveMediaStore(Context context, File apk, String name, long size, String sha, UpdateFiles.Monitor monitor) throws Exception {
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, "application/vnd.android.package-archive");
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/");
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("无法创建下载文件，请检查存储空间");
        boolean complete = false;
        try {
            ParcelFileDescriptor descriptor = resolver.openFileDescriptor(uri, "w");
            if (descriptor == null) throw new IOException("无法写入下载目录");
            try (FileOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor);
                 FileInputStream input = new FileInputStream(apk)) {
                UpdateFiles.copyChecked(input, output, size, sha, monitor);
                output.getFD().sync();
            }
            // MediaProvider may change the name to avoid a collision; report its real name.
            String savedName = name;
            try (Cursor cursor = resolver.query(uri, new String[]{MediaStore.Downloads.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) savedName = cursor.getString(0);
            }
            monitor.check();
            ContentValues published = new ContentValues();
            published.put(MediaStore.Downloads.IS_PENDING, 0);
            if (resolver.update(uri, published, null, null) != 1) throw new IOException("无法完成安装包保存");
            complete = true;
            return new SavedApk(savedName, Environment.DIRECTORY_DOWNLOADS + "/" + savedName);
        } finally {
            if (!complete) resolver.delete(uri, null, null);
        }
    }
}
