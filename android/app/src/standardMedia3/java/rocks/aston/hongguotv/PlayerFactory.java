package rocks.aston.hongguotv;

import android.webkit.WebView;
import android.widget.FrameLayout;

final class PlayerFactory {
    static NativePlayerAdapter create(WebView web, FrameLayout holder) {
        return new PlayerBridge(web, holder);
    }
}
