package rocks.aston.hongguotv;

import static org.junit.Assert.assertFalse;

import org.junit.Test;

public final class PlayerRendererPolicyTest {
    @Test
    public void standardPlaybackKeepsWebViewHtml5AsPrimary() {
        assertFalse(PlayerRendererPolicy.primaryPlayback());
    }
}
