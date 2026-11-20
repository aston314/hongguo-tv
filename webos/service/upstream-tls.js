'use strict';

// Node 0.12's bundled roots predate the G2 chain served by these six upstream
// hosts (verified 2026-11-20). Do not change the VM-wide trust store, media CDN
// or update proxy trust. Newer runtimes continue using their default roots.
var hosts = [
  'api5-normal-sinfonlineb.fqnovel.com',
  'api5-normal-sinfonlinea.fqnovel.com',
  'api5-normal-hl.fqnovel.com',
  'api5-normal-lq.fqnovel.com',
  'log.snssdk.com',
  'hongguoduanju.com'
];
var root;
module.exports = function (options) {
  if (!/^0\.12\./.test(process.versions.node) ||
      options.protocol && options.protocol !== 'https:' ||
      hosts.indexOf(String(options.hostname || '').toLowerCase()) < 0) return options;
  if (!root) root = require('fs').readFileSync(require('path').join(__dirname, 'certs/digicert-global-root-g2.pem'), 'utf8');
  var result = Object.assign({}, options);
  // Explicit ca narrows this request's trust to G2; it does NOT append to the
  // default root store. No leaf/intermediate pinning or verification bypass.
  result.ca = [root];
  result.rejectUnauthorized = true;
  return result;
};
