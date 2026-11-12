package rocks.aston.hongguotv;

import org.junit.Test;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.security.MessageDigest;
import static org.junit.Assert.*;

public class UpdateFilesTest {
    private final byte[] content = "signed APK fixture bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    private final UpdateFiles.Monitor normal = new UpdateFiles.Monitor() {
        public void check() {} public void progress(long bytes) {}
    };
    @Test public void completeDownloadIsKeptAndMatchesAllBytes() throws Exception {
        File file = File.createTempFile("update", ".part");
        try {
            UpdateFiles.copyChecked(new ByteArrayInputStream(content), file, content.length, digest(content), normal);
            assertArrayEquals(content, Files.readAllBytes(file.toPath()));
        } finally { file.delete(); }
    }
    @Test public void tamperedTruncatedAndOversizedDownloadsLeaveNoPartialFile() throws Exception {
        for (long size : new long[]{content.length - 1, content.length, content.length + 1}) {
            File file = File.createTempFile("update", ".part");
            try {
                String sha = size == content.length ? digest(new byte[]{1}) : digest(content);
                UpdateFiles.copyChecked(new ByteArrayInputStream(content), file, size, sha, normal);
                fail("bad download accepted");
            } catch (IOException expected) { assertFalse(file.exists()); }
            finally { file.delete(); }
        }
    }
    @Test public void cancellationRemovesTheDownload() throws Exception {
        File file = File.createTempFile("update", ".part");
        try {
            UpdateFiles.copyChecked(new ByteArrayInputStream(content), file, content.length, digest(content), new UpdateFiles.Monitor() {
                public void check() throws IOException { throw new IOException("cancelled"); }
                public void progress(long bytes) { fail("cancelled download progressed"); }
            }); fail("cancel ignored");
        } catch (IOException expected) { assertFalse(file.exists()); }
        finally { file.delete(); }
    }
    @Test public void retryAfterAStreamFailureWritesACompleteNewFile() throws Exception {
        File file = File.createTempFile("update", ".part");
        try {
            java.io.InputStream failed = new java.io.InputStream() {
                int reads;
                public int read() throws IOException { if (++reads > 3) throw new IOException("network disconnected"); return 'x'; }
            };
            try { UpdateFiles.copyChecked(failed, file, content.length, digest(content), normal); fail("broken stream accepted"); }
            catch (IOException expected) { assertFalse(file.exists()); }
            UpdateFiles.copyChecked(new ByteArrayInputStream(content), file, content.length, digest(content), normal);
            assertArrayEquals(content, Files.readAllBytes(file.toPath()));
        } finally { file.delete(); }
    }

    @Test public void savingToDownloadsKeepsTheExistingFileAndUsesASeparateName() throws Exception {
        File downloads = Files.createTempDirectory("downloads").toFile();
        File existing = new File(downloads, "hongguo-tv-0.2.169.apk");
        byte[] original = new byte[]{7, 8, 9};
        Files.write(existing.toPath(), original);
        try {
            File saved = UpdateFiles.saveVerified(new ByteArrayInputStream(content), downloads, existing.getName(),
                    content.length, digest(content), normal);
            assertNotEquals(existing, saved);
            assertArrayEquals(original, Files.readAllBytes(existing.toPath()));
            assertArrayEquals(content, Files.readAllBytes(saved.toPath()));
            assertTrue(saved.getName().endsWith(".apk"));
            assertEquals(2, downloads.listFiles().length);
        } finally { for (File file : downloads.listFiles()) file.delete(); downloads.delete(); }
    }

    @Test public void failedAndCancelledExportsLeaveNoApkOrTemporaryFile() throws Exception {
        File downloads = Files.createTempDirectory("downloads").toFile();
        try {
            for (int scenario = 0; scenario < 3; scenario++) {
                UpdateFiles.Monitor monitor = scenario == 2 ? new UpdateFiles.Monitor() {
                    public void check() throws IOException { throw new IOException("cancelled"); }
                    public void progress(long bytes) { }
                } : normal;
                try {
                    UpdateFiles.saveVerified(new ByteArrayInputStream(content), downloads, "update.apk",
                            scenario == 0 ? content.length + 1 : content.length,
                            scenario == 1 ? digest(new byte[]{0}) : digest(content), monitor);
                    fail("invalid export accepted");
                } catch (IOException expected) { assertEquals(0, downloads.listFiles().length); }
            }
        } finally { downloads.delete(); }
    }

    @Test public void exportRejectsUnavailableDirectoryAndNamesOutsideDownloads() throws Exception {
        File unavailable = File.createTempFile("not-a-directory", ".tmp");
        try {
            try {
                UpdateFiles.saveVerified(new ByteArrayInputStream(content), unavailable, "update.apk", content.length, digest(content), normal);
                fail("unavailable directory accepted");
            } catch (IOException expected) { assertTrue(unavailable.isFile()); }
            for (String name : new String[]{"../update.apk", "/update.apk", "update.txt"}) {
                try {
                    UpdateFiles.saveVerified(new ByteArrayInputStream(content), unavailable, name, content.length, digest(content), normal);
                    fail("unsafe name accepted");
                } catch (IOException expected) { assertTrue(unavailable.isFile()); }
            }
        } finally { unavailable.delete(); }
    }
    private String digest(byte[] bytes) throws Exception { return UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
}
