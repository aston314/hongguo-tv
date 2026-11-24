'use strict';

// Node 0.12's bundled roots predate G2 on six API hosts (2026-11-20) and
// the observed reading-video CDN family (2026-11-24). Do not change VM-wide trust or
// update proxies. Newer runtimes continue using their default roots.
var hosts = [
  'api5-normal-sinfonlineb.fqnovel.com',
  'api5-normal-sinfonlinea.fqnovel.com',
  'api5-normal-hl.fqnovel.com',
  'api5-normal-lq.fqnovel.com',
  'log.snssdk.com',
  'hongguoduanju.com'
];
// CDN responses rotate edge labels. All three observed edges validated the
// same *.qznovelvod.com -> RapidSSL G1 -> G2 chain. Match only the video labels,
// not arbitrary siblings, subdomains, suffix lookalikes or every media CDN.
var mediaHost = /^v[0-9]+(?:-[a-z0-9]+)*-reading-video\.qznovelvod\.com$/;
var root;
module.exports = function (options) {
  if (!/^0\.12\./.test(process.versions.node) ||
      options.protocol && options.protocol !== 'https:' ||
      hosts.indexOf(String(options.hostname || '').toLowerCase()) < 0 && !mediaHost.test(String(options.hostname || '').toLowerCase())) return options;
  if (!root) root = require('fs').readFileSync(require('path').join(__dirname, 'certs/digicert-global-root-g2.pem'), 'utf8');
  var result = Object.assign({}, options);
  // Explicit ca narrows this request's trust to G2; it does NOT append to the
  // default root store. No leaf/intermediate pinning or verification bypass.
  result.ca = [root];
  result.rejectUnauthorized = true;
  return result;
};
