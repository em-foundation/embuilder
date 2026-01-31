import * as ContentView from './ContentView'
import * as StatusItems from './StatusItems'
import * as Utils from './Utils'
import * as Vsc from 'vscode'

const UNIT_CONTENT = new Map<string, string>([
    ['Composite', `
import '@$$emscript'
export const $U = $declare('COMPOSITE')

`   ],
    ['Interface', `
import '@$$emscript'
export const $U = $declare('INTERFACE')

export interface em$meta { }

export interface $I {
    em$meta: em$meta
}
`   ],
    ['Module', `
import '@$$emscript'
export const $U = $declare('MODULE')

export namespace em$meta { }

//>> ---- em$targ ---- <<//
`   ],
    ['Program', `
import '@$$emscript'
export const $U = $declare('MODULE')

export namespace em$meta { }

//>> ---- em$targ ---- <<//

export function em$run() {
    halt()
}
`   ],
    ['Template', `
import '@$$emscript'
export const $T = $declare('TEMPLATE')

export namespace em$template {
    export const $U = $declare('MODULE')

    namespace em$meta { }
}

export function $clone() { return { $T, ...em$template } }
`   ],
])

export async function bindBoard() {
    const curName = StatusItems.boardC.get()
    const newName = await Vsc.window.showQuickPick(StatusItems.boardC.pickList())
    const name = newName ? StatusItems.boardC.trim(newName) : curName
    await StatusItems.boardC.set(name)
}

export async function bindSetup(uri?: Vsc.Uri) {
    const curName = StatusItems.setupC.get()
    const newName = await Vsc.window.showQuickPick(StatusItems.setupC.pickList())
    const name = newName ? StatusItems.setupC.trim(newName) : curName
    // await Utils.boardC.set('')
    await StatusItems.setupC.set(name)
    // Utils.updateConfig()
}

export async function build(uri?: Vsc.Uri, cid?: string) {
    const is_sim = Utils.getBoard().endsWith('-sim$$')
    if (cid === undefined) {
        uri = Vsc.window.activeTextEditor?.document.uri
        cid = 'em.buildLoad'
    }
    if (!uri || !uri.path.endsWith('.em.ts')) return
    const opt = cid === 'em.buildLoad' && !is_sim ? '--load' : cid === 'em.buildMeta' ? '--meta' : ''
    await Utils.spawnLog(['emscript', 'build', '--unit', Utils.unitPath(uri), opt])
    ContentView.refresh()
    if (is_sim && cid == 'em.buildLoad') {
        await Vsc.commands.executeCommand('wokwi-vscode.start') // TODO: only for "simulated" boards
    }
}

export async function clean() {
    await Utils.spawnLog(['emscript', 'clean'])
    ContentView.refresh()
    await Vsc.commands.executeCommand('typescript.restartTsServer')
}

export async function downloadVcd() {
    const uri = StatusItems.vcdC.uri()
    await Vsc.commands.executeCommand('workbench.action.files.download', uri)
    StatusItems.vcdC.stop()
}

export async function initSetup() {
    const defSetup = Utils.getDefaultSetup()
    if (defSetup) {
        await StatusItems.setupC.set(defSetup)
    } else if (Utils.isCodespace()) {
        await StatusItems.setupC.set('rpi.2040://default')
    } else {
        let opts: Vsc.MessageOptions = {
            detail: "Click below to select a tooling setup",
            modal: true,
        };
        await StatusItems.boardC.set('')
        if (
            await Vsc.window.showWarningMessage(`EM•Script Setups`, opts, "Select...")
        ) {
            await bindSetup()
        }
    }

}

export async function newContainer(node: ContentView.Node, cks: string) {
    const newuri = await Utils.newContainer(node.uri, cks)
    if (!newuri) return
    ContentView.refresh(node)
    await ContentView.reveal(node)
    const newnode = ContentView.getNode(newuri)!
    await ContentView.reveal(newnode)
}

export async function newUnit(node: ContentView.Node, uks: string) {
    const content = UNIT_CONTENT.get(uks)!
    const newuri = await Utils.newUnit(node.uri, uks, content.trim() + '\n')
    if (!newuri) return
    ContentView.refresh(node)
    await ContentView.reveal(node)
    const newnode = ContentView.getNode(newuri)!
    await ContentView.reveal(newnode)
}

export async function refresh() {
    ContentView.refresh()
    await Vsc.commands.executeCommand('typescript.restartTsServer')
    Utils.refreshProps()
    Vsc.window.showInformationMessage(`EM•Browser refreshed`)
}

export async function remove(node: ContentView.Node) {
    const ok = await Vsc.window.showWarningMessage(
        `Permanently remove '${node.label}'?`,
        { modal: true },
        'Remove'
    )
    if (ok !== 'Remove') return

    const rem = node.uri.toString()

    for (const ed of Vsc.window.visibleTextEditors) {
        const u = ed.document.uri.toString()
        if (u === rem || u.startsWith(rem + '/')) {
            await Vsc.window.showTextDocument(ed.document, ed.viewColumn)
            await Vsc.commands.executeCommand('workbench.action.closeActiveEditor')
        }
    }

    await Vsc.workspace.fs.delete(node.uri, { recursive: true })
    ContentView.refresh()
}

export async function revealUnit() {
    const uri = Vsc.window.activeTextEditor?.document.uri
    if (!uri || !uri.path.endsWith('.em.ts')) return
    const segs = uri.path.split('/')
    ContentView.refresh()
    let u = Utils.workUri()
    for (const seg of segs.slice(segs.length - 3)) {
        u = Vsc.Uri.joinPath(u, seg)
        const n = ContentView.getNode(u)!
        ContentView.refresh(n)
        await ContentView.reveal(n)
    }
}

export async function revealExplorer(node: ContentView.Node) {
    await Vsc.commands.executeCommand('revealInExplorer', node.uri)
}
