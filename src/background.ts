import { useGroupConfigurations } from '@/composables'
import { createDefaultGroups, registerOnceRouter } from '@/util/once-router'
import { readStorage } from '@/util/storage'
import { saveGroupConfigurations } from '@/util/group-configurations'
import { when } from '@/util/when'

const groups = useGroupConfigurations()

// Register listeners synchronously so a new tab can wake the MV3 worker.
// Only pending new tabs are persisted; existing tabs are never reassigned.
registerOnceRouter(chrome, async () => {
  await when(groups.loaded)
  if (typeof (await readStorage('groups', 'sync')) === 'undefined') {
    const defaults = createDefaultGroups(await chrome.tabGroups.query({}))
    groups.data.value = defaults
    await saveGroupConfigurations(defaults)
  }
  return () => groups.data.value
})

chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload())
chrome.runtime.onMessage.addListener(message => {
  if (message === 'reload') chrome.runtime.reload()
})
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage())
