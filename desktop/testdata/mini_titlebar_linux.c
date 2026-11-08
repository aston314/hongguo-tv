#include "../mini_titlebar_linux.h"
#include <stdio.h>

static GtkWidget *window, *content;
static int failed;
static GAsyncQueue *checks;
static void require(int value, const char *message) {
    if (!value) { fprintf(stderr, "%s\n", message); failed = 1; }
}
static gboolean inspect_hidden(gpointer unused) {
    require(mini_titlebar_window != NULL, "missing original window snapshot");
    require(!gtk_window_get_decorated(GTK_WINDOW(window)), "native decoration still visible");
    require(gtk_window_get_resizable(GTK_WINDOW(window)), "resizing disabled");
    require(gtk_bin_get_child(GTK_BIN(window)) == content, "content replaced");
    g_async_queue_push(checks, GINT_TO_POINTER(1));
    return G_SOURCE_REMOVE;
}
static gboolean finish_checks(gpointer unused) { gtk_main_quit(); return G_SOURCE_REMOVE; }
static gpointer check_window(gpointer unused) {
    for (int i = 0; i < 3; i++) {
        require(set_mini_titlebar_hidden(1), "cannot hide GTK titlebar");
        g_main_context_invoke(NULL, inspect_hidden, NULL);
        g_async_queue_pop(checks);
        require(set_mini_titlebar_hidden(0), "cannot restore GTK titlebar");
    }
    g_main_context_invoke(NULL, finish_checks, NULL);
    return NULL;
}
int main(int argc, char **argv) {
    if (!gtk_init_check(&argc, &argv)) return 77;
    window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_default_size(GTK_WINDOW(window), 480, 300);
    content = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
    gtk_widget_set_name(content, "webview-box");
    gtk_container_add(GTK_CONTAINER(window), content);
    gtk_widget_show_all(window);
    checks = g_async_queue_new();
    GThread *worker = g_thread_new("titlebar-check", check_window, NULL);
    gtk_main();
    g_thread_join(worker);
    require(gtk_window_get_decorated(GTK_WINDOW(window)), "original GTK titlebar not restored");
    require(gtk_bin_get_child(GTK_BIN(window)) == content, "content changed on restoration");
    gtk_widget_destroy(window);
    g_async_queue_unref(checks);
    return failed;
}
