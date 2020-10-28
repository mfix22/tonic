const ms = require('ms')
const Sentry = require('@sentry/node')

const { CLOSE, MERGE } = require('./constants')

const TIME = process.env.NODE_ENV === 'production' ? '7 days' : '10s'

const CONFIG_FILE = 'ranger.yml'

const defaultConfig = {
  default: {
    [CLOSE]: {
      comment: '⚠️ This has been marked to be closed in $DELAY.',
      delay: ms(TIME),
    },
  },
  labels: {
    duplicate: CLOSE,
    wontfix: CLOSE,
    invalid: CLOSE,
    'squash when passing': MERGE,
    'rebase when passing': MERGE,
    'merge when passing': MERGE,
  },
  comments: [],
  commits: [],
}

exports.CONFIG_FILE = CONFIG_FILE

// const mergeOptions = { arrayMerge: (destinationArray, sourceArray /* options */) => sourceArray }

module.exports = async (context) => {
  try {
    return await context.config(CONFIG_FILE, defaultConfig /* mergeOptions */)
  } catch (err) {
    const repo = context.repo()

    Sentry.configureScope((scope) => {
      scope.setUser({ id: context.payload.installation.id, username: repo.owner })
      Sentry.captureException(err)
    })

    if (err.name === 'YAMLException') {
      const { data: branch } = await context.github.repos.getBranch({
        ...repo,
        branch: context.payload.repository.default_branch,
      })

      const commit_sha = branch.commit.sha
      const body = `@${repo.owner} invalid YAML in \`ranger.yml\`:
\`\`\`
${err.message}
\`\`\`
`

      const { data: comments } = await context.github.repos.listCommentsForCommit({
        ...repo,
        commit_sha,
      })

      if (!comments.find((c) => c.body === body)) {
        await context.github.repos.createCommitComment(
          context.repo({
            commit_sha,
            body,
            path: '.github/ranger.yml',
            // position: err.mark.position,
            // line: err.mark.line
          })
        )
      }
    }

    throw err
  }
}

// console.log(require('js-yaml').safeDump(defaultConfig))
