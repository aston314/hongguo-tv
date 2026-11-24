// Keep numeric IDs exact without rebuilding every character of the input.
// Strings (including escaped quotes/backslashes) are consumed as one token, so
// digits inside URLs, signatures or nested JSON strings are never rewritten.
function parseExactJSON(text) {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\[\s\S])*"|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g, function (token) {
    return /^-?[0-9]{16,}$/.test(token) ? '"' + token + '"' : token;
  }));
}
