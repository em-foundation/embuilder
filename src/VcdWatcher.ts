import * as Vsc from 'vscode'
import * as Cmd from './Cmd'
import * as Utils from './Utils'

let vcdWatcher: Vsc.FileSystemWatcher | undefined
let reenableTimer: NodeJS.Timeout | undefined

export function start(ctx: Vsc.ExtensionContext) {
    // one cleanup hook for the lifetime of the extension
    ctx.subscriptions.push({ dispose: () => vcdWatcher?.dispose() })

    createWatcher()
}

function createWatcher() {
    vcdWatcher?.dispose()

    vcdWatcher = Vsc.workspace.createFileSystemWatcher(
        new Vsc.RelativePattern(Utils.rootUri(), '**/wokwi.vcd')
    )

    vcdWatcher.onDidCreate(() => { void onEvent() })
    vcdWatcher.onDidChange(() => { void onEvent() })
}

async function onEvent() {
    vcdWatcher?.dispose()
    vcdWatcher = undefined

    try {
        await Cmd.downloadVcd()
    } finally {
        if (reenableTimer) clearTimeout(reenableTimer)
        // let any “extra” events from the same write flush out
        reenableTimer = setTimeout(() => createWatcher(), 250)
    }
}
