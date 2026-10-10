import { generateMatcherRegex } from './matcher-regex'
import type { GroupConfiguration } from './types'

type ChromeApi = Pick<
  typeof chrome,
  'tabs' | 'tabGroups' | 'windows' | 'storage' | 'runtime'
>
type PendingTab = { startedAt: number; initialGroupId: number }
const PREFIX = 'group-once:pending:'
const HANDLED_PREFIX = 'group-once:handled:'
const SESSION_KEY = 'group-once:session'
// Chrome emits onCreated for restored tabs, too, and has no restored flag.
// Protect the startup burst until tab creation has been quiet for three seconds.
const RESTORE_QUIET_MS = 3_000
const SETTLE_MS = 750
const MAX_WAIT_MS = 12_000

/** First matching rule wins. A title exclusion falls through to the next rule. */
export function matchNewTab(
  tab: chrome.tabs.Tab,
  groups: GroupConfiguration[],
) {
  const url = tab.pendingUrl || tab.url || ''
  const title = (tab.title || '').toLocaleLowerCase()
  return groups.find(group => {
    if (
      group.options.excludedTitles?.some(
        text => text.trim() && title.includes(text.trim().toLocaleLowerCase()),
      )
    )
      return false
    return group.matchers.some(pattern => {
      try {
        return generateMatcherRegex(pattern).test(url)
      } catch {
        return false
      }
    })
  })
}

export function createDefaultGroups(nativeGroups: chrome.tabGroups.TabGroup[]) {
  return ['GPT', 'Default'].map((title, index): GroupConfiguration => {
    const existing = nativeGroups.find(
      group => group.title?.toLocaleLowerCase() === title.toLocaleLowerCase(),
    )
    return {
      id: crypto.randomUUID(),
      title: existing?.title ?? title,
      color: existing?.color ?? (index === 0 ? 'green' : 'grey'),
      matchers:
        index === 0
          ? ['https://chatgpt.com/*', 'https://chat.openai.com/*']
          : ['*'],
      options: { strict: false, merge: index === 0, excludedTitles: [] },
    }
  })
}

/**
 * Decide once after a new tab's first page settles, or after a bounded wait.
 * Session storage keeps pending decisions alive across service-worker restarts.
 * Delete a pending record BEFORE grouping so later events are inert.
 */
export function registerOnceRouter(
  api: ChromeApi,
  loadConfigurations: () => Promise<() => GroupConfiguration[]>,
) {
  const pending = new Map<number, PendingTab>()
  const handled = new Set<number>()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let getGroups: () => GroupConfiguration[] = () => []
  let ready: Promise<void>
  let queue = Promise.resolve()
  let restoreUntil = 0
  let startupSeen = false
  let startupGeneration = 0
  // Take the baseline before awaiting configuration. Tabs already open when
  // this worker starts belong to the user; pending records are resumed below.
  const baseline = api.tabs.query({})

  function enqueue(task: () => Promise<void>) {
    queue = queue
      .then(() => ready)
      .then(task)
      .catch(error => {
        console.error('Could not group new tab:', error)
      })
    return queue
  }

  async function forget(tabId: number) {
    clearTimeout(timers.get(tabId))
    timers.delete(tabId)
    pending.delete(tabId)
    await api.storage.session.remove(PREFIX + tabId)
    handled.add(tabId)
    await api.storage.session.set({ [HANDLED_PREFIX + tabId]: true })
  }

  async function protectStartup(startedAt: number) {
    restoreUntil = Math.max(restoreUntil, startedAt + RESTORE_QUIET_MS)
    await api.storage.session.set({
      [SESSION_KEY]: { restoreUntil },
    })
  }

  async function assign(
    tabId: number,
    rule: GroupConfiguration,
    expected: chrome.tabs.Tab,
  ) {
    const generation = startupGeneration
    let tab = await api.tabs.get(tabId)
    if (tab.groupId !== expected.groupId || tab.windowId !== expected.windowId)
      return
    const window = await api.windows.get(tab.windowId)
    if (window.type !== 'normal') return
    const groups = await api.tabGroups.query({})
    // Match a native group by title; its color can change independently.
    const matches = groups.filter(
      group =>
        group.title?.toLocaleLowerCase() === rule.title.toLocaleLowerCase(),
    )
    let target =
      matches.find(
        group => group.windowId === tab.windowId && group.color === rule.color,
      ) ?? matches.find(group => group.windowId === tab.windowId)
    if (!target && rule.options.merge) {
      for (const group of matches) {
        const targetWindow = await api.windows.get(group.windowId)
        if (targetWindow.incognito === window.incognito) {
          target = group
          break
        }
      }
    }
    // Respect a manual move/pin while the asynchronous queries were running.
    const latest = await api.tabs.get(tabId)
    if (
      latest.pinned ||
      generation !== startupGeneration ||
      Date.now() <= restoreUntil ||
      (latest.splitViewId !== undefined && latest.splitViewId !== -1) ||
      latest.groupId !== tab.groupId ||
      latest.windowId !== tab.windowId
    )
      return
    tab = latest
    if (target) {
      if (tab.groupId === target.id) return
      if (target.windowId !== tab.windowId) {
        await api.tabs.move(tabId, { windowId: target.windowId, index: -1 })
      }
      await api.tabs.group({ tabIds: [tabId], groupId: target.id })
      if (tab.active && target.windowId !== tab.windowId) {
        await api.tabs.update(tabId, { active: true })
        await api.windows.update(target.windowId, { focused: true })
      }
    } else {
      const id = await api.tabs.group({
        tabIds: [tabId],
        createProperties: { windowId: tab.windowId },
      })
      await api.tabGroups.update(id, { title: rule.title, color: rule.color })
    }
  }

  async function decide(tabId: number) {
    const record = pending.get(tabId)
    if (!record) return
    let tab: chrome.tabs.Tab
    try {
      tab = await api.tabs.get(tabId)
    } catch {
      await forget(tabId)
      return
    }
    await forget(tabId)
    if (
      record.startedAt <= restoreUntil ||
      tab.pinned ||
      tab.groupId !== record.initialGroupId ||
      (tab.splitViewId !== undefined && tab.splitViewId !== -1)
    )
      return
    const rule = matchNewTab(tab, getGroups())
    if (rule) await assign(tabId, rule, tab)
  }

  async function schedule(tabId: number) {
    const record = pending.get(tabId)
    if (!record) return
    let tab: chrome.tabs.Tab
    try {
      tab = await api.tabs.get(tabId)
    } catch {
      await forget(tabId)
      return
    }
    if (record.initialGroupId === -1 && tab.groupId !== -1) {
      record.initialGroupId = tab.groupId
      await api.storage.session.set({ [PREFIX + tabId]: record })
    }
    if (
      tab.pinned ||
      tab.groupId !== record.initialGroupId ||
      (tab.splitViewId !== undefined && tab.splitViewId !== -1)
    ) {
      await forget(tabId)
      return
    }
    clearTimeout(timers.get(tabId))
    const remaining = Math.max(0, MAX_WAIT_MS - (Date.now() - record.startedAt))
    const delay =
      tab.status === 'complete' ? Math.min(SETTLE_MS, remaining) : remaining
    timers.set(
      tabId,
      setTimeout(() => {
        void enqueue(() => decide(tabId))
      }, delay),
    )
  }

  const onCreated = (tab: chrome.tabs.Tab) => {
    if (tab.id === undefined) return
    const tabId = tab.id
    const record = { startedAt: Date.now(), initialGroupId: tab.groupId }
    void enqueue(async () => {
      if (handled.has(tabId)) return
      if (record.startedAt <= restoreUntil) {
        await protectStartup(record.startedAt)
        await forget(tabId)
        return
      }
      // Lazy session restoration can happen after the initial startup burst.
      if (tab.discarded || tab.status === 'unloaded') {
        await forget(tabId)
        return
      }
      pending.set(tabId, record)
      await api.storage.session.set({ [PREFIX + tabId]: record })
      await schedule(tabId)
    })
  }
  const onUpdated = (tabId: number, changes: chrome.tabs.OnUpdatedInfo) => {
    void enqueue(async () => {
      if (!pending.has(tabId)) return
      if (changes.groupId !== undefined) {
        const record = pending.get(tabId)!
        // Chrome may report inherited group membership AFTER onCreated.
        // Accept that first attachment; further moves are a manual override.
        if (changes.groupId === record.initialGroupId) {
          await schedule(tabId)
        } else if (record.initialGroupId === -1 && changes.groupId !== -1) {
          record.initialGroupId = changes.groupId
          await api.storage.session.set({ [PREFIX + tabId]: record })
          await schedule(tabId)
        } else {
          await forget(tabId)
        }
        return
      }
      if (changes.pinned === true) {
        await forget(tabId)
        return
      }
      if (
        changes.url !== undefined ||
        changes.title !== undefined ||
        changes.status !== undefined
      ) {
        await schedule(tabId)
      }
    })
  }
  const onRemoved = (tabId: number) => {
    void enqueue(async () => {
      await forget(tabId)
      handled.delete(tabId)
      await api.storage.session.remove(HANDLED_PREFIX + tabId)
    })
  }
  const onDetached = (tabId: number) => {
    void enqueue(() => forget(tabId))
  }
  const onStartup = () => {
    // Set the barrier synchronously: tab events may precede or follow this
    // event, and the configuration loader may still be running.
    startupSeen = true
    startupGeneration++
    restoreUntil = Date.now() + RESTORE_QUIET_MS
    void enqueue(async () => {
      await protectStartup(Date.now())
      for (const tabId of pending.keys()) await forget(tabId)
    })
  }
  api.tabs.onCreated.addListener(onCreated)
  api.tabs.onUpdated.addListener(onUpdated)
  api.tabs.onRemoved.addListener(onRemoved)
  api.tabs.onDetached.addListener(onDetached)
  api.runtime.onStartup.addListener(onStartup)

  ready = (async () => {
    getGroups = await loadConfigurations()
    const stored = await api.storage.session.get(null)
    const session = stored[SESSION_KEY]
    const savedRestoreUntil =
      session &&
      typeof session === 'object' &&
      'restoreUntil' in session &&
      typeof session.restoreUntil === 'number' &&
      Number.isFinite(session.restoreUntil)
        ? session.restoreUntil
        : undefined
    const hasSession = savedRestoreUntil !== undefined
    if (hasSession && !startupSeen) {
      restoreUntil = savedRestoreUntil
    } else {
      // Session storage is cleared on a full browser restart/extension reload,
      // unlike an MV3 worker wake-up. Never reuse old numeric IDs across boots.
      await protectStartup(Date.now())
    }
    const existing = await baseline
    const liveIds = new Set(existing.map(tab => tab.id))
    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith(HANDLED_PREFIX)) {
        const tabId = Number(key.slice(HANDLED_PREFIX.length))
        if (Number.isInteger(tabId) && liveIds.has(tabId)) handled.add(tabId)
        else await api.storage.session.remove(key)
        continue
      }
      if (!key.startsWith(PREFIX)) continue
      const tabId = Number(key.slice(PREFIX.length))
      if (
        !Number.isInteger(tabId) ||
        !value ||
        typeof value !== 'object' ||
        !('startedAt' in value) ||
        typeof value.startedAt !== 'number' ||
        !('initialGroupId' in value) ||
        typeof value.initialGroupId !== 'number'
      )
        continue
      if (!hasSession || startupSeen || !liveIds.has(tabId)) {
        await api.storage.session.remove(key)
        continue
      }
      pending.set(tabId, value as PendingTab)
      await schedule(tabId)
    }
    const retained: Record<string, boolean> = {}
    for (const tab of existing) {
      if (tab.id !== undefined && !pending.has(tab.id) && !handled.has(tab.id)) {
        handled.add(tab.id)
        retained[HANDLED_PREFIX + tab.id] = true
      }
    }
    if (Object.keys(retained).length) await api.storage.session.set(retained)
  })()

  return {
    ready,
    // Disposal retains session records, just as service-worker sleep does.
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      api.tabs.onCreated.removeListener(onCreated)
      api.tabs.onUpdated.removeListener(onUpdated)
      api.tabs.onRemoved.removeListener(onRemoved)
      api.tabs.onDetached.removeListener(onDetached)
      api.runtime.onStartup.removeListener(onStartup)
    },
    idle: () => queue,
  }
}
