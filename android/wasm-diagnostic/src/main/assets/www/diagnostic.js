(function () {
  'use strict';

  var deviceNode = document.getElementById('device');
  var capabilitiesNode = document.getElementById('capabilities');
  var buttons = document.querySelectorAll('.test-buttons button');
  var screenNode = document.getElementById('screen');
  var statusNode = document.getElementById('status');
  var overallNode = document.getElementById('overall');
  var rangeNode = document.getElementById('range-state');
  var resultsNode = document.getElementById('results');
  var reportNode = document.getElementById('report');
  var latest = [];
  var activeWorker = null;
  var running = false;

  function deviceInfo() {
    var info = {};
    try {
      if (window.HongguoWasmDiag && window.HongguoWasmDiag.getDeviceInfo) {
        info = JSON.parse(window.HongguoWasmDiag.getDeviceInfo());
      }
    } catch (ignored) {}
    info.ua = navigator.userAgent || '不可读取';
    info.viewport = window.innerWidth + 'x' + window.innerHeight;
    info.dpr = window.devicePixelRatio || 1;
    return info;
  }

  function item(label, value) {
    var node = document.createElement('div');
    node.className = 'device-item';
    var title = document.createElement('strong');
    title.appendChild(document.createTextNode(label));
    node.appendChild(title);
    node.appendChild(document.createTextNode(value || '未知'));
    return node;
  }

  function showDevice() {
    var info = deviceInfo();
    var entries = [
      ['设备', (info.manufacturer || '') + ' ' + (info.model || '浏览器')],
      ['Android / API', (info.android || '非 Android') + (info.api ? ' / ' + info.api : '')],
      ['System WebView', info.webview || '浏览器内核'],
      ['ABI / 屏幕', (info.abi || '未知') + ' / ' + (info.screen || info.viewport)],
      ['WebView 视口', info.viewport],
      ['设备像素比', String(info.dpr)],
      ['浏览器标识', info.ua]
    ];
    deviceNode.innerHTML = '';
    for (var i = 0; i < entries.length; i++) deviceNode.appendChild(item(entries[i][0], entries[i][1]));

    var webglCanvas = document.createElement('canvas');
    var canvas2d = document.createElement('canvas');
    var gl = null;
    try { gl = webglCanvas.getContext('webgl2'); } catch (ignoredGL) {}
    var context2d = null;
    try { context2d = canvas2d.getContext('2d'); } catch (ignored2d) {}
    var caps = [
      ['Worker', typeof Worker !== 'undefined'],
      ['WebAssembly', typeof WebAssembly !== 'undefined'],
      ['WebGL2', !!gl],
      ['Canvas 2D', !!context2d]
    ];
    capabilitiesNode.innerHTML = '';
    for (var j = 0; j < caps.length; j++) {
      var cap = document.createElement('span');
      cap.className = 'capability ' + (caps[j][1] ? 'ok' : 'fail');
      cap.appendChild(document.createTextNode(caps[j][0] + '：' + (caps[j][1] ? '可用' : '不可用')));
      capabilitiesNode.appendChild(cap);
    }
    overallNode.innerHTML = '设备信息已读取';
    updateReport();
  }

  function addResult(label, value) {
    var node = document.createElement('div');
    node.className = 'result-item';
    var heading = document.createElement('strong');
    heading.appendChild(document.createTextNode(label));
    node.appendChild(heading);
    node.appendChild(document.createTextNode(value));
    resultsNode.appendChild(node);
  }

  function updateReport() {
    var info = deviceInfo();
    var ua = info.ua || '未知';
    if (ua.length > 160) ua = ua.substring(0, 157) + '...';
    var lines = [
      '设备：' + ((info.manufacturer || '') + ' ' + (info.model || '未知')),
      'Android/API：' + (info.android || '未知') + '/' + (info.api || '未知'),
      'WebView：' + (info.webview || '未知'),
      'WebView：' + info.viewport + ' CSS px，DPR ' + info.dpr,
      'UA：' + ua,
      '能力：' + capabilitiesNode.innerText.replace(/\s+/g, ' ').trim(),
      'HTTP 206 Range：' + rangeCount() + ' 次',
      '本地服务最近请求：' + lastRequest(),
      '测试：' + (latest.length ? latest.join('；') : '尚未运行')
    ];
    reportNode.value = lines.join('\n');
    try {
      if (window.HongguoWasmDiag && window.HongguoWasmDiag.setPageReport) {
        window.HongguoWasmDiag.setPageReport(reportNode.value);
      }
    } catch (ignoredReport) {}
    rangeNode.innerHTML = 'Range 请求 ' + rangeCount() + ' 次';
  }

  function rangeCount() {
    try {
      if (window.HongguoWasmDiag && window.HongguoWasmDiag.getRangeRequestCount) {
        return window.HongguoWasmDiag.getRangeRequestCount();
      }
    } catch (ignored) {}
    return 0;
  }

  function lastRequest() {
    try {
      if (window.HongguoWasmDiag && window.HongguoWasmDiag.getLastRequest) {
        return window.HongguoWasmDiag.getLastRequest();
      }
    } catch (ignored) {}
    return '不可读取';
  }

  function makeWebGL(canvas) {
    var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 不可用');
    var vertex = '#version 300 es\nin vec2 position; out vec2 uv; void main(){ uv=vec2((position.x+1.0)*0.5,(1.0-position.y)*0.5); gl_Position=vec4(position,0.0,1.0); }';
    var fragment = '#version 300 es\nprecision highp float; in vec2 uv; uniform sampler2D yTex; uniform sampler2D uTex; uniform sampler2D vTex; uniform int fullRange; out vec4 color; void main(){ float y=texture(yTex,uv).r; float u=texture(uTex,uv).r-0.5; float v=texture(vTex,uv).r-0.5; if(fullRange==0){ y=(y-0.0627451)*1.1643836; u*=1.1383929; v*=1.1383929; } color=vec4(clamp(y+1.596027*v,0.0,1.0),clamp(y-0.391762*u-0.812968*v,0.0,1.0),clamp(y+2.017232*u,0.0,1.0),1.0); }';
    function compile(type, source) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    }
    var program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    var names = ['yTex', 'uTex', 'vTex'];
    var textures = [];
    for (var i = 0; i < names.length; i++) {
      var texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, names[i]), i);
      textures.push(texture);
    }
    return { canvas: canvas, gl: gl, program: program, textures: textures };
  }

  function drawWebGL(target, message) {
    var gl = target.gl;
    var width = message.w;
    var height = message.h;
    var ySize = width * height;
    var cSize = (width >> 1) * (height >> 1);
    var bytes = new Uint8Array(message.buf);
    var planes = [bytes.subarray(0, ySize), bytes.subarray(ySize, ySize + cSize), bytes.subarray(ySize + cSize)];
    var sizes = [[width, height], [width >> 1, height >> 1], [width >> 1, height >> 1]];
    target.canvas.width = width;
    target.canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.uniform1i(gl.getUniformLocation(target.program, 'fullRange'), message.full ? 1 : 0);
    for (var i = 0; i < 3; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, target.textures[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, sizes[i][0], sizes[i][1], 0, gl.RED, gl.UNSIGNED_BYTE, planes[i]);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function drawCanvas(target, message) {
    var width = message.w;
    var height = message.h;
    var ySize = width * height;
    var cSize = (width >> 1) * (height >> 1);
    var bytes = new Uint8Array(message.buf);
    var image = target.context.createImageData(width, height);
    var rgba = image.data;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var index = y * width + x;
        var chroma = (y >> 1) * (width >> 1) + (x >> 1);
        var yy = bytes[index];
        var u = bytes[ySize + chroma] - 128;
        var v = bytes[ySize + cSize + chroma] - 128;
        if (!message.full) {
          yy = (yy - 16) * 255 / 219;
          u *= 255 / 224;
          v *= 255 / 224;
        }
        var out = index * 4;
        rgba[out] = clamp(yy + 1.5748 * v);
        rgba[out + 1] = clamp(yy - 0.1873 * u - 0.4681 * v);
        rgba[out + 2] = clamp(yy + 1.8556 * u);
        rgba[out + 3] = 255;
      }
    }
    target.canvas.width = width;
    target.canvas.height = height;
    target.context.putImageData(image, 0, 0);
  }

  function clamp(value) { return Math.max(0, Math.min(255, value)); }

  function sampleNonBlack(canvas, renderer, target) {
    var pixels;
    if (renderer === 'webgl') {
      pixels = new Uint8Array(canvas.width * canvas.height * 4);
      target.gl.readPixels(0, 0, canvas.width, canvas.height, target.gl.RGBA, target.gl.UNSIGNED_BYTE, pixels);
    } else {
      pixels = target.context.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    var sampled = 0;
    var visible = 0;
    for (var i = 0; i < pixels.length; i += 4 * 97) {
      sampled++;
      if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) visible++;
    }
    return sampled ? Math.round(visible * 100 / sampled) : 0;
  }

  function runTest(size, renderer) {
    if (running) return;
    running = true;
    resultsNode.innerHTML = '';
    statusNode.innerHTML = '正在启动 ' + size + 'p ' + (renderer === 'webgl' ? 'WebGL2' : 'Canvas 2D') + ' 测试…';
    overallNode.innerHTML = '测试进行中';
    screenNode.innerHTML = '<canvas></canvas>';
    var canvas = screenNode.getElementsByTagName('canvas')[0];
    var target;
    try {
      if (renderer === 'webgl') target = makeWebGL(canvas);
      else {
        var context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        if (!context) throw new Error('Canvas 2D 不可用');
        target = { canvas: canvas, context: context };
      }
    } catch (setupError) {
      running = false;
      showFailure(setupError.message);
      return;
    }

    var worker;
    var start = performance.now();
    var firstFrame = 0;
    var frames = 0;
    var meta = null;
    var timer = setInterval(function () {
      if (worker) worker.postMessage({ t: 'clock', at: (performance.now() - start) / 1000 });
    }, 50);
    var timeout = setTimeout(function () { finishError('测试超时'); }, 90000);

    function cleanup() {
      clearInterval(timer);
      clearTimeout(timeout);
      if (worker) {
        worker.terminate();
        worker = null;
      }
      running = false;
      activeWorker = null;
    }

    function finishError(message) {
      cleanup();
      showFailure(message);
    }

    try {
      worker = new Worker('/worker.js', { type: 'module' });
      activeWorker = worker;
    } catch (workerError) {
      finishError('模块 Worker 不可用：' + workerError.message);
      return;
    }

    worker.onerror = function (event) {
      finishError('Worker 错误：' + (event.message || '启动或执行失败'));
    };
    worker.onmessage = function (event) {
      var message = event.data || {};
      if (message.t === 'meta') {
        meta = message;
        statusNode.innerHTML = '媒体已识别：' + message.width + '×' + message.height + '，' + Math.round(message.duration * 100) / 100 + ' 秒';
      } else if (message.t === 'frame') {
        if (!firstFrame) firstFrame = performance.now();
        try {
          if (renderer === 'webgl') drawWebGL(target, message);
          else drawCanvas(target, message);
          frames++;
          if ((frames % 25) === 0) statusNode.innerHTML = '已解码并绘制 ' + frames + ' 帧';
          worker.postMessage({ t: 'credit', seq: message.seq, buf: message.buf }, [message.buf]);
        } catch (drawError) {
          finishError('画面绘制失败：' + drawError.message);
        }
      } else if (message.t === 'error') {
        finishError('软解失败：' + message.message);
      } else if (message.t === 'end') {
        var elapsed = performance.now() - start;
        var fps = elapsed > 0 ? frames * 1000 / elapsed : 0;
        var visible = 0;
        try { visible = sampleNonBlack(canvas, renderer, target); } catch (ignoredPixels) {}
        var result = size + 'p/' + renderer + '：' + frames + '帧，' + fps.toFixed(1) + ' FPS，首帧 ' + (firstFrame ? Math.round(firstFrame - start) : '-') + ' ms，非黑采样 ' + visible + '%';
        latest.push(result);
        cleanup();
        addResult('输入视频', meta ? meta.width + '×' + meta.height + ' / ' + Math.round(meta.duration) + ' 秒' : '未识别');
        addResult('输出帧', String(frames));
        addResult('处理速度', fps.toFixed(1) + ' FPS / 25 FPS');
        addResult('首帧 / 测试耗时', (firstFrame ? Math.round(firstFrame - start) + ' ms' : '-') + ' / ' + Math.round(elapsed) + ' ms');
        addResult('画面采样', visible + '% 非黑像素');
        addResult('HTTP Range', rangeCount() + ' 次');
        statusNode.innerHTML = frames ? '测试完成。FPS 高于 25 才表示该路径可能达到此样片的实时速度。' : '没有收到解码帧';
        overallNode.innerHTML = frames && visible > 0 ? '已输出画面' : '测试未通过';
        updateReport();
      }
    };
    worker.postMessage({ t: 'open', seq: 1, url: '/samples/hevc-' + size + 'p.mp4', at: 0 });
  }

  function showFailure(message) {
    latest.push(message);
    statusNode.innerHTML = message;
    overallNode.innerHTML = '测试未通过';
    updateReport();
  }

  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () {
      runTest(this.getAttribute('data-size'), this.getAttribute('data-renderer'));
    });
  }
  document.getElementById('refresh').addEventListener('click', showDevice);
  showDevice();
  if (buttons.length) buttons[0].focus();
}());