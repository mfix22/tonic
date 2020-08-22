const { LABEL, MAINTAINERS } = require('../constants')
const getConfig = require('../config')
const { executeAction, testPattern } = require('../util')
const { addLabels } = require('../api')

function isMaintainer(association) {
  return MAINTAINERS.includes(association)
}

module.exports = () => async (context) => {
  const config = await getConfig(context)

  const {
    head: { sha },
    author_association,
  } = context.payload.pull_request

  if (!isMaintainer(author_association)) return

  const {
    data: {
      commit: { message: body },
    },
  } = await context.github.repos.getCommit(context.repo({ ref: sha }))

  // TODO confirm this API before releasing in docs
  const rules = config.commits

  if (!Array.isArray(rules)) return

  await Promise.all(
    rules.map(async ({ action, pattern, user, labels } = {}) => {
      return executeAction(action, {
        [LABEL]: () => {
          if (!labels) return

          if (pattern && !testPattern(pattern, body)) {
            return
          }

          if (
            user &&
            !testPattern(user.toLowerCase(), context.payload.pull_request.user.login.toLowerCase())
          ) {
            return
          }

          return addLabels(context.github, context.issue({ labels }))
        },
      })
    })
  )
}
