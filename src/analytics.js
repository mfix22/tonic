const Analytics = require('analytics-node')

if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'production') {
  let analytics = new Analytics(process.env.SEGMENT_WRITE_KEY)
  module.exports = {
    identify: analytics.identify,
    track: x => {
      try {
        return analytics.track(typeof x === 'function' ? x() : x)
      } catch (error) {
        console.error(error)
      }
    }
  }
} else {
  module.exports = {
    track: () => {},
    identify: () => {},
    dev: true
  }
}
