// You can import your modules
const { Application } = require('probot')
const app = require('..')

const payload = require('./fixtures/labeled')
const commentPayload = require('./fixtures/comment')
const wait = x => new Promise(resolve => setTimeout(resolve, x))

class MockJob {
  constructor(data, queue) {
    this.queue = queue
    this.id = Math.random()
      .toString(36)
      .slice(2)
    this.data = data
    this.save = jest.fn(() => {
      this.to = setTimeout(this.queue.processor, this.delay - Date.now(), this)
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
  }
}

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

const config = `
labels:
  duplicate:
    delayTime: 5ms
    comment: $LABEL issue created! Closing in $CLOSE_TIME . . .
  invalid: true
  wontfix:
    delayTime: 10ms
    comment: false
  -1:
    delayTime: -1
    comment: Test comment
  Infinity:
    delayTime: Infinity
    comment: Test comment

delayTime: 1ms

comment: This issue has been marked to be closed in $CLOSE_TIME.
`

describe('Bot', () => {
  let robot
  let github
  let queue
  beforeEach(() => {
    queue = new MockQueue()
    robot = new Application()
    app(robot, queue)
    github = {
      issues: {
        createComment: jest.fn(),
        update: jest.fn((_, data) => Promise.resolve({ data }))
      },
      repos: {
        getContent: jest.fn(() => ({ data: { content: Buffer.from(config).toString('base64') } })),
        getContents: jest.fn(() => ({ data: { content: Buffer.from(config).toString('base64') } }))
      },
      apps: {
        listRepos() {
          return {
            data: {
              total_count: 5,
              repositories: Array(5).fill({
                private: true
              })
            }
          }
        }
      }
    }
    robot.auth = () => Promise.resolve(github)
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
      expect(queue.jobs[Object.keys(queue.jobs)[0]].id).toBe('mfix22:test-issue-bot:7')
      expect(queue.jobs[Object.keys(queue.jobs)[0]].data).toEqual(data)
    })

    test('Will not act on closed issues when labeled', async () => {
      await robot.receive(payload({ state: 'closed', number: 8 }))
      await wait(20)

      expect(queue.createJob).not.toHaveBeenCalled()
      expect(queue.removeJob).not.toHaveBeenCalled()
    })

    test('Will remove the job if an issue is closed', async () => {
      await robot.receive(payload({ action: 'closed', number: 9 }))

      expect(queue.createJob).not.toHaveBeenCalled()
      expect(queue.removeJob).toHaveBeenCalledWith('mfix22:test-issue-bot:9')
    })

    test('Will remove the job if all actionable labels are removed', async () => {
      await robot.receive(payload({ labels: [], number: 10 }))

      expect(queue.createJob).not.toHaveBeenCalled()
      expect(queue.removeJob).toHaveBeenCalledWith('mfix22:test-issue-bot:10')
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

    test.each(['-1', 'Infinity'])('Using %s for delayTime should not create a job', async label => {
      await robot.receive(payload({ labels: [label], number: 11 }))

      expect(github.issues.createComment).toHaveBeenCalled()
      expect(queue.createJob).not.toHaveBeenCalled()
    })
  })

  describe('comment', () => {
    test('Will remove the job if the comment is deleted', async () => {
      const number = 55

      await robot.receive(commentPayload({ number }))

      expect(queue.createJob).not.toHaveBeenCalled()
      expect(queue.removeJob).toHaveBeenCalledWith(`mfix22:test-issue-bot:${number}`)
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
