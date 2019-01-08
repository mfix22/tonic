const ms = require('ms')

const getId = require('../get-job-id')
const getConfig = require('../config')
const { MERGE } = require('../constants')

const { getPullRequest } = require('../api')

const RETRY_PERIOD = ms('3m')
const RETRY_HORIZON = ms('12h')

// https://developer.github.com/v4/enum/mergestatestatus/
const status = {
  BEHIND: 'behind', // sometimes good to merge, depending on repo config
  BLOCKED: 'blocked', // cannot merge
  CLEAN: 'clean', // good to go 👍
  DIRTY: 'dirty', // merge conflicts
  HAS_HOOKS: 'has_hooks', // good-to-go, even with extra checks
  UNKNOWN: 'unknown', // in between states
  UNSTABLE: 'unstable' // can merge, but build is failing 🚫
}

module.exports = queue => async context => {
  const ID = getId(context, { action: MERGE })

  const thread = context.payload.pull_request

  if (thread.state === 'closed') {
    return
  }

  const jobExists = await queue.getJob(ID)

  if (jobExists) {
    // restart job if new label event occurs
    queue.removeJob(ID)
  }

  const config = await getConfig(context)
  const withMergeableLabels = thread.labels.filter(l => {
    if (!config.labels[l.name]) return false

    const action =
      typeof config.labels[l.name] === 'string'
        ? config.labels[l.name]
        : config.labels[l.name].action

    return action && action.trim().toLowerCase() === MERGE
  })

  if (withMergeableLabels.length) {
    return queue
      .createJob({
        ...context.issue({ installation_id: context.payload.installation.id }),
        action: MERGE
      })
      .setId(ID)
      .retries(RETRY_HORIZON / RETRY_PERIOD)
      .backoff('fixed', RETRY_PERIOD)
      .save()
  }

  // If closable labels are removed, delete job for this pull
  return queue.removeJob(ID)
}

module.exports.process = robot => async ({ data: { installation_id, owner, repo, number } }) => {
  let github
  let pull
  try {
    github = await robot.auth(installation_id)

    pull = await getPullRequest(github, { owner, repo, number })
  } catch (error) {
    robot.log.error(error)
    // Don't retry if auth or fetch fail
    return
  }

  const isMergeable =
    pull.mergeable &&
    !pull.merged &&
    (pull.mergeable_state === status.CLEAN || pull.mergeable_state === status.HAS_HOOKS)

  if (isMergeable) {
    await github.pullRequests.merge({
      owner,
      repo,
      number,
      sha: pull.head.sha
      /*
      merge_method: merge | rebase | squash
      commit_title,
      commit_message,
      */
    })
  } else if (pull.mergeable_state === status.DIRTY) {
    // don't retry if there are merge conflicts
    return
  } else {
    throw new Error('Retry job')
  }
}
