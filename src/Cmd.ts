import * as ContentView from './ContentView'
import * as StatusItems from './StatusItems'
import * as TourGuide from './TourGuide'
import * as ToursView from './ToursView'
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

let vcdBusy = false

export async function downloadVcd() {
    if (vcdBusy) return
    vcdBusy = true
    try {
        const uri = StatusItems.vcdC.uri()
        await Utils.updateVcd(uri)
        StatusItems.vcdC.start()
    } finally {
        vcdBusy = false
    }
}

export async function gotoPulseView() {
    await Vsc.env.openExternal(Vsc.Uri.parse('https://www.sigrok.org/wiki/Downloads'))
}

export async function localCopy(node: ContentView.Node) {
    const uri = Utils.localCopy(node.uri.fsPath)
    ContentView.refresh()
    await ContentView.revealUri(uri)
}

export async function initSetup() {
    Utils.refreshProps()
    const brd = Utils.getBoard()
    await StatusItems.boardC.set(brd ? brd : 'rpi.2040://PI_PICO-sim$$')
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

export async function refresh(silent: boolean = false) {
    ContentView.refresh()
    await Vsc.commands.executeCommand('typescript.restartTsServer')
    Utils.refreshProps()
    Utils.spawnSync(['emscript', 'config'])
    if (!silent) Vsc.window.showInformationMessage(`EM•Builder refreshed`)
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
    await ContentView.revealUri(uri)
}

export async function reset() {
    let rsp = await Vsc.window.showErrorMessage('Have you committed and pushed all workspace changes?', { modal: true }, 'Proceed')
    if (!rsp) return
    rsp = await Vsc.window.showErrorMessage(`Execute '$HOME/EM/reset.sh' once we exit the EM•porium...`, { modal: true }, 'Proceed')
    if (!rsp) return
    Utils.writeScript('reset')
    await Vsc.commands.executeCommand('workbench.action.quit')
}

export async function revealExplorer(uri: Vsc.Uri) {
    await Vsc.commands.executeCommand('revealInExplorer', uri)
}

let welcomePanel: Vsc.WebviewPanel | undefined

export async function showWelcome() {
    if (!welcomePanel) {

        const panel = Vsc.window.createWebviewPanel(
            'embuilder.welcome',
            'EM•Home',
            Vsc.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        )
        welcomePanel = panel
        panel.onDidDispose(() => { welcomePanel = undefined })

        const cssUri = Vsc.Uri.joinPath(Utils.rootUri(), 'docs', 'welcome', 'style.css')
        const cssText = await Utils.readText(cssUri)

        const bodyUri = Vsc.Uri.joinPath(Utils.rootUri(), 'docs', 'welcome', 'body.html')
        const bodyText = await Utils.readText(bodyUri)

        const logoUri = panel.webview.asWebviewUri(
            Vsc.Uri.joinPath(Utils.rootUri(), 'docs', 'welcome', 'logo.png')
        )

        const nonce = Utils.mkNonce()

        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg?.kind === 'cmd' && typeof msg.id === 'string')
                await Vsc.commands.executeCommand(msg.id)
        })

        panel.webview.html = `<!doctype html>
<html>
<head>
<meta charset='utf-8'>
<meta http-equiv='Content-Security-Policy' content="default-src 'none'; img-src ${panel.webview.cspSource} https: data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name='viewport' content='width=device-width,initial-scale=1'>
<style>
${cssText}
</style>
</head>
<body>
<div class="frame">
    <div class="logo">
        <img src="${logoUri}" alt="EM•Builder">
    </div>
${bodyText}
</div>
<script nonce='${nonce}'>
  const vscode = acquireVsCodeApi()
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.cmd-wc')
    if (!a) return
    e.preventDefault()
    vscode.postMessage({ kind: 'cmd', id: a.dataset.cmd })
  })
</script>
</body>
</html>`
    }

    welcomePanel.reveal(Vsc.ViewColumn.One, true)
    await Vsc.commands.executeCommand('workbench.action.moveEditorToFirstGroup')
    for (let i = 0; i < 20; i++) await Vsc.commands.executeCommand('workbench.action.moveEditorLeftInGroup')
    await Vsc.commands.executeCommand('workbench.action.pinEditor')
}

export async function startFirstTour() {
    await Vsc.commands.executeCommand('workbench.view.extension.emtours')
    setTimeout(async () => { await TourGuide.start(ToursView.firstTour().resourceUri!) }, 1000)
}
