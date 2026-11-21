#ifndef HONGGUO_MINI_ASPECT_LINUX_H
#define HONGGUO_MINI_ASPECT_LINUX_H
#include <gtk/gtk.h>
#include "mini_aspect_geometry.h"

typedef struct { GMutex mutex; GCond done; gint refs, width, height, initial_width, initial_height; gboolean refit, complete, cancelled, ok; } MiniAspectRequest;
static GtkWindow *mini_aspect_window;
static gint mini_aspect_width, mini_aspect_height;
static gulong mini_aspect_state_handler;
static gboolean mini_aspect_suspended;
static gint mini_aspect_initial_width, mini_aspect_initial_height;

static gboolean mini_aspect_has_webview(GtkWidget *widget) {
    if (g_strcmp0(gtk_widget_get_name(widget), "webview-box") == 0) return TRUE;
    if (!GTK_IS_CONTAINER(widget)) return FALSE;
    GList *children = gtk_container_get_children(GTK_CONTAINER(widget));
    gboolean found = FALSE;
    for (GList *p=children; p && !found; p=p->next) found=mini_aspect_has_webview(p->data);
    g_list_free(children);
    return found;
}

static gboolean mini_aspect_apply_gtk(GtkWindow *window, gboolean refit) {
    GdkWindow *native=gtk_widget_get_window(GTK_WIDGET(window));
    if (!native) return FALSE;
    GdkWindowState state=gdk_window_get_state(native);
    if (state & (GDK_WINDOW_STATE_FULLSCREEN | GDK_WINDOW_STATE_MAXIMIZED | GDK_WINDOW_STATE_ICONIFIED)) {
        // Fullscreen/maximise retain the old framework behaviour. Restore the
        // small-window constraint only when the native window is ordinary.
        gtk_window_set_geometry_hints(window,NULL,NULL,0);
        mini_aspect_suspended=TRUE;
        return TRUE;
    }
    GdkRectangle work,frame;
    GdkMonitor *monitor=gdk_display_get_monitor_at_window(gdk_window_get_display(native),native);
    if (!monitor) return FALSE;
    gdk_monitor_get_workarea(monitor,&work);
    gdk_window_get_frame_extents(native,&frame);
    int width,height;gtk_window_get_size(window,&width,&height);
    double chromeW=fmax(0,frame.width-width),chromeH=fmax(0,frame.height-height);
    double ratio=(double)mini_aspect_width/mini_aspect_height;
    double maxW=fmax(1,work.width-24-chromeW),maxH=fmax(1,work.height-24-chromeH);
    GdkGeometry hints={0};
    hints.min_width=(int)fmin(280,fmin(maxW,maxH*ratio));
    hints.min_height=(int)fmin(200,fmin(maxH,maxW/ratio));
    hints.max_width=(int)maxW;hints.max_height=(int)maxH;
    hints.min_aspect=hints.max_aspect=ratio;
    // Without an explicit base, GTK can publish the minimum size as PBaseSize.
    // The WM then applies the ratio to (width-280,height-200), not the video
    // content itself (e.g. a 480-wide landscape window becomes ~312 high).
    hints.base_width=hints.base_height=0;
    gtk_window_set_geometry_hints(window,NULL,&hints,GDK_HINT_MIN_SIZE|GDK_HINT_MAX_SIZE|GDK_HINT_BASE_SIZE|GDK_HINT_ASPECT);
    mini_aspect_suspended=FALSE;
    if (refit) {
        // gtk_window_resize requests precede WM configure notifications. A new
        // mini session must fit its requested size, never the old fullscreen
        // rectangle returned by gtk_window_get_size during that interval.
        int fitW=mini_aspect_initial_width>0?mini_aspect_initial_width:width;
        int fitH=mini_aspect_initial_height>0?mini_aspect_initial_height:height;
        MiniContentSize fit=mini_fit_content(fitW,fitH,ratio,hints.min_width,hints.min_height,maxW,maxH);
        int x,y;gtk_window_get_position(window,&x,&y);
        int newX=MAX(work.x,MIN(x,work.x+work.width-(int)(fit.width+chromeW)));
        int newY=MAX(work.y,MIN(y,work.y+work.height-(int)(fit.height+chromeH)));
        if ((int)fit.width!=width || (int)fit.height!=height) gtk_window_resize(window,(int)fit.width,(int)fit.height);
        if (x!=newX || y!=newY) gtk_window_move(window,newX,newY);
        mini_aspect_initial_width=mini_aspect_initial_height=0;
    }
    return TRUE;
}

static gboolean mini_aspect_window_state(GtkWidget *widget,GdkEventWindowState *event,gpointer unused) {
    mini_aspect_apply_gtk(GTK_WINDOW(widget),mini_aspect_suspended);
    return FALSE;
}
static void mini_aspect_release_request(MiniAspectRequest *r) {
    if (g_atomic_int_dec_and_test(&r->refs)) { g_mutex_clear(&r->mutex);g_cond_clear(&r->done);g_free(r); }
}
static gboolean mini_aspect_change_gtk(gpointer data) {
    MiniAspectRequest *r=data;
    g_mutex_lock(&r->mutex);
    if (!r->cancelled) {
        if (r->width==0 && r->height==0) {
            if (mini_aspect_window) {
                if (!gtk_widget_in_destruction(GTK_WIDGET(mini_aspect_window))) {
                    if (mini_aspect_state_handler) g_signal_handler_disconnect(mini_aspect_window,mini_aspect_state_handler);
                    gtk_window_set_geometry_hints(mini_aspect_window,NULL,NULL,0);
                }
                g_object_unref(mini_aspect_window);
            }
            mini_aspect_window=NULL;mini_aspect_state_handler=0;mini_aspect_suspended=FALSE;
            mini_aspect_initial_width=mini_aspect_initial_height=0;r->ok=TRUE;
        } else if (r->width>0 && r->height>0 && r->width<=32768 && r->height<=32768 &&
                   r->width<=r->height*10 && r->height<=r->width*10) {
            if (!mini_aspect_window) {
                GList *windows=gtk_window_list_toplevels();
                for (GList *p=windows;p;p=p->next) {
                    if (mini_aspect_has_webview(p->data)) { mini_aspect_window=g_object_ref(p->data);break; }
                }
                g_list_free(windows);
                if (mini_aspect_window) mini_aspect_state_handler=g_signal_connect(mini_aspect_window,"window-state-event",G_CALLBACK(mini_aspect_window_state),NULL);
            }
            if (mini_aspect_window && !gtk_widget_in_destruction(GTK_WIDGET(mini_aspect_window))) {
                mini_aspect_width=r->width;mini_aspect_height=r->height;
                if (r->initial_width>0 && r->initial_height>0 && r->initial_width<=32768 && r->initial_height<=32768) {
                    mini_aspect_initial_width=r->initial_width;mini_aspect_initial_height=r->initial_height;
                }
                r->ok=mini_aspect_apply_gtk(mini_aspect_window,r->refit);
            }
        }
        r->complete=TRUE;g_cond_signal(&r->done);
    }
    g_mutex_unlock(&r->mutex);
    mini_aspect_release_request(r);
    return G_SOURCE_REMOVE;
}
static int set_mini_aspect_geometry(int width,int height,int refit,int initial_width,int initial_height) {
    MiniAspectRequest *r=g_new0(MiniAspectRequest,1);
    g_mutex_init(&r->mutex);g_cond_init(&r->done);r->refs=2;r->width=width;r->height=height;r->refit=refit;
    r->initial_width=initial_width;r->initial_height=initial_height;
    g_idle_add(mini_aspect_change_gtk,r);
    g_mutex_lock(&r->mutex);
    gint64 deadline=g_get_monotonic_time()+2*G_TIME_SPAN_SECOND;
    while (!r->complete && g_cond_wait_until(&r->done,&r->mutex,deadline)) {}
    int ok=r->complete&&r->ok;r->cancelled=TRUE;
    g_mutex_unlock(&r->mutex);mini_aspect_release_request(r);
    return ok;
}
static int set_mini_aspect(int width,int height,int refit) {
    return set_mini_aspect_geometry(width,height,refit,0,0);
}
#endif
