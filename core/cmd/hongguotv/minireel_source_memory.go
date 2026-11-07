package main

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

type miniReelProvider string

const (
	miniReelTabProvider     miniReelProvider = "video_tab"
	miniReelLegacyProvider  miniReelProvider = "multi_video_model"
	miniReelSingleProvider  miniReelProvider = "video_model"
	miniReelSourceMemoryTTL                  = 30 * time.Minute
	miniReelSourceMemoryMax                  = 128
)

var miniReelSourceMemory = newMiniReelSourceMemory()

type miniReelSourceObservation struct {
	provider miniReelProvider
	expires  time.Time
	ticket   uint64
}

// Process-local hints only: no URLs, identities, account data or disk writes.
// Tickets keep late completion/cancellation of an older episode from replacing
// newer evidence. Empty observations retain that boundary after invalidation.
type miniReelSourceMemoryStore struct {
	sync.Mutex
	entries map[string]miniReelSourceObservation
	ticket  uint64
	now     func() time.Time
}

type miniReelSourcePlan struct {
	memory *miniReelSourceMemoryStore
	key    string
	ticket uint64
	order  [3]miniReelProvider
}

func newMiniReelSourceMemory() *miniReelSourceMemoryStore {
	return &miniReelSourceMemoryStore{entries: make(map[string]miniReelSourceObservation), now: time.Now}
}

func miniReelSourceMemoryKey(seriesID, codecMode, contentType, quality string, fallback bool) string {
	if !miniReelIDRE.MatchString(seriesID) {
		return ""
	}
	return strings.Join([]string{seriesID, codecMode, contentType, quality, strconv.FormatBool(fallback)}, "\x00")
}

func (m *miniReelSourceMemoryStore) plan(key string) miniReelSourcePlan {
	p := miniReelSourcePlan{order: [3]miniReelProvider{miniReelTabProvider, miniReelLegacyProvider, miniReelSingleProvider}}
	if m == nil || key == "" {
		return p
	}
	m.Lock()
	defer m.Unlock()
	m.ticket++
	p.memory, p.key, p.ticket = m, key, m.ticket
	now := m.now()
	for key, entry := range m.entries {
		if !now.Before(entry.expires) {
			delete(m.entries, key)
		}
	}
	if entry, ok := m.entries[key]; ok && entry.provider != "" {
		p.order[0] = entry.provider
		i := 1
		for _, provider := range []miniReelProvider{miniReelTabProvider, miniReelLegacyProvider, miniReelSingleProvider} {
			if provider != entry.provider {
				p.order[i] = provider
				i++
			}
		}
	}
	return p
}

func (p miniReelSourcePlan) observe(provider miniReelProvider, success bool) {
	if p.memory == nil || provider == "" {
		return
	}
	m := p.memory
	m.Lock()
	defer m.Unlock()
	entry := m.entries[p.key]
	if entry.ticket > p.ticket || !success && entry.provider != provider {
		return
	}
	if !success {
		provider = ""
	}
	m.entries[p.key] = miniReelSourceObservation{provider: provider, expires: m.now().Add(miniReelSourceMemoryTTL), ticket: p.ticket}
	if len(m.entries) > miniReelSourceMemoryMax {
		var oldest string
		var ticket uint64 = ^uint64(0)
		for key, entry := range m.entries {
			if entry.ticket < ticket {
				oldest, ticket = key, entry.ticket
			}
		}
		delete(m.entries, oldest)
	}
}
