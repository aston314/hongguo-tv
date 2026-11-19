// Bundle only explicit playback modules; never bundle the account/provider stores.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/dop251/goja/ast"
	"github.com/dop251/goja/parser"
)

func mustRead(path string) []byte {
	b, e := os.ReadFile(path)
	if e != nil {
		panic(e)
	}
	return b
}
func pure(path string, names []string, prefix string) []byte {
	source := mustRead(path)
	p, e := parser.ParseFile(nil, path, source, 0)
	if e != nil {
		panic(e)
	}
	call := p.Body[0].(*ast.ExpressionStatement).Expression.(*ast.CallExpression)
	body := call.Callee.(*ast.FunctionLiteral).Body.List
	declarations := map[string]*ast.FunctionLiteral{}
	for _, s := range body {
		if d, ok := s.(*ast.FunctionDeclaration); ok {
			declarations[d.Function.Name.Name.String()] = d.Function
		}
	}
	var out strings.Builder
	out.WriteString("'use strict';\n" + prefix + "\n")
	for _, name := range names {
		f := declarations[name]
		if f == nil {
			panic("missing allowlisted function " + name)
		}
		out.Write(source[int(f.Idx0())-1 : int(f.Idx1())-1])
		out.WriteString("\n")
	}
	out.WriteString("module.exports={")
	for _, name := range names {
		fmt.Fprintf(&out, "%s:%s,", name, name)
	}
	out.WriteString("ua:typeof UA==='undefined'?'':UA};\n")
	return []byte(out.String())
}
func main() {
	check := flag.Bool("check", false, "reject stale generated bundle")
	flag.Parse()
	account := mustRead("webos/service/account.js")
	ua := regexp.MustCompile(`(?m)^  var UA = ([^\n]+);`).FindSubmatch(account)
	if len(ua) != 2 {
		panic("missing account UA")
	}
	modules := []struct {
		name string
		data []byte
	}{
		{"crypto", mustRead("core/internal/jsresolver/source/crypto.js")},
		{"zlib", []byte(`module.exports={gzipSync:function(b,o){return __resolverHost.gzip(b,o&&o.level!=null?o.level:-1)},gunzipSync:function(b){return __resolverHost.gunzip(b)}};`)},
		{"passport-sign", mustRead("webos/service/passport-sign.js")},
		{"playback-v5-sign", mustRead("webos/service/playback-v5-sign.js")},
		{"playback-v5-carrier", mustRead("webos/service/playback-v5-carrier.js")},
		{"playback-v5-constants.json", append(append([]byte("module.exports="), mustRead("webos/service/playback-v5-constants.json")...), ';')},
		{"mobile-playback-v5", mustRead("webos/service/mobile-playback-v5.js")},
		{"device-pure", pure("webos/service/account.js", strings.Fields("trim str validID fail parseExactJSON uuid device appQuery sortedQuery le32 protocolDevicePayload deviceKey ttEncrypt ttDecrypt"), "var crypto=require('crypto'),zlib=require('zlib'),UA="+string(ua[1])+";")},
		{"model-pure", pure("webos/service/provider.js", strings.Fields("trim number fail parseExactJSON bitCount base36 decodeSpade modelString modelRows asMap businessCode modelURL isByteVC2 onlyByteVC2 sameFallbackVideo fallbackCodecURL fallbackAPI"), "var crypto=require('crypto');")},
		{"resolver", mustRead("core/internal/jsresolver/source/resolver.js")},
	}
	var out bytes.Buffer
	out.WriteString("// Generated playback-only bundle; do not edit.\n// V5/signing sources: webos/service (GPL-3.0-only portions; see THIRD_PARTY_NOTICES.md).\n(function(){'use strict';var factories=Object.create(null),cache=Object.create(null);\n")
	out.Write(mustRead("core/internal/jsresolver/source/buffer-compat.js"))
	for _, m := range modules {
		name, _ := json.Marshal(m.name)
		fmt.Fprintf(&out, "factories[%s]=function(module,exports,require){\n%s\n};\n", name, m.data)
	}
	out.WriteString(`function require(name){if(name.slice(0,2)==='./')name=name.slice(2);if(name==='buffer')return {Buffer:Buffer};if(cache[name])return cache[name].exports;if(!factories[name])throw new Error('module unavailable');var m={exports:{}};cache[name]=m;factories[name](m,m.exports,require);return m.exports;}return require('resolver');})()`)
	// Parse before committing a generated artifact, including its embedded modules.
	if _, e := parser.ParseFile(nil, "resolver.js", out.Bytes(), 0); e != nil {
		panic(e)
	}
	path := "core/internal/jsresolver/resolver.js"
	if *check {
		if !bytes.Equal(mustRead(path), out.Bytes()) {
			panic("stale JS resolver bundle; run go run ./scripts/resolver_js_codegen")
		}
		return
	}
	if e := os.WriteFile(path, out.Bytes(), 0644); e != nil {
		panic(e)
	}
	fmt.Printf("Bundled %d playback modules, %d bytes\n", len(modules), out.Len())
}
