'use strict';

require('./runtime-compat');

// jsservicelauncher requires package.main from its bootstrap module. This
// entry must register Luna methods even when it is not require.main. Keep the
// injectable factory separate so tests and HTTP-direct previews stay passive.
module.exports = require('./service')();
