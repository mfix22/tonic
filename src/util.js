const r = require('rexrex')

module.exports.executeAction = function executeAction(action, map) {
  if (typeof action !== 'string') return

  const handler = map[action.trim().toLowerCase()]

  if (handler) {
    return handler()
  }
}

const MATCHES_NOTHING = r.and(r.matchers.END, r.matchers.START)
function parseRegex(string) {
  // https://stackoverflow.com/questions/874709/converting-user-input-string-to-regular-expression
  const match = String(string).match(new RegExp('^/(.*?)/([gimy]*)$'))

  if (match && match[1] && match[2]) {
    return new RegExp(match[1], match[2])
  }

  // matches nothing
  return r.regex(MATCHES_NOTHING)
}

module.exports.testPattern = function testPattern(pattern, string) {
  // TODO consider changing includes to ===
  return string.includes(pattern) || parseRegex(pattern).test(string)
}
