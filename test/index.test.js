// You can import your modules
const { Application } = require('probot')
const app = require('..')

const payload = require('./fixtures/labeled')
const commentPayload = require('./fixtures/comment')
const addedPayload = require('./fixtures/added')
const createdPayload = require('./fixtures/created')

const wait = (delay = 0) => new Promise(resolve => setTimeout(resolve, delay))

class MockJob {
  constructor(data, queue) {
    this.queue = queue
    this.id = Math.random()
      .toString(36)
      .slice(2)
    this.data = data
    this.save = jest.fn(() => {
      let fn
      fn = async data => {
        try {
          await this.queue.processor(data)
        } catch (e) {
          if (this.retriesLeft) {
            await fn(this)
            // setTimeout(fn, this.retryDelay, this)
          }
        } finally {
          if (this.retriesLeft) {
            this.retriesLeft--
          }
        }
      }
      this.to = setTimeout(fn, Math.min(this.delay - Date.now(), 2147483647), this)
      return this
    })
    this.setId = jest.fn(id => {
      delete this.queue.jobs[this.id]
      this.id = id
      this.queue.jobs[this.id] = this
      return this
    })
    this.delayUntil = jest.fn(delay => {
      this.delay = delay
      return this
    })
    this.retries = jest.fn(retriesLeft => {
      this.retriesLeft = retriesLeft
      return this
    })
    this.backoff = jest.fn((retryFormat, retryDelay) => {
      this.retryFormat = retryFormat
      this.retryDelay = retryDelay
      return this
    })
  }
}

jest.mock(
  'bee-queue',
  () =>
    class MockQueue {
      constructor(name) {
        this.name = name
        this.jobs = {}
        this.process = jest.fn(fn => {
          this.processor = fn
        })
        this.on = jest.fn()
        this.getJob = jest.fn(id => {
          return this.jobs[id]
        })
        this.createJob = jest.fn(data => {
          const job = new MockJob(data, this)
          this.jobs[job.id] = job
          return job
        })
        this.removeJob = jest.fn(id => {
          delete this.jobs[id]
          return id
        })
      }
    }
)

const config = `
labels:
  duplicate:
    action: close
    delay: 5ms
    comment: $LABEL issue created! Closing in $DELAY . . .
  invalid: close
  wontfix:
    action: close
    delay: 10ms
    comment: false
  automerge:
    action: merge
  -1:
    action: close
    delay: -1
    comment: Test comment
  comment:
    action: comment
    message: beep
  comment2:
    action: comment
    message: boop

delay: 1ms

comment: This issue has been marked to be closed in $DELAY.
`

describe('Bot', () => {
  let robot
  let github
  let queue
  beforeEach(async () => {
    robot = new Application()
    const setup = await app(robot)
    queue = setup.queue

    github = {
      issues: {
        createComment: jest.fn(),
        createLabel: jest.fn(),
        update: jest.fn((_, data) => Promise.resolve({ data }))
      },
      pullRequests: {
        get: jest.fn().mockResolvedValue({
          data: {
            mergeable: true,
            mergeable_state: 'clean',
            head: { sha: 0 }
          }
        }),
        merge: jest.fn()
      },
      repos: {
        getContent: jest.fn(() => ({ data: { content: Buffer.from(config).toString('base64') } })),
        getContents: jest.fn(() => ({ data: { content: Buffer.from(config).toString('base64') } }))
      },
      apps: {
        listRepos: jest.fn().mockResolvedValue({
          data: {
            total_count: 5,
            repositories: Array(5).fill({
              private: true
            })
          }
        })
      }
    }
    robot.auth = () => Promise.resolve(github)
  })

  describe.each(['issue', 'pull_request'])('%s', threadType => {
    const name = threadType === 'pull_request' ? threadType : 'issues'
    const action = threadType === 'pull_request' ? 'merge' : 'close'

    test('Will not schedule a job for labels not defined in the config', async () => {
      await robot.receive(payload({ name, threadType, labels: ['not-a-valid-label'] }))
      await wait(20)

      expect(queue.createJob).not.toHaveBeenCalled()
    })

    test('Will not act if state is closed', async () => {
      await robot.receive(payload({ name, threadType, state: 'closed' }))
      await wait(20)

      expect(queue.createJob).not.toHaveBeenCalled()
      expect(queue.removeJob).not.toHaveBeenCalled()
    })

    test('Will remove the job if all actionable labels are removed', async () => {
      await robot.receive(payload({ name, threadType, labels: [] }))

      expect(queue.createJob).not.toHaveBeenCalled()
      expect(queue.removeJob).toHaveBeenCalledWith(`mfix22:test-issue-bot:7:${action}`)
    })

    test('Will comment for each actionable label', async () => {
      await robot.receive(payload({ name, threadType, labels: ['comment', 'comment2'] }))
      ;['beep', 'boop'].forEach(body => {
        expect(github.issues.createComment).toHaveBeenCalledWith({
          body,
          number: 7,
          owner: 'mfix22',
          repo: 'test-issue-bot'
        })
      })
    })
  })

  describe('issue', () => {
    test('Will schedule a job', async () => {
      await robot.receive(payload())
      await wait(20)

      expect(github.issues.createComment).toHaveBeenCalledWith({
        number: 7,
        owner: 'mfix22',
        repo: 'test-issue-bot',
        body: 'duplicate issue created! Closing in 5 ms . . .'
      })
      const data = {
        number: 7,
        owner: 'mfix22',
        repo: 'test-issue-bot',
        installation_id: 135737,
        action: 'close'
      }
      expect(queue.createJob).toHaveBeenCalledWith(data)
      expect(queue.jobs[Object.keys(queue.jobs)[0]].id).toBe('mfix22:test-issue-bot:7:close')
      expect(queue.jobs[Object.keys(queue.jobs)[0]].data).toEqual(data)
    })

    test('Will remove the job if an issue is closed', async () => {
      await robot.receive(payload({ action: 'closed', number: 9 }))

      expect(queue.createJob).not.toHaveBeenCalled()
      expect(queue.removeJob).toHaveBeenCalledWith('mfix22:test-issue-bot:9:close')
      expect(queue.removeJob).toHaveBeenCalledWith('mfix22:test-issue-bot:9:merge')
    })

    test('Labels with `true` config should take action', async () => {
      await robot.receive(payload({ labels: ['invalid'], number: 19 }))
      await wait(20)

      expect(github.issues.createComment).toHaveBeenCalled()
      expect(queue.createJob).toHaveBeenCalled()
    })

    test('Labels with `false` comment config should not send comment', async () => {
      await robot.receive(payload({ labels: ['wontfix'], number: 11 }))

      expect(github.issues.createComment).not.toHaveBeenCalled()
      expect(queue.createJob).toHaveBeenCalled()

      await wait(20)
      expect(github.issues.update).toHaveBeenCalledTimes(1)
    })

    test('If comment was sent, comment should not be sent again', async () => {
      await robot.receive(payload())
      await robot.receive(payload())

      expect(github.issues.createComment).toHaveBeenCalledTimes(1)

      await wait(20)
      expect(github.issues.update).toHaveBeenCalledTimes(2)
    })

    test('Using negative numbers for delay should not create a job', async () => {
      await robot.receive(payload({ labels: ['-1'], number: 11 }))

      expect(github.issues.createComment).toHaveBeenCalled()
      expect(queue.createJob).not.toHaveBeenCalled()
    })
  })

  describe('pull_request', () => {
    test('Will take action if a label has action `merge`', async () => {
      await robot.receive(
        payload({
          name: 'pull_request',
          threadType: 'pull_request',
          labels: ['automerge'],
          number: 7
        })
      )

      const data = {
        number: 7,
        owner: 'mfix22',
        repo: 'test-issue-bot',
        installation_id: 135737,
        action: 'merge'
      }

      expect(queue.createJob).toHaveBeenCalledWith(data)
      expect(queue.jobs[Object.keys(queue.jobs)[0]].id).toBe('mfix22:test-issue-bot:7:merge')
      expect(queue.jobs[Object.keys(queue.jobs)[0]].data).toEqual(data)

      await wait(2)

      expect(github.pullRequests.merge).toHaveBeenCalledWith({
        number: 7,
        owner: 'mfix22',
        repo: 'test-issue-bot',
        sha: 0
      })
    })

    test('Will not merge a pull request with state `dirty`', async () => {
      github.pullRequests.get.mockResolvedValue({
        data: {
          mergeable: true,
          mergeable_state: 'dirty',
          head: { sha: 0 }
        }
      })

      await robot.receive(
        payload({
          name: 'pull_request',
          threadType: 'pull_request',
          labels: ['automerge'],
          number: 98
        })
      )

      await wait(20)

      expect(github.pullRequests.merge).not.toHaveBeenCalled()
    })

    test('Will retry job if merge is blocked until it is clean', async () => {
      github.pullRequests.get
        .mockResolvedValueOnce({
          data: {
            mergeable: true,
            mergeable_state: 'blocked',
            head: { sha: 0 }
          }
        })
        .mockResolvedValueOnce({
          data: {
            mergeable: true,
            mergeable_state: 'clean',
            head: { sha: 0 }
          }
        })

      await robot.receive(
        payload({
          name: 'pull_request',
          threadType: 'pull_request',
          labels: ['automerge'],
          number: 97
        })
      )
      expect(github.pullRequests.merge).not.toHaveBeenCalled()

      expect(queue.jobs['mfix22:test-issue-bot:97:merge'].retryFormat).toBe('fixed')

      await wait(20)
      expect(github.pullRequests.merge).toHaveBeenCalledWith({
        number: 97,
        owner: 'mfix22',
        repo: 'test-issue-bot',
        sha: 0
      })
    })

    test('Will remove the existing job if a new label event occurs', async () => {
      github.pullRequests.get.mockResolvedValue({
        data: {
          mergeable: false,
          mergeable_state: 'clean',
          head: { sha: 0 }
        }
      })

      queue.jobs['mfix22:test-issue-bot:99:merge'] = true

      await robot.receive(
        payload({
          name: 'pull_request',
          threadType: 'pull_request',
          labels: ['automerge'],
          number: 99
        })
      )

      expect(queue.removeJob).toHaveBeenCalledWith('mfix22:test-issue-bot:99:merge')
    })
  })

  describe('comment', () => {
    test('Will remove the job if the comment is deleted', async () => {
      const number = 55

      await robot.receive(commentPayload({ number }))

      expect(queue.createJob).not.toHaveBeenCalled()
      expect(queue.removeJob).toHaveBeenCalledWith(`mfix22:test-issue-bot:${number}:close`)
      expect(queue.removeJob).toHaveBeenCalledWith(`mfix22:test-issue-bot:${number}:merge`)
    })
  })

  describe('installation', () => {
    test.each([
      repos => addedPayload({ repositories_added: repos }),
      repos => createdPayload({ repositories: repos })
    ])('Will take action when repos are added', async createPayload => {
      const repos = [{ name: 'ranger-0' }, { name: 'ranger-1' }]

      await robot.receive(createPayload(repos))

      repos.forEach(({ name: repo }) => {
        expect(github.issues.createLabel).toHaveBeenCalledWith({
          owner: 'ranger',
          repo,
          name: 'merge when passing',
          color: 'FF851B',
          description: 'Merge the PR once all status checks have passed'
        })
      })
    })
  })

  describe('billing', () => {
    beforeEach(() => {
      robot.log.error = jest.fn()
    })

    test.each([
      // Paid plan
      {
        type: 'User',
        marketplace_purchase: {
          on_free_trial: false,
          plan: {
            bullets: ['Unlimited public repositories', '5 private repositories']
          }
        }
      },
      // On free trial
      {
        type: 'User',
        marketplace_purchase: {
          on_free_trial: true,
          plan: {
            bullets: ['Unlimited public repositories', '1 private repositories']
          }
        }
      }
    ])('Will schedule job is private billing is correct: %#', async data => {
      github.apps.checkAccountIsAssociatedWithAny = () => ({ data })

      await robot.receive(payload({ isPrivate: true }))
      expect(queue.createJob).toHaveBeenCalledWith({
        number: 7,
        owner: 'mfix22',
        repo: 'test-issue-bot',
        installation_id: 135737,
        action: 'close'
      })
    })

    test.each([
      [
        'Repo must have an associated account',
        () => {
          throw new Error('No associated account')
        }
      ],
      ['Account must contain marketplace purchase', {}],
      [
        'Repo owner must match account type',
        {
          type: 'Organization',
          marketplace_purchase: {}
        }
      ],
      [
        'Private repos are not supported in open source plan',
        {
          // On Open Source plan
          type: 'User',
          marketplace_purchase: {
            on_free_trial: false,
            plan: {
              number: 1
            }
          }
        }
      ],
      [
        'Number of installed repos must be less than maximum for purchase',
        {
          type: 'User',
          marketplace_purchase: {
            on_free_trial: false,
            plan: {
              bullets: ['Unlimited public repositories', '1 private repositories']
            }
          }
        }
      ]
    ])('%s', async (_, data) => {
      github.apps.checkAccountIsAssociatedWithAny = () => ({
        data: typeof data === 'function' ? data() : data
      })
      await robot.receive(payload({ isPrivate: true }))
      expect(queue.createJob).not.toHaveBeenCalled()
    })
  })
})
