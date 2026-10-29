// SPDX-License-Identifier: MIT
// Copyright (c) 2026 aston
#include <jni.h>
#include <cstdint>
#include <string>
#include <vector>
#include <mpv/client.h>

extern "C" int mpv_lavc_set_java_vm(void *vm);
namespace {
JavaVM *vm = nullptr;
struct Client { mpv_handle *mpv; jobject surface = nullptr; };
Client *client(jlong pointer) { return reinterpret_cast<Client *>(static_cast<intptr_t>(pointer)); }
void error(JNIEnv *env, const char *message) {
    jclass type = env->FindClass("java/lang/IllegalStateException");
    if (type) env->ThrowNew(type, message);
}
void check(JNIEnv *env, int result) { if (result < 0) error(env, mpv_error_string(result)); }
std::string string(JNIEnv *env, jstring value) {
    if (!value) { error(env, "Missing MPV argument"); return {}; }
    const char *chars = env->GetStringUTFChars(value, nullptr);
    if (!chars) return {};
    std::string result(chars); env->ReleaseStringUTFChars(value, chars); return result;
}
}
extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *runtime, void *) {
    vm = runtime; return JNI_VERSION_1_6;
}
#define JNI_METHOD(name) Java_rocks_aston_hongguotv_MPVLib_##name
extern "C" JNIEXPORT jlong JNICALL JNI_METHOD(nativeCreate)(JNIEnv *env, jclass) {
    if (!vm || mpv_lavc_set_java_vm(vm) < 0) { error(env, "Cannot register Java VM"); return 0; }
    mpv_handle *handle = mpv_create();
    if (!handle) { error(env, "Cannot create MPV"); return 0; }
    int status = mpv_request_log_messages(handle, "warn");
    if (status < 0) { mpv_terminate_destroy(handle); check(env, status); return 0; }
    return static_cast<jlong>(reinterpret_cast<intptr_t>(new Client{handle}));
}
extern "C" JNIEXPORT void JNICALL JNI_METHOD(nativeInit)(JNIEnv *env, jclass, jlong p) {
    check(env, mpv_initialize(client(p)->mpv));
}
extern "C" JNIEXPORT void JNICALL JNI_METHOD(nativeDestroy)(JNIEnv *env, jclass, jlong p) {
    Client *c = client(p); mpv_terminate_destroy(c->mpv);
    if (c->surface) env->DeleteGlobalRef(c->surface);
    delete c;
}
extern "C" JNIEXPORT jlongArray JNICALL JNI_METHOD(nativePoll)(JNIEnv *env, jclass, jlong p) {
    mpv_event *event = mpv_wait_event(client(p)->mpv, 0);
    if (event->event_id == MPV_EVENT_NONE) return nullptr;
    jlong values[5] = {event->event_id, static_cast<jlong>(event->reply_userdata), -1, 0, -1};
    if (event->event_id == MPV_EVENT_PROPERTY_CHANGE && event->data) {
        const auto *property = static_cast<mpv_event_property *>(event->data);
        if (property->format == MPV_FORMAT_FLAG && property->data)
            values[2] = *static_cast<int *>(property->data) != 0;
    } else if (event->event_id == MPV_EVENT_LOG_MESSAGE && event->data) {
        const auto *message = static_cast<mpv_event_log_message *>(event->data);
        // Classify locally. Raw logs can contain signed media URLs; never send
        // their text or arbitrary module names to Java, WebView or diagnostics.
        const std::string prefix = message->prefix ? message->prefix : "";
        values[2] = message->log_level;
        if (prefix == "vo" || prefix.rfind("vo/", 0) == 0) values[3] = 1;
        else if (prefix == "ao" || prefix.rfind("ao/", 0) == 0) values[3] = 2;
        else if (prefix == "vd" || prefix.rfind("vd/", 0) == 0) values[3] = 3;
        else if (prefix == "ad" || prefix.rfind("ad/", 0) == 0) values[3] = 4;
    } else if (event->event_id == MPV_EVENT_END_FILE && event->data) {
        const auto *end = static_cast<mpv_event_end_file *>(event->data);
        values[2] = end->reason; values[3] = end->error;
        values[4] = end->playlist_entry_id;
    } else if (event->event_id == MPV_EVENT_START_FILE && event->data) {
        const auto *start = static_cast<mpv_event_start_file *>(event->data);
        values[4] = start->playlist_entry_id;
    } else if (event->event_id == MPV_EVENT_COMMAND_REPLY) {
        values[2] = event->error;
    }
    jlongArray result = env->NewLongArray(5);
    if (result) env->SetLongArrayRegion(result, 0, 5, values);
    return result;
}
extern "C" JNIEXPORT void JNICALL JNI_METHOD(nativeObserve)(JNIEnv *env, jclass, jlong p, jint id, jstring name) {
    auto key = string(env, name); if (env->ExceptionCheck()) return;
    check(env, mpv_observe_property(client(p)->mpv, id, key.c_str(), MPV_FORMAT_FLAG));
}
extern "C" JNIEXPORT jint JNICALL JNI_METHOD(nativeOption)(JNIEnv *env, jclass, jlong p, jstring name, jstring value) {
    auto key = string(env, name); auto text = string(env, value);
    if (env->ExceptionCheck()) return MPV_ERROR_INVALID_PARAMETER;
    return mpv_set_option_string(client(p)->mpv, key.c_str(), text.c_str());
}
extern "C" JNIEXPORT void JNICALL JNI_METHOD(nativeSet)(JNIEnv *env, jclass, jlong p, jstring name, jstring value) {
    auto key = string(env, name); auto text = string(env, value); if (env->ExceptionCheck()) return;
    check(env, mpv_set_property_string(client(p)->mpv, key.c_str(), text.c_str()));
}
extern "C" JNIEXPORT jobject JNICALL JNI_METHOD(nativeDouble)(JNIEnv *env, jclass, jlong p, jstring name) {
    auto key = string(env, name); if (env->ExceptionCheck()) return nullptr;
    double value;
    if (mpv_get_property(client(p)->mpv, key.c_str(), MPV_FORMAT_DOUBLE, &value) < 0) return nullptr;
    jclass type = env->FindClass("java/lang/Double");
    return env->CallStaticObjectMethod(type, env->GetStaticMethodID(type, "valueOf", "(D)Ljava/lang/Double;"), value);
}
extern "C" JNIEXPORT jobject JNICALL JNI_METHOD(nativeFlag)(JNIEnv *env, jclass, jlong p, jstring name) {
    auto key = string(env, name); if (env->ExceptionCheck()) return nullptr;
    int value;
    if (mpv_get_property(client(p)->mpv, key.c_str(), MPV_FORMAT_FLAG, &value) < 0) return nullptr;
    jclass type = env->FindClass("java/lang/Boolean");
    return env->CallStaticObjectMethod(type, env->GetStaticMethodID(type, "valueOf", "(Z)Ljava/lang/Boolean;"), value != 0);
}
extern "C" JNIEXPORT jstring JNICALL JNI_METHOD(nativeString)(JNIEnv *env, jclass, jlong p, jstring name) {
    auto key = string(env, name); if (env->ExceptionCheck()) return nullptr;
    char *value = mpv_get_property_string(client(p)->mpv, key.c_str());
    if (!value) return nullptr;
    jstring result = env->NewStringUTF(value); mpv_free(value); return result;
}
extern "C" JNIEXPORT void JNICALL JNI_METHOD(nativeCommand)(JNIEnv *env, jclass, jlong p, jobjectArray args) {
    if (!args || env->GetArrayLength(args) < 1 || env->GetArrayLength(args) > 32) { error(env, "Invalid MPV command"); return; }
    std::vector<std::string> strings; strings.reserve(env->GetArrayLength(args));
    for (jsize i = 0; i < env->GetArrayLength(args); i++) {
        jstring arg = static_cast<jstring>(env->GetObjectArrayElement(args, i));
        strings.push_back(string(env, arg)); env->DeleteLocalRef(arg);
        if (env->ExceptionCheck()) return;
    }
    std::vector<const char *> argv;
    for (const auto &arg : strings) argv.push_back(arg.c_str()); argv.push_back(nullptr);
    check(env, mpv_command(client(p)->mpv, argv.data()));
}
extern "C" JNIEXPORT void JNICALL JNI_METHOD(nativeCommandAsync)(JNIEnv *env, jclass, jlong p, jlong requestId, jobjectArray args) {
    if (!args || env->GetArrayLength(args) < 1 || env->GetArrayLength(args) > 32) { error(env, "Invalid MPV command"); return; }
    std::vector<std::string> strings; strings.reserve(env->GetArrayLength(args));
    for (jsize i = 0; i < env->GetArrayLength(args); i++) {
        jstring arg = static_cast<jstring>(env->GetObjectArrayElement(args, i));
        strings.push_back(string(env, arg)); env->DeleteLocalRef(arg);
        if (env->ExceptionCheck()) return;
    }
    std::vector<const char *> argv;
    for (const auto &arg : strings) argv.push_back(arg.c_str()); argv.push_back(nullptr);
    check(env, mpv_command_async(client(p)->mpv, static_cast<uint64_t>(requestId), argv.data()));
}
extern "C" JNIEXPORT void JNICALL JNI_METHOD(nativeSurface)(JNIEnv *env, jclass, jlong p, jobject surface) {
    Client *c = client(p);
    jobject next = surface ? env->NewGlobalRef(surface) : nullptr;
    if (surface && !next) return;
    int64_t wid = static_cast<int64_t>(reinterpret_cast<intptr_t>(next));
    int status = mpv_set_option(c->mpv, "wid", MPV_FORMAT_INT64, &wid);
    if (status < 0) { if (next) env->DeleteGlobalRef(next); check(env, status); return; }
    if (c->surface) env->DeleteGlobalRef(c->surface);
    c->surface = next;
}
