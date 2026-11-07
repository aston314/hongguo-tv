'use strict';

// Local, bounded hints, never playback URLs or anonymous identities. A plan is
// frozen for one shared preparation job; later jobs cannot change its order.
module.exports = function createSourceMemory(clock) {
  var now = clock || Date.now, entries = Object.create(null), ticket = 0, generation = 0;
  var providers = ['video_tab', 'multi_video_model', 'video_model'];
  return {
    plan: function (key) {
      var at = now(), id = ++ticket, epoch = generation;
      Object.keys(entries).forEach(function (name) { if (at >= entries[name].expires) delete entries[name]; });
      var preferred = key && entries[key] && entries[key].provider;
      return {
        order: preferred ? [preferred].concat(providers.filter(function (name) { return name !== preferred; })) : providers.slice(),
        observe: function (provider, success) {
          if (epoch !== generation || !key || providers.indexOf(provider) < 0) return;
          var previous = entries[key];
          if (previous && (previous.ticket > id || !success && previous.provider !== provider) || !success && !previous) return;
          entries[key] = { provider: success ? provider : '', ticket: id, expires: now() + 30 * 60 * 1000 };
          var keys = Object.keys(entries);
          if (keys.length > 128) {
            keys.sort(function (a, b) { return entries[a].ticket - entries[b].ticket; });
            delete entries[keys[0]];
          }
        }
      };
    },
    clear: function () { generation++; entries = Object.create(null); }
  };
};
