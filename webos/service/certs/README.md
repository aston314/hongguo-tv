# Legacy upstream TLS trust

`digicert-global-root-g2.pem` is the unmodified public DigiCert Global Root G2
certificate, downloaded from the CA's official distribution:

https://cacerts.digicert.com/DigiCertGlobalRootG2.crt.pem

Official SHA-256 DER fingerprint:
`CB3CCBB76031E5E0138F8DD39A23F9DE47FFC35E43C1144CEA27D46A5AB1CB5F`

Source and validity (2013-08-01 to 2038-01-15):
https://knowledge.digicert.com/general-information/digicert-trusted-root-authority-certificates

On 2026-11-20, the six exact hosts listed in `../upstream-tls.js` presented
RapidSSL TLS RSA CA G1 -> DigiCert Global Root G2 chains. Official Node 0.12.2
failed with `SELF_SIGNED_CERT_IN_CHAIN`; current Node verified the chains.
The workaround is confined to Node 0.12 and these hosts. An explicit `ca`
replaces (rather than augments) the default roots for those requests. All other
hosts and newer Node versions keep their default trust configuration. Certificate
chain, expiry and hostname validation remain enabled. If these hosts migrate to
another CA, re-verify their chain before changing this scope. Never trust a
certificate downloaded from an unverified connection.
