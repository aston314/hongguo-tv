// Bundle only explicit playback modules; never bundle the account/provider stores.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	goast "go/ast"
	"go/format"
	goparser "go/parser"
	"go/token"
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
func standardSM3() []byte {
	path := "core/cmd/hongguotv/passport_sign.go"
	src := mustRead(path)
	set := token.NewFileSet()
	f, e := goparser.ParseFile(set, path, src, 0)
	if e != nil {
		panic(e)
	}
	for _, d := range f.Decls {
		if fn, ok := d.(*goast.FuncDecl); ok && fn.Name.Name == "passportSM3" {
			body := string(src[set.Position(fn.Pos()).Offset:set.Position(fn.End()).Offset])
			body = strings.Replace(body, "func passportSM3(", "func sumSM3(", 1)
			out, e := format.Source([]byte("// Code generated from the existing standard SM3 primitive; DO NOT EDIT.\npackage jsresolver\nimport(\"encoding/binary\";\"math/bits\")\n" + body + "\n"))
			if e != nil {
				panic(e)
			}
			return out
		}
	}
	panic("missing standard SM3 primitive")
}
func passportModule() []byte {
	s := string(mustRead("webos/service/passport-sign.js"))
	at := strings.LastIndex(s, "  module.exports=")
	if at < 0 {
		panic("missing passport exports")
	}
	// Standard hash acceleration only. The protocol-specific branch selection,
	// F13/carrier math, signing state and request construction remain in JS.
	hook := `  var nativeSM3=false;
  try { crypto.createHash('sm3').update(Buffer.alloc(0)).digest(); nativeSM3=true;
    sm3=function(data){return crypto.createHash('sm3').update(data).digest();};
  } catch(unsupportedSM3) {} // Older JS hosts retain the existing pure-JS hash.
`
	s = s[:at] + hook + s[at:]
	s = strings.Replace(s, "module.exports={", "module.exports={nativeSM3:nativeSM3,", 1)
	return []byte(s)
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
		// The legacy character-by-character JSON preprocessor is quadratic in
		// Goja. Preserve its large-integer contract with tokenized JS instead.
		if name == "parseExactJSON" {
			out.Write(mustRead("core/internal/jsresolver/source/exact-json.js"))
			out.WriteString("\n")
			continue
		}
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
		{"passport-sign", passportModule()},
		{"playback-v5-sign", mustRead("webos/service/playback-v5-sign.js")},
		{"playback-v5-carrier", mustRead("webos/service/playback-v5-carrier.js")},
		{"playback-v5-constants.json", append(append([]byte("module.exports="), mustRead("webos/service/playback-v5-constants.json")...), ';')},
		{"mobile-playback-v5", mustRead("webos/service/mobile-playback-v5.js")},
		{"single-playback-profile", mustRead("webos/service/single-playback-profile.js")},
		{"single-registered-profile", mustRead("webos/service/single-registered-profile.js")},
		{"network-diagnostic", mustRead("webos/service/network-diagnostic.js")},
		{"device-pure", pure("webos/service/account.js", strings.Fields("trim str validID fail parseExactJSON uuid device appQuery sortedQuery le32 protocolDevicePayload deviceKey ttEncrypt ttDecrypt"), "var crypto=require('crypto'),zlib=require('zlib'),UA="+string(ua[1])+";")},
		{"model-pure", pure("webos/service/provider.js", strings.Fields("trim number fail parseExactJSON bitCount base36 decodeSpade modelString modelRows asMap businessCode modelURL isByteVC2 onlyByteVC2 sameFallbackVideo fallbackCodecURL fallbackAPI playbackQuery videoTabQuery decodeModel videoTabEnvelope videoTabEnvelopeExact"), "var crypto=require('crypto');")},
		{"official-playback", mustRead("core/internal/jsresolver/source/official-playback.js")},
		{"official-signing-vectors", append(append([]byte("module.exports="), mustRead("core/internal/jsresolver/testdata/signing-v5-official.json")...), ';')},
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
	sm3 := standardSM3()
	hashPath := "core/internal/jsresolver/sm3_generated.go"
	key := strings.TrimSpace(string(mustRead("core/internal/jsupdate/publickey.hex")))
	vectors := mustRead("core/internal/jsresolver/testdata/signing-v5-wire.json")
	var wireVectors any
	if e := json.Unmarshal(vectors, &wireVectors); e != nil {
		panic(e)
	}
	compactVectors, _ := json.Marshal(wireVectors)
	keyJSON, _ := json.Marshal(key)
	trust := []byte("// Generated public trust data; DO NOT EDIT. No private signing material.\n'use strict';\nmodule.exports={publicKey:" + string(keyJSON) + ",vectors:" + string(compactVectors) + "};\n")
	trustPath := "webos/service/playback-rule-trust.js"
	if *check {
		if !bytes.Equal(mustRead(path), out.Bytes()) {
			panic("stale JS resolver bundle; run go run ./scripts/resolver_js_codegen")
		}
		if !bytes.Equal(mustRead(hashPath), sm3) {
			panic("stale standard SM3 primitive")
		}
		if !bytes.Equal(mustRead(trustPath), trust) {
			panic("stale webOS resolver trust data")
		}
		return
	}
	if e := os.WriteFile(hashPath, sm3, 0644); e != nil {
		panic(e)
	}
	if e := os.WriteFile(path, out.Bytes(), 0644); e != nil {
		panic(e)
	}
	if e := os.WriteFile(trustPath, trust, 0644); e != nil {
		panic(e)
	}
	fmt.Printf("Bundled %d playback modules, %d bytes\n", len(modules), out.Len())
}
