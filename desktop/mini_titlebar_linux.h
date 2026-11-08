#include <gtk/gtk.h>

typedef struct {
    GMutex mutex;
    GCond done;
    gint refs;
    gboolean hidden, complete, cancelled, ok;
} MiniTitlebarRequest;
static GtkWindow *mini_titlebar_window;
static gboolean mini_titlebar_decorated;

static gboolean has_wails_webview_box(GtkWidget *widget) {
    if (g_strcmp0(gtk_widget_get_name(widget), "webview-box") == 0) return TRUE;
    if (!GTK_IS_CONTAINER(widget)) return FALSE;
    GList *children = gtk_container_get_children(GTK_CONTAINER(widget));
    gboolean found = FALSE;
    for (GList *p = children; p && !found; p = p->next) found = has_wails_webview_box(GTK_WIDGET(p->data));
    g_list_free(children);
    return found;
}
static void release_mini_titlebar_request(MiniTitlebarRequest *r) {
    if (g_atomic_int_dec_and_test(&r->refs)) {
        g_mutex_clear(&r->mutex); g_cond_clear(&r->done); g_free(r);
    }
}
static gboolean change_mini_titlebar(gpointer data) {
    MiniTitlebarRequest *r = data;
    g_mutex_lock(&r->mutex);
    if (!r->cancelled) {
        GtkWindow *window = mini_titlebar_window;
        if (!window && r->hidden) {
            GList *windows = gtk_window_list_toplevels();
            for (GList *p = windows; p; p = p->next) {
                if (has_wails_webview_box(GTK_WIDGET(p->data))) { window = GTK_WINDOW(p->data); break; }
            }
            if (window) {
                mini_titlebar_window = g_object_ref(window);
                mini_titlebar_decorated = gtk_window_get_decorated(window);
            }
            g_list_free(windows);
        }
        if (window && !gtk_widget_in_destruction(GTK_WIDGET(window))) {
            gtk_window_set_decorated(window, r->hidden ? FALSE : mini_titlebar_decorated);
            r->ok = gtk_window_get_decorated(window) == (r->hidden ? FALSE : mini_titlebar_decorated);
            if (r->ok && !r->hidden) { g_object_unref(mini_titlebar_window); mini_titlebar_window = NULL; }
        } else if (!r->hidden && !mini_titlebar_window) r->ok = TRUE;
        r->complete = TRUE;
        g_cond_signal(&r->done);
    }
    g_mutex_unlock(&r->mutex);
    release_mini_titlebar_request(r);
    return G_SOURCE_REMOVE;
}
static int set_mini_titlebar_hidden(int hidden) {
    MiniTitlebarRequest *r = g_new0(MiniTitlebarRequest, 1);
    g_mutex_init(&r->mutex); g_cond_init(&r->done);
    r->refs = 2; r->hidden = hidden;
    g_idle_add(change_mini_titlebar, r);
    g_mutex_lock(&r->mutex);
    gint64 deadline = g_get_monotonic_time() + 2 * G_TIME_SPAN_SECOND;
    while (!r->complete && g_cond_wait_until(&r->done, &r->mutex, deadline)) {}
    int ok = r->complete && r->ok;
    r->cancelled = TRUE; // A timed-out callback must not change the window later.
    g_mutex_unlock(&r->mutex);
    release_mini_titlebar_request(r);
    return ok;
}
