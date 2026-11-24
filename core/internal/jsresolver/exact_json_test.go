package jsresolver

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

func TestExactJSONPreservesIDsAndStringContent(t *testing.T) {
	r := newTest(t, noHTTP)
	cases := []struct{ input, expected string }{
		{`{"id":7704857946630409240,"negative":-7704857946630409240,"small":123,"fraction":1.234,"exponent":1.23e18}`, `{"id":"7704857946630409240","negative":"-7704857946630409240","small":123,"fraction":1.234,"exponent":1.23e18}`},
		{`{"url":"https://example.invalid/7704857946630409240?sig=abc","nested":"{\"id\":7704857946630409240}","escaped":"quote\" 7704857946630409240 backslash\\","text":"中文 😃"}`, `{"url":"https://example.invalid/7704857946630409240?sig=abc","nested":"{\"id\":7704857946630409240}","escaped":"quote\" 7704857946630409240 backslash\\","text":"中文 😃"}`},
		{`[null,true,false,0,-1,999999999999999,9999999999999999,1e20,1234567890123456.5,1234567890123456e2]`, `[null,true,false,0,-1,999999999999999,"9999999999999999",1e20,1234567890123456.5,1234567890123456e2]`},
	}
	for _, module := range []string{"device", "model"} {
		for _, tc := range cases {
			var actual string
			e := r.run(context.Background(), func() error {
				r.vm.Set("__exactAPI", r.api.Get("test"))
				r.vm.Set("__exactInput", tc.input)
				v, e := r.vm.RunString("JSON.stringify(__exactAPI." + module + ".parseExactJSON(__exactInput))")
				if e == nil {
					actual = v.String()
				}
				return e
			})
			if e != nil {
				t.Fatal(e)
			}
			var got, want any
			if json.Unmarshal([]byte(actual), &got) != nil || json.Unmarshal([]byte(tc.expected), &want) != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("%s exact JSON result mismatch", module)
			}
		}
	}
}

func TestExactJSONRejectsMalformedInput(t *testing.T) {
	r := newTest(t, noHTTP)
	for _, input := range []string{`{"id":`, `{"text":"bad\x20"}`, `{"a":true} {"b":false}`, `{"n":1e}`, `{"n":.25}`, `{"n":-}`, `{"text":"unterminated 1234567890123456}`} {
		e := r.run(context.Background(), func() error {
			r.vm.Set("__exactAPI", r.api.Get("test"))
			r.vm.Set("__exactInput", input)
			_, e := r.vm.RunString("__exactAPI.model.parseExactJSON(__exactInput)")
			return e
		})
		if e == nil {
			t.Fatal("malformed JSON accepted")
		}
	}
}
