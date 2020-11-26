const r = require('rexrex')

const getConfig = require('../config')
const { executeAction } = require('../util')
const { DELETE_BRANCH, TAG } = require('../constants')
const analytics = require('../analytics')

const digit = r.capture(r.extra(r.matchers.NUMBER))
const pattern = r.and(r.capture(r.repeat('v', 0, 1)), digit, '\\.', digit, '\\.', digit)

module.exports.deleteBranch = () => async (context) => {
  const thread = context.payload.pull_request

  if (thread.merged !== true) return
  // Don't delete branches from 'unknown repository's
  if (!thread.head.repo) return
  // Don't delete branches from forks
  if (thread.head.repo.fork === true) return

  const config = await getConfig(context)

  if (!Array.isArray(config.merges)) return

  await Promise.allSettled(
    config.merges.map(async (c) => {
      const action = c.action || c

      return executeAction(action, {
        [DELETE_BRANCH]: () => {
          return context.octokit.git
            .deleteRef(context.repo({ ref: `heads/${thread.head.ref}` }))
            .catch((e) => {
              // TODO this is because GitHub has already deleted the reference
              if (e.message !== 'Reference does not exist') {
                throw e
              }
            })
        },
      })
    })
  )
}

module.exports.createTag = () => async (context) => {
  const thread = context.payload.pull_request

  if (thread.merged !== true) return

  // Only create tags on "master"
  if (thread.base.ref !== context.payload.repository.default_branch) return

  const isMajor = thread.labels.find(({ name }) => name.toLowerCase().includes('major'))
  const isMinor = thread.labels.find(({ name }) => name.toLowerCase().includes('minor'))
  const isPatch = thread.labels.find(({ name }) => name.toLowerCase().includes('patch'))

  if (!(isMajor || isMinor || isPatch)) {
    const config = await getConfig(context)
    const isAutoPatch =
      Array.isArray(config.merges) &&
      config.merges.find((c) => {
        const value = c.action || c
        return typeof value === 'string' && value.trim().toLowerCase() === TAG
      })

    if (!isAutoPatch) return
  }

  const { data } = await context.octokit.repos.listTags(context.repo())

  if (!data || !data[0]) return

  const REX = r.regex(pattern)

  const matchedTag = data.find((d) => REX.exec(d.name))

  if (!matchedTag) return

  const match = REX.exec(matchedTag.name)

  const v = {
    v: match[1] || '',
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
  }

  let tag
  if (isMajor) {
    tag = `${v.v}${v.major + 1}.0.0`
  } else if (isMinor) {
    tag = `${v.v}${v.major}.${v.minor + 1}.0`
  } else {
    tag = `${v.v}${v.major}.${v.minor}.${v.patch + 1}`
  }

  const sha = thread.merge_commit_sha

  await context.octokit.git.createTag(
    context.repo({
      tag,
      type: 'commit',
      message: `${thread.title} (#${thread.number})`,
      object: sha,
    })
  )

  await context.octokit.git.createRef(
    context.repo({
      ref: `refs/tags/${tag}`,
      sha,
    })
  )

  analytics.track({
    userId: context.payload.installation.id,
    event: `Tag created`,
    properties: context.repo({
      tag,
      sha,
    }),
  })
}
