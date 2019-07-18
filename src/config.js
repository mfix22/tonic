const ms = require('ms')
const { Context } = require('probot')
const merge = require('lodash.merge')

const { CLOSE, MERGE, LABEL } = require('./constants')

const TIME = process.env.NODE_ENV === 'production' ? '7 days' : '10s'

const CONFIG_FILE = 'ranger.yml'

const defaultConfig = {
  default: {
    [CLOSE]: {
      comment: '⚠️ This has been marked to be closed in $DELAY.',
      delay: ms(TIME)
    }
  },
  labels: {
    duplicate: CLOSE,
    wontfix: CLOSE,
    invalid: CLOSE,
    'squash when passing': MERGE,
    'rebase when passing': MERGE,
    'merge when passing': MERGE
  },
  comments: [],
  commits: [
    {
      action: LABEL,
      pattern: '/merge when passing/i',
      labels: ['merge when passing']
    }
  ]
}

exports.CONFIG_FILE = CONFIG_FILE

function createEvent(context, owner, repo) {
  const newContext = merge({}, context)
  newContext.payload.repository.owner.login = owner
  newContext.payload.repository.owner.name = owner
  newContext.payload.repository.name = repo
  return newContext
}

function createGlobalConfig(context, owner, repo) {
  const globalContext = new Context(createEvent(context, owner, repo), context.github)
  return globalContext.config(CONFIG_FILE, defaultConfig)
}

module.exports = async context => {
  let config = await context.config(CONFIG_FILE, defaultConfig)

  if (typeof config.uses === 'string' && config.uses.indexOf('/') > -1) {
    const [owner, repo] = config.uses.trim().split('/')
    config = await createGlobalConfig(context, owner, repo)
  }

  if (typeof config.extends === 'string' && config.extends.indexOf('/') > -1) {
    const [owner, repo] = config.extends.trim().split('/')
    const globalConfig = await createGlobalConfig(context, owner, repo)
    config = merge(globalConfig, config)
  }

  // merge defaults
  config.default = merge({}, defaultConfig.default, config.default)

  return config
}

// console.log(require('js-yaml').safeDump(defaultConfig))
