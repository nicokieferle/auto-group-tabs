import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createDefaultGroups,
  matchNewTab,
  registerOnceRouter,
} from '@/util/once-router'
import { GroupConfigurationSchemas } from '@/util/schemas'
import type { GroupConfiguration } from '@/util/types'

function event() {
  const listeners = new Set<(...args: any[]) => void>()
  return {
    addListener: (fn: (...args: any[]) => void) => listeners.add(fn),
    removeListener: (fn: (...args: any[]) => void) => listeners.delete(fn),
    emit: (...args: any[]) => {
      for (const fn of listeners) fn(...args)
    },
  }
}

function harness(
  initialGroups: chrome.tabGroups.TabGroup[] = [],
  stored: Record<string, unknown> = {},
  coldStart = false,
) {
  if (!coldStart) stored['group-once:session'] ??= { restoreUntil: 0 }
  const tabs = new Map<number, chrome.tabs.Tab>()
  const groups = [...initialGroups]
  const windows = new Map([
    [1, { id: 1, type: 'normal', incognito: false }],
    [2, { id: 2, type: 'normal', incognito: false }],
    [3, { id: 3, type: 'normal', incognito: true }],
    [4, { id: 4, type: 'popup', incognito: false }],
  ])
  let nextGroup = 100
  const onCreated = event(),
    onUpdated = event(),
    onRemoved = event(),
    onDetached = event()
  const onStartup = event()
  const api = {
    runtime: { onStartup },
    tabs: {
      onCreated,
      onUpdated,
      onRemoved,
      onDetached,
      query: vi.fn(async () => [...tabs.values()].map(tab => ({ ...tab }))),
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id)
        if (!tab) throw new Error('Closed tab')
        return { ...tab }
      }),
      group: vi.fn(async (info: any) => {
        const groupId = info.groupId ?? nextGroup++
        if (info.groupId === undefined)
          groups.push({
            id: groupId,
            windowId: info.createProperties.windowId,
            title: '',
            color: 'grey',
            collapsed: false,
            shared: false,
          })
        for (const id of info.tabIds) update(id, { groupId })
        return groupId
      }),
      move: vi.fn(async (id: number, info: any) => {
        Object.assign(tabs.get(id)!, info)
        onDetached.emit(id)
      }),
      update: vi.fn(async (id: number, info: any) =>
        Object.assign(tabs.get(id)!, info),
      ),
    },
    tabGroups: {
      query: vi.fn(async () => groups.map(group => ({ ...group }))),
      update: vi.fn(async (id: number, info: any) =>
        Object.assign(groups.find(group => group.id === id)!, info),
      ),
    },
    windows: {
      get: vi.fn(async (id: number) => windows.get(id)),
      update: vi.fn(async () => {}),
    },
    storage: {
      session: {
        get: vi.fn(async () => ({ ...stored })),
        set: vi.fn(async (data: any) => {
          Object.assign(stored, data)
        }),
        remove: vi.fn(async (key: string) => {
          delete stored[key]
        }),
      },
    },
  }
  function put(id: number, data: Partial<chrome.tabs.Tab> = {}) {
    const tab = {
      id,
      windowId: 1,
      groupId: -1,
      title: 'New tab',
      url: 'chrome://newtab/',
      status: 'complete',
      pinned: false,
      active: false,
      index: 0,
      highlighted: false,
      incognito: false,
      selected: false,
      ...data,
    } as chrome.tabs.Tab
    tabs.set(id, tab)
    return tab
  }
  function create(id: number, data: Partial<chrome.tabs.Tab> = {}) {
    const tab = put(id, data)
    onCreated.emit({ ...tab })
    return tab
  }
  function update(id: number, data: Partial<chrome.tabs.Tab>) {
    Object.assign(tabs.get(id)!, data)
    onUpdated.emit(id, data, { ...tabs.get(id)! })
  }
  function remove(id: number) {
    tabs.delete(id)
    onRemoved.emit(id)
  }
  let rules = createDefaultGroups(initialGroups)
  const routers: ReturnType<typeof registerOnceRouter>[] = []
  function start(load = async () => () => rules) {
    const router = registerOnceRouter(
      api as unknown as Parameters<typeof registerOnceRouter>[0],
      load,
    )
    routers.push(router)
    return router
  }
  return {
    api,
    tabs,
    groups,
    stored,
    pendingKeys: () => Object.keys(stored).filter(key => key.startsWith('group-once:pending:')),
    put,
    create,
    update,
    remove,
    start,
    routers,
    rules,
    setRules: (value: GroupConfiguration[]) => {
      rules = value
    },
  }
}

let current: ReturnType<typeof harness> | undefined
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  current?.routers.forEach(router => router.dispose())
  current = undefined
  vi.useRealTimers()
})
async function settle(router: ReturnType<typeof registerOnceRouter>, ms = 800) {
  await router.idle()
  await vi.advanceTimersByTimeAsync(ms)
  await router.idle()
}

it('seeds GPT and catch-all Default with existing native names/colors and valid import/export data', () => {
  const defaults = createDefaultGroups([
    {
      id: 7,
      windowId: 2,
      title: 'GPT',
      color: 'cyan',
      collapsed: true,
      shared: false,
    },
  ])
  expect(defaults[0]).toMatchObject({
    title: 'GPT',
    color: 'cyan',
    options: { merge: true },
  })
  expect(defaults[1]).toMatchObject({ title: 'Default', matchers: ['*'] })
  expect(GroupConfigurationSchemas.safeParse(defaults).success).toBe(true)
})

it('supports title exclusions, case-insensitive contains, and falls through to Default', () => {
  const rules = createDefaultGroups([])
  rules[0]!.options.excludedTitles = [' xxx ', 'secret']
  expect(
    matchNewTab(
      {
        url: 'https://chatgpt.com/c/123',
        title: 'Project XXX',
      } as chrome.tabs.Tab,
      rules,
    )?.title,
  ).toBe('Default')
  expect(
    matchNewTab(
      {
        url: 'https://chatgpt.com/c/123',
        title: 'Normal conversation',
      } as chrome.tabs.Tab,
      rules,
    )?.title,
  ).toBe('GPT')
  expect(
    matchNewTab(
      { url: 'https://chatgpt.com.evil.test/', title: '' } as chrome.tabs.Tab,
      rules,
    )?.title,
  ).toBe('Default')
  expect(
    matchNewTab(
      {
        pendingUrl: 'https://chatgpt.com/',
        url: 'about:blank',
      } as chrome.tabs.Tab,
      rules,
    )?.title,
  ).toBe('GPT')
})

it('registers listeners before loading configuration and routes a bookmark tab to the original GPT group', async () => {
  current = harness([
    {
      id: 7,
      windowId: 1,
      title: 'GPT',
      color: 'cyan',
      collapsed: false,
      shared: false,
    },
  ])
  let resolve!: (value: () => GroupConfiguration[]) => void
  const router = current.start(
    () =>
      new Promise(done => {
        resolve = done
      }),
  )
  current.create(1, {
    url: '',
    pendingUrl: 'https://chatgpt.com/c/123',
    status: 'loading',
  })
  resolve(() => current!.rules)
  await router.ready
  current.update(1, {
    url: 'https://chatgpt.com/c/123',
    pendingUrl: undefined,
    status: 'complete',
    title: 'Conversation',
  })
  await settle(router)
  expect(current.tabs.get(1)?.groupId).toBe(7)
  expect(current.api.tabs.group).toHaveBeenCalledTimes(1)
  expect(current.groups).toHaveLength(1)
  expect(current.pendingKeys()).toEqual([])
  expect(current.stored['group-once:handled:1']).toBe(true)
})

it('routes other and blank new tabs to one Default group even when opened simultaneously', async () => {
  current = harness()
  const router = current.start()
  await router.ready
  current.create(1, { url: 'https://example.com/' })
  current.create(2)
  current.create(3, { url: 'https://example.org/' })
  await settle(router)
  expect(current.groups).toHaveLength(1)
  expect(current.groups[0]?.title).toBe('Default')
  expect(
    [...current.tabs.values()].every(
      tab => tab.groupId === current!.groups[0]!.id,
    ),
  ).toBe(true)
})

it('routes a newly created tab even when Chrome initially inherited another group', async () => {
  current = harness([
    {
      id: 8,
      windowId: 1,
      title: 'Other',
      color: 'blue',
      collapsed: false,
      shared: false,
    },
  ])
  const router = current.start()
  await router.ready
  current.create(1, { url: 'https://chatgpt.com/', groupId: 8 })
  await settle(router)
  expect(
    current.groups.find(group => group.id === current!.tabs.get(1)?.groupId)
      ?.title,
  ).toBe('GPT')
})

it('accepts delayed native group inheritance before and after queued creation processing', async () => {
  current = harness([
    {
      id: 8,
      windowId: 1,
      title: 'Default',
      color: 'grey',
      collapsed: false,
      shared: false,
    },
  ])
  const router = current.start()
  await router.ready
  current.create(1, { url: 'https://chatgpt.com/', status: 'loading' })
  current.update(1, { groupId: 8, status: 'complete' })
  current.create(2, { url: 'https://chatgpt.com/', status: 'loading' })
  await router.idle()
  current.update(2, { groupId: 8, status: 'complete' })
  await settle(router)
  const gpt = current.groups.find(group => group.title === 'GPT')!
  expect(current.tabs.get(1)?.groupId).toBe(gpt.id)
  expect(current.tabs.get(2)?.groupId).toBe(gpt.id)
})

it('leaves existing tabs and all later navigation, title changes, ungrouping and rule edits alone', async () => {
  current = harness()
  current.put(1, { url: 'https://chatgpt.com/' })
  const router = current.start()
  await router.ready
  current.update(1, { url: 'https://chatgpt.com/c/existing' })
  current.create(2, { url: 'https://chatgpt.com/' })
  await settle(router)
  expect(current.tabs.get(1)?.groupId).toBe(-1)
  const original = current.tabs.get(2)?.groupId
  current.update(2, { url: 'https://example.com/', title: 'Different' })
  await settle(router)
  expect(current.tabs.get(2)?.groupId).toBe(original)
  current.update(2, { groupId: 44 })
  current.update(2, { url: 'https://chatgpt.com/' })
  current.setRules([])
  await settle(router)
  expect(current.tabs.get(2)?.groupId).toBe(44)
  current.update(2, { groupId: -1 })
  await settle(router)
  expect(current.tabs.get(2)?.groupId).toBe(-1)
  expect(current.api.tabs.group).toHaveBeenCalledTimes(1)
})

it('honors a manual move before the first decision and cleans closed pending tabs', async () => {
  current = harness()
  const router = current.start()
  await router.ready
  current.create(1, { url: 'https://chatgpt.com/', groupId: 8 })
  await router.idle()
  current.update(1, { groupId: 44 })
  current.create(2, { status: 'loading' })
  await router.idle()
  current.remove(2)
  await settle(router, 15_000)
  expect(current.tabs.get(1)?.groupId).toBe(44)
  expect(current.api.tabs.group).not.toHaveBeenCalled()
  expect(current.pendingKeys()).toEqual([])
  expect(current.stored['group-once:handled:2']).toBeUndefined()
})

it('resumes pending first decisions across a worker restart, but never processed decisions', async () => {
  current = harness()
  let router = current.start()
  await router.ready
  current.create(1, { url: 'https://chatgpt.com/', status: 'loading' })
  await router.idle()
  expect(current.pendingKeys()).toHaveLength(1)
  router.dispose()
  router = current.start()
  await router.ready
  current.update(1, { status: 'complete' })
  await settle(router)
  const groupId = current.tabs.get(1)?.groupId
  router.dispose()
  router = current.start()
  await router.ready
  current.update(1, { url: 'https://example.com/' })
  await settle(router)
  expect(current.tabs.get(1)?.groupId).toBe(groupId)
  expect(current.api.tabs.group).toHaveBeenCalledTimes(1)
})

it('waits for first-page title changes and stops waiting after a bounded time', async () => {
  current = harness()
  current.rules[0]!.options.excludedTitles = ['xxx']
  const router = current.start()
  await router.ready
  current.create(1, {
    url: 'https://chatgpt.com/',
    status: 'loading',
    title: '',
  })
  await settle(router, 1000)
  expect(current.api.tabs.group).not.toHaveBeenCalled()
  current.update(1, { status: 'complete', title: 'Conversation' })
  await settle(router, 500)
  current.update(1, { title: 'xxx project' })
  await settle(router)
  expect(current.groups[0]?.title).toBe('Default')
  current.create(2, { url: 'https://chatgpt.com/', status: 'loading' })
  await settle(router, 12_100)
  expect(
    current.groups.find(group => group.id === current!.tabs.get(2)?.groupId)
      ?.title,
  ).toBe('GPT')
})

it('keeps pinned tabs, split views, popup windows and unmatched rules untouched', async () => {
  current = harness()
  const router = current.start()
  await router.ready
  current.create(1, { pinned: true })
  current.create(2, { splitViewId: 5 })
  current.create(3, { windowId: 4 })
  await settle(router)
  current.setRules([])
  current.create(4)
  await settle(router)
  expect(current.api.tabs.group).not.toHaveBeenCalled()
})

it('reuses GPT across windows while keeping Default local and incognito separate', async () => {
  current = harness([
    {
      id: 7,
      windowId: 2,
      title: 'GPT',
      color: 'purple',
      collapsed: false,
      shared: false,
    },
  ])
  const router = current.start()
  await router.ready
  current.create(1, { url: 'https://chatgpt.com/', active: true })
  current.create(2, {
    url: 'https://chatgpt.com/',
    windowId: 3,
    incognito: true,
  })
  current.create(3)
  await settle(router)
  expect(current.tabs.get(1)).toMatchObject({ groupId: 7, windowId: 2 })
  expect(current.api.windows.update).toHaveBeenCalledWith(2, { focused: true })
  expect(current.tabs.get(2)?.groupId).not.toBe(7)
  expect(
    current.groups.find(group => group.title === 'Default')?.windowId,
  ).toBe(1)
})

it('keeps restored tabs in their native groups after a full browser restart with new IDs', async () => {
  current = harness([
    { id: 207, windowId: 1, title: 'AC', color: 'blue', collapsed: false, shared: false },
    { id: 208, windowId: 2, title: 'GPT', color: 'green', collapsed: true, shared: false },
  ], {}, true)
  current.put(101, { url: 'https://chatgpt.com/c/ac', groupId: 207 })
  const router = current.start()
  // Restore events can arrive before onStartup and before configuration loads.
  current.create(102, { url: 'https://chatgpt.com/c/second', status: 'loading' })
  current.api.runtime.onStartup.emit()
  await router.ready
  current.update(102, { groupId: 207, status: 'complete' })
  current.create(103, { url: 'https://chatgpt.com/c/gpt', groupId: 208, windowId: 2 })
  await settle(router, 4_000)
  expect(current.tabs.get(101)).toMatchObject({ groupId: 207, windowId: 1 })
  expect(current.tabs.get(102)).toMatchObject({ groupId: 207, windowId: 1 })
  expect(current.tabs.get(103)).toMatchObject({ groupId: 208, windowId: 2 })
  expect(current.api.tabs.group).not.toHaveBeenCalled()
  expect(current.api.tabs.move).not.toHaveBeenCalled()
  expect(current.groups).toHaveLength(2)
  // Newly opened tabs are still routed once after startup settles.
  current.create(104, { url: 'https://chatgpt.com/c/new' })
  current.create(105, { url: 'https://example.com/new' })
  await settle(router)
  expect(current.tabs.get(104)).toMatchObject({ groupId: 208, windowId: 2 })
  expect(current.groups.find(group => group.id === current!.tabs.get(105)?.groupId)?.title).toBe('Default')
})

it('extends startup protection for slow restore bursts and retains it across worker sleep', async () => {
  current = harness([], {}, true)
  let router = current.start()
  await router.ready
  await settle(router, 2_500)
  current.create(11, { url: 'https://chatgpt.com/c/restored', groupId: 71 })
  await router.idle()
  router.dispose()
  router = current.start()
  await router.ready
  await settle(router, 2_500)
  current.create(12, { url: 'https://chatgpt.com/c/another', groupId: 72 })
  await settle(router, 4_000)
  expect(current.tabs.get(11)?.groupId).toBe(71)
  expect(current.tabs.get(12)?.groupId).toBe(72)
  expect(current.api.tabs.group).not.toHaveBeenCalled()
  current.create(13, { url: 'https://chatgpt.com/c/new' })
  await settle(router)
  expect(current.api.tabs.group).toHaveBeenCalledTimes(1)
})

it('leaves discarded/unloaded lazy restore tabs alone after the startup quiet period', async () => {
  current = harness([], {}, true)
  const router = current.start()
  await router.ready
  await settle(router, 10_000)
  current.create(21, { url: 'https://chatgpt.com/c/lazy', groupId: 71, discarded: true })
  current.create(22, { url: 'https://chatgpt.com/c/unloaded', status: 'unloaded' })
  await router.idle()
  current.update(21, { discarded: false, status: 'complete' })
  current.update(22, { groupId: 72, status: 'complete' })
  await settle(router, 15_000)
  expect(current.tabs.get(21)?.groupId).toBe(71)
  expect(current.tabs.get(22)?.groupId).toBe(72)
  expect(current.api.tabs.group).not.toHaveBeenCalled()
})

it('does not copy or reconstruct groups when another browser window is opened', async () => {
  current = harness([
    { id: 7, windowId: 1, title: 'GPT', color: 'green', collapsed: false, shared: false },
  ])
  current.put(1, { url: 'https://chatgpt.com/c/original', groupId: 7 })
  const router = current.start()
  await router.ready
  current.create(2, { url: 'chrome://newtab/', windowId: 2 })
  await settle(router)
  expect(current.tabs).toHaveLength(2)
  expect(current.groups.filter(group => group.title === 'GPT')).toHaveLength(1)
  expect(current.tabs.get(1)).toMatchObject({ groupId: 7, windowId: 1 })
  expect(current.groups.find(group => group.id === current!.tabs.get(2)?.groupId)).toMatchObject({ title: 'Default', windowId: 2 })
})

it('protects baseline tabs against repeated creation events after worker restarts', async () => {
  current = harness()
  let router = current.start()
  await router.ready
  current.create(31, { url: 'https://chatgpt.com/' })
  await settle(router)
  current.update(31, { groupId: 71 })
  await router.idle()
  router.dispose()
  router = current.start()
  await router.ready
  current.api.tabs.onCreated.emit({ ...current.tabs.get(31)! })
  await settle(router)
  expect(current.tabs.get(31)?.groupId).toBe(71)
  expect(current.api.tabs.group).toHaveBeenCalledTimes(1)
})

it('does not reuse stale pending IDs from the old extension on upgrade/cold startup', async () => {
  current = harness([], {
    'group-once:pending:41': { startedAt: Date.now() - 13_000, initialGroupId: -1 },
  }, true)
  current.put(41, { url: 'https://chatgpt.com/' })
  const router = current.start()
  await router.ready
  await settle(router, 15_000)
  expect(current.tabs.get(41)?.groupId).toBe(-1)
  expect(current.pendingKeys()).toEqual([])
  expect(current.api.tabs.group).not.toHaveBeenCalled()
})

it('cancels pending first decisions when a late onStartup event starts restoration', async () => {
  current = harness()
  const router = current.start()
  await router.ready
  current.create(51, { url: 'https://chatgpt.com/', status: 'loading' })
  await router.idle()
  current.api.runtime.onStartup.emit()
  await router.idle()
  current.update(51, { groupId: 71, status: 'complete' })
  await settle(router, 15_000)
  expect(current.tabs.get(51)?.groupId).toBe(71)
  expect(current.api.tabs.group).not.toHaveBeenCalled()
})

it('stops assignment if startup begins while native group queries are still running', async () => {
  current = harness()
  const router = current.start()
  await router.ready
  current.api.tabGroups.query.mockImplementationOnce(async () => {
    current!.api.runtime.onStartup.emit()
    return []
  })
  current.create(61, { url: 'https://chatgpt.com/' })
  await settle(router)
  expect(current.tabs.get(61)?.groupId).toBe(-1)
  expect(current.api.tabs.group).not.toHaveBeenCalled()
  expect(current.api.tabs.move).not.toHaveBeenCalled()
})
