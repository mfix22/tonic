/*
 * context.issue() is used for both issues and PRs
 */
const ms = require('ms')
const getId = require('../get-job-id')
const getConfig = require('../config')
const { COMMENT } = require('../constants')

const { timeToNumber } = require('../issue/util')

// TODO use `getLabelConfig` from util
function getLabelConfig(config, labelName) {
  if (typeof config.labels[labelName] === 'object') {
    return config.labels[labelName]
  }

  if (config.default && config.default.comment) {
    return config.default.comment
  }

  return {}
}

module.exports = queue => async context => {
  const ID = getId(context, { action: COMMENT })

  const thread = context.payload.pull_request || context.payload.issue

  const config = await getConfig(context)

  const commentableLabels = thread.labels.filter(l => {
    if (typeof config.labels !== 'object') return false
    if (!config.labels[l.name]) return false

    const action =
      typeof config.labels[l.name] === 'string'
        ? config.labels[l.name]
        : config.labels[l.name].action

    return action && action.trim().toLowerCase() === COMMENT
  })

  commentableLabels.forEach(async label => {
    const jobId = `${ID}:${label.name}`
    const jobExists = await queue.getJob(jobId)

    // Don't create a comment if one already exists
    if (!jobExists) {
      const { message, delay } = getLabelConfig(config, label.name)

      const time = delay ? timeToNumber(delay, 0) : 0

      if (message && message.trim() !== 'false') {
        const body = message
          .replace('$LABEL', label.name)
          .replace('$DELAY', ms(time, { long: true }))

        await queue
          .createJob(
            context.repo({
              installation_id: context.payload.installation.id,
              action: COMMENT,
              body,
              [context.payload.pull_request ? 'pull_number' : 'issue_number']: thread.number
            })
          )
          .setId(jobId)
          .delayUntil(Date.now() + time)
          .save()
      }
    }
  })
}

module.exports.process = robot => async ({ data /* id */ }) => {
  try {
    const github = await robot.auth(data.installation_id)
    return await github.issues.createComment(data)
  } catch (e) {
    robot.log.error(e)
  }
}
