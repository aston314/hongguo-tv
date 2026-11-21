#include "../mini_aspect_linux.h"
#include "../mini_titlebar_linux.h"
#include <gdk/gdkx.h>
#include <X11/Xutil.h>
#include <stdio.h>

static GtkWidget *window,*content;
static GAsyncQueue *checks;
static int failed,expected_width=16,expected_height=9,expect_active=1,expect_compact;
static void require(int value,const char *message) { if (!value) { fprintf(stderr,"%s\n",message);failed=1; } }
static gboolean inspect(gpointer unused) {
    GdkWindow *native=gtk_widget_get_window(window);
    int width,height;gtk_window_get_size(GTK_WINDOW(window),&width,&height);
    if (expect_compact) require(width<=500 && height<=400,"entry refit used stale large-window dimensions");
    XSizeHints hints;long mask;
    require(XGetWMNormalHints(gdk_x11_display_get_xdisplay(gdk_window_get_display(native)),gdk_x11_window_get_xid(native),&hints,&mask),"missing native WM hints");
    if (expect_active) {
        require((hints.flags&PAspect)!=0,"native aspect hint missing");
        require((hints.flags&PBaseSize)!=0 && hints.base_width==0 && hints.base_height==0,"minimum size leaked into the aspect baseline");
        require(fabs((double)hints.min_aspect.x/hints.min_aspect.y-(double)expected_width/expected_height)<0.001,"wrong drag aspect hint");
        require(fabs((double)width*expected_height-(double)height*expected_width)<=MAX(expected_width,expected_height),"content does not match video aspect");
    } else require((hints.flags&PAspect)==0,"aspect leaked into normal window");
    require(gtk_bin_get_child(GTK_BIN(window))==content,"content widget replaced");
    require(gtk_window_get_resizable(GTK_WINDOW(window)),"native resizing disabled");
    g_async_queue_push(checks,GINT_TO_POINTER(1));return G_SOURCE_REMOVE;
}
static void inspect_later(void) { g_timeout_add(100,inspect,NULL);g_async_queue_pop(checks); }
static gboolean quit(gpointer unused) { gtk_main_quit();return G_SOURCE_REMOVE; }
static gpointer worker(gpointer unused) {
    // Actual geometry is deliberately still large. Entry must use the passed
    // resize request rather than observing that stale pre-configure rectangle.
    expected_width=1282;expected_height=720;expect_compact=1;
    require(set_mini_aspect_geometry(expected_width,expected_height,1,480,300),"could not fit requested entry size");inspect_later();
    expect_compact=0;
    require(set_mini_aspect(0,0,0),"entry constraint cleanup failed");
    for (int hidden=0;hidden<=1;hidden++) {
        require(set_mini_titlebar_hidden(hidden),"titlebar setup failed");
        for (int portrait=0;portrait<=1;portrait++) {
            expected_width=portrait?1080:1920;expected_height=portrait?1924:1080;
            require(set_mini_aspect(expected_width,expected_height,1),"could not set GTK aspect");inspect_later();
        }
    }
    require(set_mini_titlebar_hidden(0),"titlebar restore failed");
    require(set_mini_aspect(0,0,0),"could not clear GTK aspect");expect_active=0;inspect_later();
    g_main_context_invoke(NULL,quit,NULL);return NULL;
}
int main(int argc,char **argv) {
    if (!gtk_init_check(&argc,&argv)) return 77;
    if (!GDK_IS_X11_DISPLAY(gdk_display_get_default())) return 77;
    window=gtk_window_new(GTK_WINDOW_TOPLEVEL);gtk_window_set_default_size(GTK_WINDOW(window),1000,700);
    content=gtk_box_new(GTK_ORIENTATION_VERTICAL,0);gtk_widget_set_name(content,"webview-box");gtk_container_add(GTK_CONTAINER(window),content);gtk_widget_show_all(window);
    checks=g_async_queue_new();GThread *thread=g_thread_new("aspect-check",worker,NULL);
    gtk_main();g_thread_join(thread);
    require(gtk_window_get_decorated(GTK_WINDOW(window)),"titlebar not restored");
    // A callback which times out without a GTK loop must never apply later.
    require(!set_mini_aspect(16,9,1),"missing main-loop deadline");
    while (g_main_context_iteration(NULL,FALSE)) {}
    require(mini_aspect_window==NULL,"timed-out callback changed window later");
    gtk_widget_destroy(window);g_async_queue_unref(checks);return failed;
}
