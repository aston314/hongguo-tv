//go:build darwin

#import <Cocoa/Cocoa.h>

static NSWindow *hongguoMainWindow(void) {
    for (NSWindow *window in [NSApp windows]) {
        if ([NSStringFromClass([window class]) isEqualToString:@"WailsWindow"]) return window;
    }
    return nil;
}

static void hongguoOnMain(void (^action)(void)) {
    if ([NSThread isMainThread]) action();
    else dispatch_sync(dispatch_get_main_queue(), action);
}

// Observe rather than replace Wails' NSWindowDelegate. The style-mask flag can
// change before the Space animation completes; only DidExit makes frame reads
// and subsequent small-window resizing safe.
@interface HongguoWindowObserver : NSObject
@property(nonatomic, assign) BOOL transitioning;
@property(nonatomic, assign) BOOL hasFullscreenRestore;
@property(nonatomic, assign) BOOL fullscreenWasZoomed;
@property(nonatomic, assign) NSRect fullscreenRestoreFrame;
@end

@implementation HongguoWindowObserver
- (void)willEnter:(NSNotification *)note {
    NSWindow *window = note.object;
    self.fullscreenRestoreFrame = window.frame;
    self.fullscreenWasZoomed = window.isZoomed;
    self.hasFullscreenRestore = YES;
    self.transitioning = YES;
}
- (void)didEnter:(NSNotification *)note { self.transitioning = NO; }
- (void)willExit:(NSNotification *)note { self.transitioning = YES; }
- (void)didExit:(NSNotification *)note {
    NSWindow *window = note.object;
    if (self.hasFullscreenRestore && !self.fullscreenWasZoomed) {
        [window setFrame:self.fullscreenRestoreFrame display:YES animate:NO];
    }
    self.transitioning = NO;
}
@end

static HongguoWindowObserver *hongguoWindowObserver;

void hongguoObserveWindow(void) {
    hongguoOnMain(^{
        NSWindow *window = hongguoMainWindow();
        if (!window || hongguoWindowObserver) return;
        hongguoWindowObserver = [HongguoWindowObserver new];
        NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
        [center addObserver:hongguoWindowObserver selector:@selector(willEnter:) name:NSWindowWillEnterFullScreenNotification object:window];
        [center addObserver:hongguoWindowObserver selector:@selector(didEnter:) name:NSWindowDidEnterFullScreenNotification object:window];
        [center addObserver:hongguoWindowObserver selector:@selector(willExit:) name:NSWindowWillExitFullScreenNotification object:window];
        [center addObserver:hongguoWindowObserver selector:@selector(didExit:) name:NSWindowDidExitFullScreenNotification object:window];
    });
}

int hongguoWindowTransitioning(void) {
    __block int result = 0;
    hongguoOnMain(^{ result = hongguoWindowObserver.transitioning; });
    return result;
}

int hongguoFullscreenRestore(int *x, int *y, int *width, int *height, int *maximised) {
    __block int result = 0;
    hongguoOnMain(^{
        NSWindow *window = hongguoMainWindow();
        if (!window || !hongguoWindowObserver.hasFullscreenRestore) return;
        NSRect frame = hongguoWindowObserver.fullscreenRestoreFrame;
        NSRect screen = window.screen.visibleFrame;
        // Match Wails' screen-relative, top-left window coordinates.
        *x = (int)(NSMinX(frame) - NSMinX(screen));
        *y = (int)(NSMaxY(screen) - NSMaxY(frame));
        *width = (int)NSWidth(frame);
        *height = (int)NSHeight(frame);
        *maximised = hongguoWindowObserver.fullscreenWasZoomed;
        result = 1;
    });
    return result;
}

void hongguoKeepMiniWindowVisible(void) {
    hongguoOnMain(^{
        NSWindow *window = hongguoMainWindow();
        NSScreen *screen = window.screen ?: NSScreen.mainScreen;
        if (!window || !screen) return;
        NSRect visible = NSInsetRect(screen.visibleFrame, 12, 12);
        NSRect frame = window.frame;
        frame.size.width = MIN(frame.size.width, NSWidth(visible));
        frame.size.height = MIN(frame.size.height, NSHeight(visible));
        frame.origin.x = MAX(NSMinX(visible), MIN(NSMinX(frame), NSMaxX(visible) - NSWidth(frame)));
        frame.origin.y = MAX(NSMinY(visible), MIN(NSMinY(frame), NSMaxY(visible) - NSHeight(frame)));
        [window setFrame:frame display:YES animate:NO];
    });
}

// WKWebView briefly reports document.hidden during native full-screen Space
// transitions. Query actual minimisation/app hiding on Cocoa's main thread.
int hongguoWindowHidden(void) {
    __block int hidden = 0;
    void (^readState)(void) = ^{
        hidden = [NSApp isHidden];
        hidden = hidden || [hongguoMainWindow() isMiniaturized];
    };
    hongguoOnMain(readState);
    return hidden;
}
