package jsresolver

import _ "embed"

//go:embed testdata/signing-v5-wire.json
var signingVectors []byte

func SigningVectors() []byte { return append([]byte(nil), signingVectors...) }

const SigningVectorCount uint32 = 4
