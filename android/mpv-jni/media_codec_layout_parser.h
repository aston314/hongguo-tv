// SPDX-License-Identifier: MIT
#pragma once

#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>

namespace hongguo_mpv {

struct MediaCodecLayout {
    enum DecoderFamily : int64_t { DECODER_UNKNOWN = 0, DECODER_NVIDIA = 1, DECODER_SEC_AVC = 2, DECODER_OTHER = 3 };

    static constexpr size_t VALUE_COUNT = 15;
    static constexpr int64_t FORMAT_SEEN = 1LL << 0;
    static constexpr int64_t WIDTH_REPORTED = 1LL << 1;
    static constexpr int64_t HEIGHT_REPORTED = 1LL << 2;
    static constexpr int64_t STRIDE_REPORTED = 1LL << 3;
    static constexpr int64_t SLICE_HEIGHT_REPORTED = 1LL << 4;
    static constexpr int64_t COLOR_FORMAT_REPORTED = 1LL << 5;
    static constexpr int64_t CROP_AVAILABLE = 1LL << 6;
    static constexpr int64_t DECODER_KNOWN = 1LL << 7;
    static constexpr int64_t STRIDE_FALLBACK_AVAILABLE = 1LL << 8;
    static constexpr int64_t SLICE_FALLBACK_AVAILABLE = 1LL << 9;
    static constexpr int64_t STRIDE_OVERRIDDEN = 1LL << 10;
    static constexpr int64_t SLICE_HEIGHT_OVERRIDDEN = 1LL << 11;

    bool formatSeen = false;
    bool widthReported = false, heightReported = false, strideReported = false;
    bool sliceHeightReported = false, colorFormatReported = false, cropAvailable = false;
    bool decoderKnown = false, strideFallbackAvailable = false, sliceFallbackAvailable = false;
    bool strideOverridden = false, sliceHeightOverridden = false;
    int width = 0, height = 0, stride = 0, sliceHeight = 0, colorFormat = 0;
    int cropTop = 0, cropBottom = 0, cropLeft = 0, cropRight = 0;
    int displayWidth = 0, displayHeight = 0, strideFallback = 0, sliceHeightFallback = 0;
    DecoderFamily decoderFamily = DECODER_UNKNOWN;
    std::string decoderName;

    void reset() { *this = MediaCodecLayout(); }
    const std::string &safeDecoderName() const { return decoderName; }

    void parse(const char *prefix, const char *text) {
        if (!prefix || std::strcmp(prefix, "ffmpeg/video") != 0 || !text) return;
        static const char decoderPrefix[] = "Found decoder ";
        static const char formatPrefix[] = "Output MediaFormat changed to ";
        static const char cropPrefix[] = "Output crop parameters ";
        if (std::strncmp(text, decoderPrefix, sizeof(decoderPrefix) - 1) == 0) {
            parseDecoder(text + sizeof(decoderPrefix) - 1);
        } else if (std::strncmp(text, formatPrefix, sizeof(formatPrefix) - 1) == 0) {
            parseFormat(text + sizeof(formatPrefix) - 1);
        } else if (std::strncmp(text, cropPrefix, sizeof(cropPrefix) - 1) == 0) {
            parseCrop(text + sizeof(cropPrefix) - 1);
        }
    }

    std::array<int64_t, VALUE_COUNT> values() const {
        int64_t flags = 0;
        if (formatSeen) flags |= FORMAT_SEEN;
        if (widthReported) flags |= WIDTH_REPORTED;
        if (heightReported) flags |= HEIGHT_REPORTED;
        if (strideReported) flags |= STRIDE_REPORTED;
        if (sliceHeightReported) flags |= SLICE_HEIGHT_REPORTED;
        if (colorFormatReported) flags |= COLOR_FORMAT_REPORTED;
        if (cropAvailable) flags |= CROP_AVAILABLE;
        if (decoderKnown) flags |= DECODER_KNOWN;
        if (strideFallbackAvailable) flags |= STRIDE_FALLBACK_AVAILABLE;
        if (sliceFallbackAvailable) flags |= SLICE_FALLBACK_AVAILABLE;
        if (strideOverridden) flags |= STRIDE_OVERRIDDEN;
        if (sliceHeightOverridden) flags |= SLICE_HEIGHT_OVERRIDDEN;
        return {{flags, width, height, stride, sliceHeight, colorFormat, decoderFamily,
                 cropTop, cropBottom, cropLeft, cropRight, displayWidth, displayHeight,
                 strideFallback, sliceHeightFallback}};
    }

private:
    static bool integer(const char *&cursor, int minimum, int maximum, int &value) {
        while (*cursor == ' ' || *cursor == '\t') ++cursor;
        char *end = nullptr;
        long parsed = std::strtol(cursor, &end, 10);
        if (end == cursor || parsed < minimum || parsed > maximum) return false;
        value = static_cast<int>(parsed);
        cursor = end;
        return true;
    }

    static bool parseField(const std::string &text, const char *key, int minimum, int maximum, int &value) {
        size_t position = 0;
        const size_t keyLength = std::strlen(key);
        while ((position = text.find(key, position)) != std::string::npos) {
            if (position > 0) {
                const char previous = text[position - 1];
                if ((previous >= 'A' && previous <= 'Z') || (previous >= 'a' && previous <= 'z') ||
                    (previous >= '0' && previous <= '9') || previous == '_' || previous == '-') {
                    position += keyLength;
                    continue;
                }
            }
            const char *cursor = text.c_str() + position + keyLength;
            while (*cursor == ' ' || *cursor == '\t') ++cursor;
            if (*cursor != ':' && *cursor != '=') { position += keyLength; continue; }
            ++cursor;
            while (*cursor == ' ' || *cursor == '\t') ++cursor;
            if (std::strncmp(cursor, "int32(", 6) == 0) cursor += 6;
            else if (std::strncmp(cursor, "int64(", 6) == 0) cursor += 6;
            else if (*cursor == '(') ++cursor;
            if (!integer(cursor, minimum, maximum, value)) { position += keyLength; continue; }
            while (*cursor == ' ' || *cursor == '\t') ++cursor;
            if (*cursor == ')' || *cursor == ',' || *cursor == '}' || *cursor == '\0') return true;
            position += keyLength;
        }
        return false;
    }

    static bool consume(const char *&cursor, const char *literal) {
        const size_t length = std::strlen(literal);
        if (std::strncmp(cursor, literal, length) != 0) return false;
        cursor += length;
        return true;
    }

    static bool cropInteger(const char *&cursor, int &value) {
        return integer(cursor, -65536, 65536, value);
    }

    void parseDecoder(const char *text) {
        size_t length = 0;
        while (text[length] && text[length] != ' ' && text[length] != '\t' && text[length] != '\r' && text[length] != '\n') {
            const char c = text[length];
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-')) return;
            if (++length > 96) return;
        }
        if (length == 0) return;
        const std::string name(text, length);
        decoderName = name;
        decoderKnown = true;
        if (name.find("OMX.Nvidia.") == 0) decoderFamily = DECODER_NVIDIA;
        else if (name.find("OMX.SEC.avc.dec") != std::string::npos) decoderFamily = DECODER_SEC_AVC;
        else decoderFamily = DECODER_OTHER;
        computeFallbacks();
    }

    void parseFormat(const char *text) {
        // Replace the previous output format while preserving the decoder identity.
        const bool hadDecoder = decoderKnown;
        const DecoderFamily family = decoderFamily;
        const std::string name = decoderName;
        reset();
        decoderKnown = hadDecoder;
        decoderFamily = family;
        decoderName = name;
        const std::string format(text);
        formatSeen = true;
        widthReported = parseField(format, "width", 0, 65536, width);
        heightReported = parseField(format, "height", 0, 65536, height);
        strideReported = parseField(format, "stride", -65536, 65536, stride);
        sliceHeightReported = parseField(format, "slice-height", -65536, 65536, sliceHeight);
        colorFormatReported = parseField(format, "color-format", -1, 1048576, colorFormat);
        computeFallbacks();
    }

    void parseCrop(const char *text) {
        const char *cursor = text;
        int top = 0, bottom = 0, left = 0, right = 0, width = 0, height = 0;
        if (!consume(cursor, "top=") || !cropInteger(cursor, top) ||
            !consume(cursor, " bottom=") || !cropInteger(cursor, bottom) ||
            !consume(cursor, " left=") || !cropInteger(cursor, left) ||
            !consume(cursor, " right=") || !cropInteger(cursor, right) ||
            !consume(cursor, ", resulting dimensions width=") || !integer(cursor, 1, 65536, width) ||
            !consume(cursor, " height=") || !integer(cursor, 1, 65536, height)) return;
        cropTop = top; cropBottom = bottom; cropLeft = left; cropRight = right;
        displayWidth = width; displayHeight = height; cropAvailable = true;
    }

    void computeFallbacks() {
        strideFallbackAvailable = false;
        sliceFallbackAvailable = false;
        strideOverridden = decoderKnown && decoderFamily == DECODER_SEC_AVC;
        sliceHeightOverridden = decoderKnown && decoderFamily == DECODER_SEC_AVC;
        if ((!strideReported || stride <= 0) && decoderKnown && widthReported && width > 0 && decoderFamily != DECODER_SEC_AVC) {
            strideFallback = width;
            strideFallbackAvailable = true;
        }
        if (sliceHeight == 0) {
            if (decoderKnown && heightReported && height > 0 && decoderFamily == DECODER_NVIDIA) {
                sliceHeightFallback = (height + 15) & ~15;
                sliceFallbackAvailable = true;
            } else if (decoderKnown && heightReported && height > 0 && decoderFamily == DECODER_OTHER) {
                sliceHeightFallback = height;
                sliceFallbackAvailable = true;
            }
        }
    }
};

}  // namespace hongguo_mpv
