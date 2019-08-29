// TODO use previews array: https://github.com/octokit/rest.js/tree/v16.18.0#api-previews

exports.closeIssue = function closeIssue(github, data) {
  const { owner, repo, number, state = 'closed' } = data

  return github.issues
    .update({
      owner,
      repo,
      issue_number: number,
      state,
      headers: {
        Accept: 'application/vnd.github.symmetra-preview+json'
      }
    })
    .then(_ => _.data)
    .catch(e => {
      console.log(e, data)
      throw e
    })
}

exports.getPullRequest = function getPullRequest(github, data) {
  const { owner, repo, number } = data

  return github.pullRequests
    .get({
      owner,
      repo,
      pull_number: number,
      headers: {
        Accept:
          'application/vnd.github.symmetra-preview+json,application/vnd.github.shadow-cat-preview+json'
      }
    })
    .then(_ => _.data)
    .catch(e => {
      console.log(e, data)
      throw e
    })
}

exports.createLabel = function createLabel(github, data) {
  const { owner, repo, name, color, description } = data

  return github.issues.createLabel({
    owner,
    repo,
    name,
    color,
    description,
    headers: {
      Accept: 'application/vnd.github.symmetra-preview+json'
    }
  })
}

exports.addLabels = function addLabels(github, { labels, number, ...data }) {
  return github.issues
    .addLabels({
      ...data,
      issue_number: number,
      labels: many(labels),
      headers: {
        Accept: 'application/vnd.github.symmetra-preview+json'
      }
    })
    .catch(e => {
      console.log(e, data)
      throw e
    })
}

function many(maybeArray) {
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray]
}
