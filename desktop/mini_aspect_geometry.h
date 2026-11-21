#ifndef HONGGUO_MINI_ASPECT_GEOMETRY_H
#define HONGGUO_MINI_ASPECT_GEOMETRY_H
#include <math.h>
typedef struct { double width, height; } MiniContentSize;
static inline MiniContentSize mini_fit_content(double width, double height, double ratio,
        double min_width, double min_height, double max_width, double max_height) {
    double longest = fmax(width, height);
    double target = ratio >= 1 ? longest : longest * ratio;
    double high = fmax(1, fmin(max_width, max_height * ratio));
    double low = fmin(high, fmax(min_width, min_height * ratio));
    double result = fmax(low, fmin(target, high));
    return (MiniContentSize){round(result), fmax(1, round(result / ratio))};
}
#endif
