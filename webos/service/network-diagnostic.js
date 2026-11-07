'use strict';

// Fixed metadata only. Never copy a URL, certificate, hostname or error message.
module.exports = function (error) {
  var reason = error && error.network_reason;
  if (['dns', 'tls', 'timeout', 'refused', 'reset', 'unreachable', 'cancelled'].indexOf(reason) >= 0) return reason;
  var code = error && error.code;
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].indexOf(code) >= 0) return 'dns';
  if (['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].indexOf(code) >= 0) return 'tls';
  if (['UPSTREAM_TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].indexOf(code) >= 0) return 'timeout';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'].indexOf(code) >= 0) return 'unreachable';
  return '';
};
