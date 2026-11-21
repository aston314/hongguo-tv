//go:build darwin

#import <Cocoa/Cocoa.h>
#include "mini_aspect_geometry.h"

static BOOL hongguoMiniAspectSaved, hongguoMiniAspectFitting, hongguoMiniAspectSuspended;
static NSWindow *hongguoMiniAspectWindow;
static NSSize hongguoMiniOriginalAspect, hongguoMiniVideoAspect;
static void hongguoApplyMiniAspect(NSWindow *window, BOOL refit);

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
    if (hongguoMiniAspectSaved) {
        window.contentAspectRatio = hongguoMiniOriginalAspect;
        hongguoMiniAspectSuspended = YES;
    }
}
- (void)didEnter:(NSNotification *)note { self.transitioning = NO; }
- (void)willExit:(NSNotification *)note { self.transitioning = YES; }
- (void)didExit:(NSNotification *)note {
    NSWindow *window = note.object;
    if (self.hasFullscreenRestore && !self.fullscreenWasZoomed) {
        [window setFrame:self.fullscreenRestoreFrame display:YES animate:NO];
    }
    self.transitioning = NO;
    if (hongguoMiniAspectSaved) hongguoApplyMiniAspect(window, YES);
}
- (void)didResize:(NSNotification *)note {
    if (!hongguoMiniAspectSaved || hongguoMiniAspectFitting) return;
    NSWindow *window = note.object;
    if (self.transitioning || window.isZoomed || (window.styleMask & NSWindowStyleMaskFullScreen)) {
        window.contentAspectRatio = hongguoMiniOriginalAspect;
        hongguoMiniAspectSuspended = YES;
    } else if (hongguoMiniAspectSuspended) hongguoApplyMiniAspect(window, YES);
}
@end

static HongguoWindowObserver *hongguoWindowObserver;

static void hongguoApplyMiniAspect(NSWindow *window, BOOL refit) {
    if (hongguoMiniAspectFitting || window != hongguoMiniAspectWindow) return;
    if (hongguoWindowObserver.transitioning || window.isZoomed || (window.styleMask & NSWindowStyleMaskFullScreen)) {
        window.contentAspectRatio = hongguoMiniOriginalAspect;
        hongguoMiniAspectSuspended = YES;
        return;
    }
    hongguoMiniAspectFitting = YES;
    @try {
        window.contentAspectRatio = hongguoMiniVideoAspect;
        hongguoMiniAspectSuspended = NO;
        if (refit) {
            NSRect old = window.frame;
            NSSize content = window.contentView.bounds.size;
            NSRect screen = NSInsetRect((window.screen ?: NSScreen.mainScreen).visibleFrame, 12, 12);
            double chromeW = fmax(0, old.size.width - content.width);
            double chromeH = fmax(0, old.size.height - content.height);
            MiniContentSize fit = mini_fit_content(content.width, content.height,
                hongguoMiniVideoAspect.width / hongguoMiniVideoAspect.height,
                fmax(1, window.minSize.width - chromeW), fmax(1, window.minSize.height - chromeH),
                NSWidth(screen) - chromeW, NSHeight(screen) - chromeH);
            NSRect frame = old;
            frame.size = NSMakeSize(fit.width + chromeW, fit.height + chromeH);
            frame.origin.y = NSMaxY(old) - frame.size.height;
            frame.origin.x = fmax(NSMinX(screen), fmin(frame.origin.x, NSMaxX(screen) - frame.size.width));
            frame.origin.y = fmax(NSMinY(screen), fmin(frame.origin.y, NSMaxY(screen) - frame.size.height));
            if (!NSEqualRects(frame, old)) [window setFrame:frame display:YES animate:NO];
        }
    } @finally { hongguoMiniAspectFitting = NO; }
}

int hongguoSetMiniAspect(int width, int height, int refit) {
    __block int ok = 0;
    hongguoOnMain(^{
        NSWindow *window = hongguoMainWindow();
        if (width == 0 && height == 0) {
            if (hongguoMiniAspectSaved) {
                if (!window || window != hongguoMiniAspectWindow) return;
                window.contentAspectRatio = hongguoMiniOriginalAspect;
            }
            hongguoMiniAspectSaved = hongguoMiniAspectSuspended = NO;
            hongguoMiniAspectWindow = nil;
            ok = 1;
            return;
        }
        if (!window || width <= 0 || height <= 0 || width > 32768 || height > 32768 ||
            width > height * 10 || height > width * 10) return;
        @try {
            if (!hongguoMiniAspectSaved) {
                hongguoMiniAspectWindow = window;
                hongguoMiniOriginalAspect = window.contentAspectRatio;
                hongguoMiniAspectSaved = YES;
            }
            hongguoMiniVideoAspect = NSMakeSize((double)width / height, 1);
            hongguoApplyMiniAspect(window, refit != 0);
            ok = 1;
        } @catch (NSException *exception) { ok = 0; }
    });
    return ok;
}

// Keep the titled/resizable window class. Extending content into the titlebar
// and hiding its controls avoids replacing the window or its WKWebView.
static BOOL hongguoMiniTitlebarSaved;
static NSWindowStyleMask hongguoMiniStyle;
static NSWindowTitleVisibility hongguoMiniTitleVisibility;
static BOOL hongguoMiniTransparent;
static BOOL hongguoMiniButtonsHidden[3];

int hongguoSetMiniTitlebarHidden(int hidden) {
    __block int ok = 0;
    hongguoOnMain(^{
        NSWindow *window = hongguoMainWindow();
        if (!window || hongguoWindowObserver.transitioning ||
            (window.styleMask & NSWindowStyleMaskFullScreen)) return;
        NSRect frame = window.frame;
        @try {
            if (hidden) {
                if (!hongguoMiniTitlebarSaved) {
                    hongguoMiniStyle = window.styleMask;
                    hongguoMiniTitleVisibility = window.titleVisibility;
                    hongguoMiniTransparent = window.titlebarAppearsTransparent;
                    for (int i = 0; i < 3; i++)
                        hongguoMiniButtonsHidden[i] = [window standardWindowButton:(NSWindowButton)i].hidden;
                    hongguoMiniTitlebarSaved = YES;
                }
                window.styleMask |= NSWindowStyleMaskFullSizeContentView;
                window.titleVisibility = NSWindowTitleHidden;
                window.titlebarAppearsTransparent = YES;
                for (int i = 0; i < 3; i++) [window standardWindowButton:(NSWindowButton)i].hidden = YES;
            } else if (hongguoMiniTitlebarSaved) {
                window.styleMask = hongguoMiniStyle;
                window.titleVisibility = hongguoMiniTitleVisibility;
                window.titlebarAppearsTransparent = hongguoMiniTransparent;
                for (int i = 0; i < 3; i++)
                    [window standardWindowButton:(NSWindowButton)i].hidden = hongguoMiniButtonsHidden[i];
                hongguoMiniTitlebarSaved = NO;
            }
            [window setFrame:frame display:YES animate:NO];
            ok = 1;
        } @catch (NSException *exception) {
            // Retain the snapshot so the caller can restore the old style.
            ok = 0;
        }
    });
    return ok;
}

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
        [center addObserver:hongguoWindowObserver selector:@selector(didResize:) name:NSWindowDidResizeNotification object:window];
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
