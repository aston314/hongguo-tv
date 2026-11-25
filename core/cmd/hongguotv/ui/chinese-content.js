// Offline OpenCC 1.4.2 s2twp display conversion; see chinese-content/NOTICE.
(function (root) {
  'use strict';

  function load(buffer, index) {
    validate(buffer, index);
    function view(T, item) {
      return new T(buffer, item.offset, item.length);
    }
    var offsets = view(Uint32Array, index.valueOffsets),
      units = view(Uint16Array, index.valueUnits),
      dicts = {},
      has = Object.prototype.hasOwnProperty;
    for (var name in index.dicts) if (has.call(index.dicts, name)) {
      var d = index.dicts[name];
      dicts[name] = {
        starts: view(Uint32Array, d.starts),
        terminal: view(Uint32Array, d.terminal),
        edges: view(Uint16Array, d.edges)
      };
    }
    function lookup(name, s, pos) {
      var d = dicts[name],
        node = 0,
        best = 0,
        end = pos;
      for (var j = pos; j < s.length; j++) {
        var char = s.charCodeAt(j),
          lo = d.starts[node],
          hi = d.starts[node + 1] - 1,
          found = -1;
        while (lo <= hi) {
          var mid = lo + hi >>> 1,
            value = d.edges[mid];
          if (value === char) {
            found = mid;
            break;
          }
          if (value < char) lo = mid + 1;else hi = mid - 1;
        }
        if (found < 0) break;
        node = found + 1;
        if (d.terminal[node]) {
          best = d.terminal[node];
          end = j + 1;
        }
      }
      return best ? {
        end: end,
        id: best
      } : null;
    }
    function union(s, pos) {
      var a = lookup('STPhrases', s, pos),
        b = lookup('STPhrases_GeneratedFromRegionalPhrases', s, pos);
      return !a ? b : !b || a.end >= b.end ? a : b;
    }
    function value(id) {
      var a = offsets[id - 1],
        b = offsets[id],
        chunks = [];
      for (var p = a; p < b; p += 512) chunks.push(String.fromCharCode.apply(null, units.subarray(p, Math.min(b, p + 512))));
      return chunks.join('');
    }
    function charLength(s, i) {
      var c = s.charCodeAt(i),
        d = s.charCodeAt(i + 1);
      return c >= 55296 && c <= 56319 && d >= 56320 && d <= 57343 ? 2 : 1;
    }
    function cp(s, i) {
      var c = s.charCodeAt(i);
      return charLength(s, i) === 2 ? (c - 55296) * 1024 + s.charCodeAt(i + 1) - 56320 + 65536 : c;
    }
    function unmatchedLength(s, i) {
      // Parse ideographic description sequences without recursive JS calls.
      var pos = i,
        remaining = 1;
      while (pos < s.length && remaining) {
        var code = cp(s, pos),
          arity = code === 0x2ff2 || code === 0x2ff3 ? 3 : code >= 0x2ff0 && code <= 0x2ffd || code === 0x31ef ? 2 : code === 0x2ffe || code === 0x2fff ? 1 : 0;
        remaining += arity - 1;
        pos += charLength(s, pos);
      }
      return remaining ? charLength(s, i) : pos - i;
    }
    function convertWith(s, match) {
      var result = [],
        start = 0;
      for (var i = 0; i < s.length;) {
        var m = match(s, i);
        if (m) {
          if (start < i) result.push(s.slice(start, i));
          result.push(value(m.id));
          i = m.end;
          start = i;
        } else i += unmatchedLength(s, i);
      }
      if (start < s.length) result.push(s.slice(start));
      return result.join('');
    }
    function segments(s) {
      var result = [],
        start = 0;
      for (var i = 0; i < s.length;) {
        var m = union(s, i);
        if (m) {
          if (start < i) result.push(s.slice(start, i));
          result.push(s.slice(i, m.end));
          i = m.end;
          start = i;
        } else i += unmatchedLength(s, i);
      }
      if (start < s.length) result.push(s.slice(start));
      return result;
    }
    function first(s, i) {
      return union(s, i) || lookup('STCharacters', s, i);
    }
    function second(usePhrases) {
      return function (s, i) {
        return usePhrases && lookup('TWPhrases', s, i) || lookup('TWVariantsPhrases', s, i) || lookup('TWVariants', s, i);
      };
    }
    function normalize(s, i) {
      return lookup('CJK_Compatibility_Ideographs', s, i);
    }
    function converter(profile) {
      var last = second(profile === 's2twp');
      return function (input) {
        var s = convertWith(String(input), normalize),
          parts = segments(s),
          result = [];
        for (var i = 0; i < parts.length; i++) result.push(convertWith(convertWith(parts[i], first), last));
        return result.join('');
      };
    }
    return {
      converter: converter,
      bytes: buffer.byteLength
    };
  }
  // Data is bundled with the application. No remote translation or script is
  // fetched here. The source hashes and generated binary are checked in CI.
  function validate(buffer, index) {
    if (!buffer || !index || index.format !== 1 || index.config !== 's2twp' || index.byteLength !== buffer.byteLength || buffer.byteLength < 16) throw new Error('Invalid Chinese dictionary');
    var header = new DataView(buffer);
    if (header.getUint32(0, true) !== 0x43434748 || header.getUint32(4, true) !== 1 || header.getUint32(8, true) !== buffer.byteLength || new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new Error('Unsupported Chinese dictionary');
    function check(item, width) {
      if (!item || item.offset % width || item.offset < 16 || item.length < 1 || item.offset !== Math.floor(item.offset) || item.length !== Math.floor(item.length) || item.offset + item.length * width > buffer.byteLength) throw new Error('Invalid Chinese dictionary table');
    }
    check(index.valueOffsets, 4);
    check(index.valueUnits, 2);
    var names = ['CJK_Compatibility_Ideographs', 'STPhrases', 'STPhrases_GeneratedFromRegionalPhrases', 'STCharacters', 'TWPhrases', 'TWVariantsPhrases', 'TWVariants'];
    for (var i = 0; i < names.length; i++) {
      var d = index.dicts && index.dicts[names[i]];
      if (!d) throw new Error('Missing Chinese dictionary table');
      check(d.starts, 4);
      check(d.terminal, 4);
      check(d.edges, 2);
      if (d.starts.length !== d.terminal.length + 1 || d.edges.length !== d.terminal.length - 1) throw new Error('Invalid Chinese dictionary tree');
    }
  }
  function bundledAssets(done) {
    var requests = [],
      data = {},
      remaining = 2,
      finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      for (var i = 0; i < requests.length; i++) {
        requests[i].onload = requests[i].onerror = requests[i].ontimeout = null;
        if (error) try {
          requests[i].abort();
        } catch (ignored) {}
      }
      done(error, data.buffer, data.index);
    }
    function get(name, binary) {
      var xhr = new root.XMLHttpRequest();
      requests.push(xhr);
      xhr.open('GET', './chinese-content/' + (binary ? 's2twp.bin' : 'index.json'), true);
      if (binary) xhr.responseType = 'arraybuffer';
      xhr.timeout = 5000;
      xhr.onload = function () {
        if (finished) return;
        try {
          // Installed webOS apps load these packaged assets from file://.
          if (xhr.status !== 200 && !(xhr.status === 0 && root.location && root.location.protocol === 'file:')) throw new Error('Chinese dictionary asset unavailable');
          data[name] = binary ? xhr.response : JSON.parse(xhr.responseText);
          if (--remaining === 0) finish(null);
        } catch (error) {
          finish(error);
        }
      };
      xhr.onerror = xhr.ontimeout = function () {
        finish(new Error('Chinese dictionary asset unavailable'));
      };
      xhr.send();
    }
    try {
      get('index', false);
      get('buffer', true);
    } catch (error) {
      finish(error);
    }
    return function () {
      if (finished) return;
      finished = true;
      for (var i = 0; i < requests.length; i++) {
        requests[i].onload = requests[i].onerror = requests[i].ontimeout = null;
        try {
          requests[i].abort();
        } catch (ignored) {}
      }
    };
  }
  function create(options) {
    options = options || {};
    var document = options.document,
      locale = options.locale || function () {
        return 'zh-CN';
      };
    var loader = options.load || bundledAssets;
    var state = 'idle',
      generation = 0,
      converter = null,
      pending = null,
      cancel = null,
      resolvePending = null;
    var cache = Object.create(null),
      keys = [],
      chars = 0,
      calls = 0;
    var has = Object.prototype.hasOwnProperty,
      marker = 'data-chinese-content';
    function clearCache() {
      cache = Object.create(null);
      keys = [];
      chars = 0;
    }
    function text(raw) {
      var value = raw == null ? '' : String(raw);
      if (locale() !== 'zh-TW' || !converter || !value || value.length > 8192) return value;
      if (has.call(cache, value)) return cache[value];
      var output;
      try {
        output = converter(value);
        calls++;
      } catch (ignored) {
        converter = null;
        state = 'failed';
        clearCache();
        return value;
      }
      var size = value.length + output.length;
      if (size <= 65536) {
        while (keys.length && (keys.length >= 256 || chars + size > 65536)) {
          var old = keys.shift();
          chars -= old.length + cache[old].length;
          delete cache[old];
        }
        keys.push(value);
        cache[value] = output;
        chars += size;
      }
      return output;
    }
    function render(element) {
      var binding = element.__hongguoChineseContent;
      if (!binding) return;
      // Another renderer may have replaced a title with a loading/error label.
      // Never resurrect a stale drama name over that newer UI state.
      if (binding.text && element.textContent !== binding.text.last) binding.text = null;
      if (binding.text) {
        var output = locale() === 'zh-TW' && state === 'loading' ? '' : text(binding.text.raw);
        if (element.textContent !== output) element.textContent = output;
        binding.text.last = output;
        binding.text.locale = locale();
        binding.text.state = state;
      }
      for (var name in binding.attributes) if (has.call(binding.attributes, name)) {
        var entry = binding.attributes[name];
        if (element.getAttribute(name) !== entry.last) {
          delete binding.attributes[name];
          continue;
        }
        var value = text(entry.raw);
        if (value !== entry.last) element.setAttribute(name, value);
        entry.last = value;
      }
    }
    function refresh() {
      if (!document || !document.querySelectorAll) return;
      // Only on dictionary readiness / a locale change, never on focus or frames.
      var elements = document.querySelectorAll('[' + marker + ']');
      for (var i = 0; i < elements.length; i++) render(elements[i]);
    }
    function prepare() {
      if (locale() !== 'zh-TW' || state === 'ready' || state === 'failed') return Promise.resolve(state === 'ready');
      if (pending) return pending;
      state = 'loading';
      var token = generation;
      pending = new Promise(function (resolve) {
        resolvePending = resolve;
        cancel = loader(function (error, buffer, index) {
          if (token !== generation) return;
          try {
            if (error) throw error;
            converter = load(buffer, index).converter('s2twp');
            state = 'ready';
          } catch (ignored) {
            converter = null;
            state = 'failed';
          }
          cancel = null;
          resolvePending = null;
          refresh();
          resolve(state === 'ready');
        });
      });
      return pending;
    }
    function bindingFor(element) {
      var binding = element.__hongguoChineseContent;
      if (!binding) {
        binding = {
          text: null,
          attributes: Object.create(null)
        };
        element.__hongguoChineseContent = binding;
        element.setAttribute(marker, '');
      }
      return binding;
    }
    function setText(element, raw, preserve) {
      if (!element) return;
      var value = raw == null ? '' : String(raw),
        binding = bindingFor(element);
      if (preserve) {
        binding.text = null;
        if (element.textContent !== value) element.textContent = value;
        return;
      }
      if (binding.text && binding.text.raw === value && binding.text.last === element.textContent && binding.text.locale === locale() && binding.text.state === state) return;
      if (locale() === 'zh-TW') prepare();
      element.removeAttribute('data-i18n');
      binding.text = {
        raw: value,
        last: element.textContent
      };
      render(element);
    }
    function setAttribute(element, name, raw, preserve) {
      if (!element || name !== 'aria-label' && name !== 'title') return;
      var value = raw == null ? '' : String(raw),
        binding = bindingFor(element);
      if (preserve) {
        delete binding.attributes[name];
        element.setAttribute(name, value);
        return;
      }
      if (locale() === 'zh-TW') prepare();
      binding.attributes[name] = {
        raw: value,
        last: element.getAttribute(name)
      };
      render(element);
    }
    function changed() {
      if (locale() === 'zh-TW') prepare();else {
        generation++;
        if (cancel) cancel();
        if (resolvePending) resolvePending(false);
        cancel = resolvePending = pending = converter = null;
        state = 'idle';
        clearCache();
      }
      refresh();
    }
    return {
      prepare: prepare,
      text: text,
      setText: setText,
      setAttribute: setAttribute,
      localeChanged: changed,
      status: function () {
        return {
          state: state,
          cacheEntries: keys.length,
          cacheCharacters: chars,
          conversions: calls
        };
      }
    };
  }
  root.HongguoChineseContent = {
    loadDictionary: load,
    create: create
  };
  if (root.document && root.HongguoI18n) {
    root.HongguoContentText = create({
      document: root.document,
      locale: root.HongguoI18n.locale
    });
    root.HongguoI18n.onChange(root.HongguoContentText.localeChanged);
    root.HongguoContentText.prepare();
  }
  if (typeof module === 'object' && module.exports) module.exports = root.HongguoChineseContent;
})(typeof window !== 'undefined' ? window : this);
