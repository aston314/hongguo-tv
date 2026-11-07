/* Run against the pinned Android libmpv in CI, without the app or a GPU.
 * Generated HEVC fixtures exercise real decoding, not the host's FFmpeg.
 */
#include <mpv/client.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static int option(mpv_handle *player, const char *name, const char *value) {
    int result = mpv_set_option_string(player, name, value);
    if (result < 0) fprintf(stderr, "%s: %s\n", name, mpv_error_string(result));
    return result;
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    FILE *report = fopen(argv[2], "w");
    if (!report) return 2;
    mpv_handle *player = mpv_create();
    if (!player) return 3;
    const char *options[][2] = {
        {"config", "no"}, {"terminal", "no"}, {"hwdec", "no"},
        {"vo", "null"}, {"ao", "null"}, {"audio", "no"}, {"sid", "no"},
        {"pause", "no"}, {"untimed", "yes"}, {"keep-open", "yes"}, {"frames", "8"}
    };
    int result = 1;
    for (size_t i = 0; i < sizeof(options) / sizeof(options[0]); i++)
        if (option(player, options[i][0], options[i][1]) < 0) goto done;
    if (mpv_initialize(player) < 0) goto done;
    mpv_request_log_messages(player, "warn");
    const char *command[] = {"loadfile", argv[1], "replace", NULL};
    if (mpv_command(player, command) < 0) goto done;
    time_t deadline = time(NULL) + 60;
    while (time(NULL) < deadline) {
        mpv_event *event = mpv_wait_event(player, 0.25);
        if (event->event_id == MPV_EVENT_LOG_MESSAGE) {
            mpv_event_log_message *log = event->data;
            fprintf(stderr, "%s: %s", log->prefix, log->text);
        }
        if (event->event_id == MPV_EVENT_END_FILE) {
            mpv_event_end_file *end = event->data;
            if (end->error < 0) {
                fprintf(stderr, "decode failed: %s\n", mpv_error_string(end->error));
                goto done;
            }
        }
        double position = 0;
        if (mpv_get_property(player, "time-pos", MPV_FORMAT_DOUBLE, &position) < 0 || position < 0.6) continue;
        int64_t frame = 0;
        // video-codec is a descriptive decoder label; video-format is the
        // stable codec identifier ("hevc") used by the demuxed track.
        char *codec = mpv_get_property_string(player, "video-format");
        char *hardware = mpv_get_property_string(player, "hwdec-current");
        char *format = mpv_get_property_string(player, "video-dec-params/pixelformat");
        mpv_get_property(player, "estimated-frame-number", MPV_FORMAT_INT64, &frame);
        int software = hardware && strcmp(hardware, "no") == 0;
        result = !(codec && strcmp(codec, "hevc") == 0 && software &&
                   format && strcmp(format, "yuv420p") == 0 && position >= 0.6 && frame >= 6);
        fprintf(report, "{\"codec\":\"%s\",\"hwdec_current\":\"%s\",\"pixel_format\":\"%s\","
               "\"position_seconds\":%.3f,\"estimated_frame_number\":%lld,\"passed\":%s}\n",
               codec ? codec : "", hardware ? hardware : "", format ? format : "",
               position, (long long)frame, result ? "false" : "true");
        mpv_free(codec);
        mpv_free(hardware);
        mpv_free(format);
        goto done;
    }
    fprintf(stderr, "software decoding did not reach the frame limit\n");
done:
    if (result && ftell(report) == 0) fprintf(report, "{\"passed\":false,\"error\":\"no decoded frame progress\"}\n");
    fclose(report);
    mpv_terminate_destroy(player);
    return result;
}
