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
        NSView *originalContent = window.contentView;
        NSWindowStyleMask originalStyle = window.styleMask;
        for (int i = 0; i < 3; i++) {
            require(hongguoSetMiniTitlebarHidden(YES), @"could not hide native titlebar");
            require(window.titleVisibility == NSWindowTitleHidden && window.titlebarAppearsTransparent,
                @"titlebar was not hidden");
            require((window.styleMask & NSWindowStyleMaskResizable) != 0 && window.contentView == originalContent,
                @"hiding titlebar lost resize support or replaced content view");
            require(NSEqualRects(window.frame, ordinary), @"hiding titlebar moved or resized the window");
            require(NSHeight(window.contentView.bounds) == NSHeight(window.frame), @"hidden titlebar still reserves content height");
            for (int button = 0; button < 3; button++)
                require([window standardWindowButton:(NSWindowButton)button].hidden, @"native window button still visible");
            require(hongguoSetMiniTitlebarHidden(NO), @"could not restore native titlebar");
            require(window.styleMask == originalStyle && window.titleVisibility == NSWindowTitleVisible && !window.titlebarAppearsTransparent,
                @"original titlebar style was not restored");
            require(window.contentView == originalContent && NSEqualRects(window.frame, ordinary), @"restoration changed content or frame");
        }

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

        NSSize oldMinimum = window.minSize;
        window.minSize = NSMakeSize(280, 200);
        for (int hidden = 0; hidden <= 1; hidden++) {
            require(hongguoSetMiniTitlebarHidden(hidden), @"aspect setup titlebar failed");
            for (int portrait = 0; portrait <= 1; portrait++) {
                [window setFrame:NSMakeRect(NSMinX(visible)+50, NSMinY(visible)+50, 480, 568) display:YES];
                int vw = portrait ? 1080 : 1920, vh = portrait ? 1924 : 1080;
                require(hongguoSetMiniAspect(vw, vh, YES), @"native content aspect failed");
                pump();
                NSSize content = window.contentView.bounds.size;
                require(fabs(content.width * vh - content.height * vw) <= MAX(vw,vh), @"window content does not fit video ratio");
                NSSize rectContent = [window contentRectForFrameRect:window.frame].size;
                require(NSEqualSizes(rectContent,content), @"AppKit content-aspect rectangle differs from WebView content");
                require(fabs(window.contentAspectRatio.width/window.contentAspectRatio.height - (double)vw/vh)<0.000001,
                    @"native live-resize constraint missing");
                require(window.contentView == originalContent && (window.styleMask & NSWindowStyleMaskResizable),
                    @"aspect change replaced content or disabled dragging");
                NSSize fitted = window.frame.size;
                [window setFrameOrigin:NSMakePoint(NSMinX(visible)+60,NSMinY(visible)+60)];
                require(NSEqualSizes(fitted,window.frame.size), @"moving mini window resized it");
                require(hongguoSetMiniAspect(0,0,NO), @"could not restore native aspect");
                require(NSEqualSizes(window.contentAspectRatio,NSZeroSize), @"aspect leaked outside mini window");
            }
            require(hongguoSetMiniTitlebarHidden(NO), @"aspect titlebar restoration failed");
        }
        window.minSize = oldMinimum;
        [window setFrame:ordinary display:YES];
        require(NSEqualRects(window.frame,ordinary), @"normal geometry changed after aspect mode");

        // Pending metadata during a native full-screen transition is applied
        // only after DidExit, never to the temporary full-screen rectangle.
        window.minSize=NSMakeSize(280,200);
        [window setFrame:NSMakeRect(NSMinX(visible)+50,NSMinY(visible)+50,320,568) display:YES];
        require(hongguoSetMiniAspect(1080,1920,YES), @"portrait setup failed");
        [center postNotificationName:NSWindowWillEnterFullScreenNotification object:window];
        require(NSEqualSizes(window.contentAspectRatio,NSZeroSize), @"fullscreen retained mini constraints");
        require(hongguoSetMiniAspect(1920,1080,YES), @"pending landscape metadata failed");
        [center postNotificationName:NSWindowWillExitFullScreenNotification object:window];
        [center postNotificationName:NSWindowDidExitFullScreenNotification object:window];
        pump();
        require(fabs(window.contentView.bounds.size.width/window.contentView.bounds.size.height-16.0/9)<0.01,
            @"pending aspect did not recover after fullscreen");
        require(hongguoSetMiniAspect(0,0,NO), @"fullscreen aspect cleanup failed");
        window.minSize=oldMinimum;
        [window setFrame:ordinary display:YES];

        [window setFrame:NSMakeRect(100000, -100000, 480, 300) display:NO];
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
                require(hongguoSetMiniTitlebarHidden(YES), @"fullscreen exit -> mini titlebar failed");
                require(hongguoSetMiniTitlebarHidden(NO), @"mini -> fullscreen titlebar restoration failed");
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
