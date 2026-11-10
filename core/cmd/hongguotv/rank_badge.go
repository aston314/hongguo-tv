package main

import (
	"strings"
	"unicode"
)

// bookmall recommendation rows and the existing episode preload response use
// rec_type=9 for both ranks and heat. Require an explicit rank label, and keep
// only the public label, never its navigation schema, remote icon, tracking
// data or server-provided colors.
func rankBadge(object map[string]any) string {
	rows, _ := object["rec_tags"].([]any)
	for _, raw := range rows {
		tag, _ := asMap(raw)
		if asString(tag["rec_type"]) != "9" {
			continue
		}
		label, ok := tag["content"].(string)
		label = strings.TrimSpace(label)
		if !ok || !strings.Contains(label, "榜") || len([]rune(label)) > 80 || strings.ContainsAny(label, "<>/\\") {
			continue
		}
		if strings.IndexFunc(label, unicode.IsControl) < 0 {
			return label
		}
	}
	return ""
}
