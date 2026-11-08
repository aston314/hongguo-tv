// Native regression harness; no core, WebView, account, or media requests.
#import "../window_state_darwin.m"

@interface WailsWindow : NSWindow
@end
@implementation WailsWindow
@end

static void require(BOOL passed, NSString *message) {
    if (!passed) {
        fprintf(stderr, "%s\n", message.UTF8String);
        exit(1);
    }
}

static void pump(void) {
    [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
}

static void waitForFullscreen(NSWindow *window, BOOL expected) {
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (((window.styleMask & NSWindowStyleMaskFullScreen) != 0) != expected || hongguoWindowTransitioning()) {
        require(deadline.timeIntervalSinceNow > 0, @"native fullscreen transition timed out");
        pump();
    }
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSRect visible = NSScreen.mainScreen.visibleFrame;
        WailsWindow *window = [[WailsWindow alloc] initWithContentRect:NSMakeRect(NSMinX(visible)+80, NSMinY(visible)+80, 1000, 600)
            styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable|NSWindowStyleMaskMiniaturizable
            backing:NSBackingStoreBuffered defer:NO];
        window.title = @"Hongguo window state regression check";
        window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
        [window makeKeyAndOrderFront:nil];
        [NSApp finishLaunching];
        hongguoObserveWindow();
        NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
        NSRect ordinary = window.frame;

        // Exercise the actual observer and real NSWindow frame restoration,
        // including the interval after the style flag changes but before DidExit.
        [center postNotificationName:NSWindowWillEnterFullScreenNotification object:window];
        [window setFrame:visible display:NO];
        [center postNotificationName:NSWindowDidEnterFullScreenNotification object:window];
        int x, y, width, height, maximised;
        require(hongguoFullscreenRestore(&x, &y, &width, &height, &maximised), @"missing ordinary snapshot");
        require(width == (int)ordinary.size.width && height == (int)ordinary.size.height && !maximised, @"snapshot captured fullscreen/zoomed frame");
        [center postNotificationName:NSWindowWillExitFullScreenNotification object:window];
        require(hongguoWindowTransitioning(), @"window became resizeable before DidExit");
        [center postNotificationName:NSWindowDidExitFullScreenNotification object:window];
        require(!hongguoWindowTransitioning() && NSEqualRects(window.frame, ordinary), @"DidExit lost ordinary frame");

        [window setFrame:NSMakeRect(NSMaxX(visible)+300, NSMinY(visible)-500, 480, 300) display:NO];
        hongguoKeepMiniWindowVisible();
        require(NSContainsRect(visible, window.frame), @"off-screen small window was not constrained to visible area");

        if (argc > 1 && strcmp(argv[1], "--fullscreen") == 0) {
            [NSApp activateIgnoringOtherApps:YES];
            for (int zoomed = 0; zoomed <= 1; zoomed++) {
                [window setFrame:ordinary display:YES];
                if (zoomed) [window zoom:nil];
                NSRect original = window.frame;
                BOOL originallyZoomed = window.isZoomed;
                [window toggleFullScreen:nil];
                waitForFullscreen(window, YES);
                require(hongguoFullscreenRestore(&x, &y, &width, &height, &maximised) && maximised == originallyZoomed,
                    @"fullscreen changed the original zoom state");
                [window toggleFullScreen:nil];
                waitForFullscreen(window, NO);
                require(NSEqualRects(window.frame, original), @"leaving fullscreen for mini mode lost original frame");
                [window setFrame:NSMakeRect(NSMinX(visible)+100, NSMinY(visible)+100, 480, 300) display:YES];
                // Return from mini mode, retaining the original fullscreen mode.
                [window setFrame:original display:YES];
                [window toggleFullScreen:nil];
                waitForFullscreen(window, YES);
                [window toggleFullScreen:nil]; // Same native exit as Escape.
                waitForFullscreen(window, NO);
                require(NSEqualRects(window.frame, original) && window.isZoomed == originallyZoomed,
                    @"fullscreen -> mini -> fullscreen -> Escape changed the original window");
                printf("native fullscreen round trip: zoomed=%d frame=%s\n", zoomed, NSStringFromRect(window.frame).UTF8String);
            }
        }
        [window orderOut:nil];
        puts("native window observer and visible-area checks passed");
    }
    return 0;
}
