import * as MdMod from 'markdown-it'
import * as Utils from './Utils'
import * as Vsc from 'vscode'
import * as Yaml from 'js-yaml'

const Md = new MdMod.default({ html: true })

type ActionId = string | number

interface Decor {
    type: Vsc.TextEditorDecorationType
    range: Vsc.Range
}

interface File {
    readonly uri: Vsc.Uri
    readonly decorMap: Map<string, Decor>
    doc?: Vsc.TextDocument
    ted?: Vsc.TextEditor
    openedTab?: Vsc.Tab
}

interface Step {
    readonly cmds: string[]
    readonly text: string
    readonly focus?: [number, number]
    readonly acts?: ActionId[]
    srcLine?: number
}

interface Tour {
    readonly title: string
    readonly files: string[]
    readonly actions: string[]
    readonly steps: Step[]
    uri?: Vsc.Uri
    bname?: string
    tnum?: string
    $dev?: boolean
}

const DEC_REND_OPTS: Vsc.DecorationRenderOptions = {
    overviewRulerLane: Vsc.OverviewRulerLane.Full
}

const OPEN_OPTS: Vsc.TextDocumentShowOptions = { viewColumn: 1, preview: false }

const BM_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 0 20 20" width="18px" fill="hsl(48,89%,50%)"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/> <text text-anchor="middle" alignment-baseline="middle" x="11.5" y="12.0" fill="black" font-weight="bold" font-size="16" font-family="Consolas, monospace">$label</text> </svg>'
const DC_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="18px" width="18px" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="hsl(312, 75%, 75%)"/><text text-anchor="middle" alignment-baseline="middle" x="10" y="10.8" fill="black" font-weight="bold" font-size="12" font-family="Consolas, monospace">$label</text></svg>'

const DecoratorFactory = new class DecoratorFactory {
    private readonly map = new Map<string, Vsc.TextEditorDecorationType>()
    private create(label: string) {
        if (this.map.has(label)) return this.map.get(label)!
        let icon = Vsc.Uri.parse(`data:image/svg+xml,${encodeURIComponent(BM_SVG.replace('$label', label))}`)
        let dt = Vsc.window.createTextEditorDecorationType({
            gutterIconPath: icon,
            gutterIconSize: '90%',
            overviewRulerLane: Vsc.OverviewRulerLane.Full
        })
        this.map.set(label, dt)
        return dt
    }
    clear(file: File) {
        file.decorMap.forEach((v, k) => file.ted!.setDecorations(v.type, []))
        file.decorMap.clear()
    }
    mark(file: File, label: string, line: number) {
        let decor: Decor = {
            type: this.create(label),
            range: mkRange(line),
        }
        file.decorMap.set(label, decor)
    }
}

let curCtx: Vsc.ExtensionContext
let curTour: Tour | null = null
let fileTab: File[]
let initFlag: boolean = false
let reload: boolean = false
let stepIdx: number
let stepEnd: number
let tedMonitor: Vsc.Disposable | null = null
let watcher: Vsc.FileSystemWatcher | null = null

export async function init(ctx: Vsc.ExtensionContext) {
    curCtx = ctx
    Vsc.commands.executeCommand('setContext', 'em-builder.activeTour', false)
}

export async function end() {
    let ted0: Vsc.TextEditor | null = null
    for (let file of fileTab) {
        if (!file.doc) continue
        let ted = await Vsc.window.showTextDocument(file.doc, OPEN_OPTS)
        if (file.decorMap) file.decorMap.forEach((v, k) => ted.setDecorations(v.type, []))
        await Vsc.commands.executeCommand(
            'workbench.action.files.resetActiveEditorReadonlyInSession'
        )
        if (!ted0) ted0 = ted
    }
    curTour = null
    if (tedMonitor) {
        tedMonitor.dispose()
        tedMonitor = null
    }
    if (watcher) {
        watcher.dispose()
        watcher = null
    }
    Vsc.commands.executeCommand('setContext', 'em-builder.activeTour', false)
    await Vsc.commands.executeCommand('workbench.view.extension.emtours')
    if (ted0) await Vsc.window.showTextDocument(ted0.document, OPEN_OPTS)
}

export async function next() {
    if (!curTour || stepIdx >= stepEnd) return
    stepIdx += 1
    await execCmds()
    await sync()
}

export async function prev() {
    if (!curTour || stepIdx == 0) return
    stepIdx -= 1
    await execCmds()
    await sync()
}

export async function refresh() {
    stepIdx -= 1
    next()
}

export async function restart() {
    if (!curTour) return
    const uri = curTour.uri!
    const dev = curTour.$dev
    await end()
    await start(uri, dev)
}

export async function screenshot() {
    await Utils.screenshot('tourstop')
}

async function sync() {
    let step = curTour!.steps[stepIdx]
    if (curTour!.$dev) {
        let ted = await Vsc.window.showTextDocument(curTour!.uri!, { viewColumn: 2 })
        let ln = step.srcLine && stepIdx != 0 ? step.srcLine : 1
        ted.revealRange(mkRange(Number(ln)), Vsc.TextEditorRevealType.AtTop)
    }
    await ViewProvider.renderText(step.text, step.acts ?? [])
    if (!step.focus) return
    let file = fileTab[step.focus[0] - 1]
    let ted = await Vsc.window.showTextDocument(file.doc!, OPEN_OPTS)
    ted.revealRange(mkRange(Number(step.focus[1])), Vsc.TextEditorRevealType.AtTop)
    if (file.decorMap === undefined) return
    file.decorMap.forEach((v, k) => ted.setDecorations(v.type, [v.range]))
}

export async function open(uri: Vsc.Uri) {
    await Vsc.commands.executeCommand('vscode.open', uri, OPEN_OPTS)

}

export async function start(uri: Vsc.Uri, devmode?: boolean) {
    uri = Vsc.Uri.parse(`file://${uri.path}`)
    if (!initFlag) {
        initFlag = true
        curCtx.subscriptions.push(Vsc.window.registerWebviewViewProvider(ViewProvider.ID, new ViewProvider(curCtx)))
    }
    Vsc.commands.executeCommand('setContext', 'em-builder.activeTour', true)
    await Vsc.commands.executeCommand('workbench.view.extension.embuilder')
    await Vsc.commands.executeCommand(`${ViewProvider.ID}.focus`)

    let src = await Utils.readText(uri)
    curTour = Yaml.load(src) as Tour
    const metaUri = Vsc.Uri.joinPath(uri, '..', 'emtour-bundle')
    const meta = Yaml.load(await Utils.readText(metaUri)) as any
    const tnum = uri.path.split('/').pop()?.slice(0, 2)
    curTour!.uri = uri
    curTour!.bname = meta.title
    curTour!.tnum = tnum
    curTour.$dev = devmode

    let idx = 0
    src.split('\n').forEach((line, k) => {
        if (line.match(/^[\s\-]+cmds/)) curTour!.steps[idx++].srcLine = k + 1
    })

    if (reload) {
        reload = false
        stepIdx -= 1
        next()
        return
    }

    stepIdx = -1
    stepEnd = curTour!.steps.length - 1
    fileTab = []

    for (let fn of curTour!.files ?? []) {
        const baseUri = fn.startsWith('.') ? Utils.toursUri() : Utils.workUri()
        fileTab.push({ uri: Vsc.Uri.joinPath(baseUri, fn.replace(':', '/')), decorMap: new Map<string, Decor>() })
    }

    await closeAllExceptWelcome()
    await Vsc.commands.executeCommand('embuilder.showWelcome')

    if (curTour!.$dev) {
        await Vsc.window.showTextDocument(uri, { viewColumn: 2 })
        if (!watcher) watcher = Vsc.workspace.createFileSystemWatcher('**/*.emtour')
        watcher.onDidChange(uri => { reload = true; start(uri, curTour!.$dev) })
    }

    monitor()
    next()
}

async function execCmds() {
    for (const file of fileTab) {
        DecoratorFactory.clear(file)
    }
    const cmds = curTour!.steps[stepIdx].cmds ?? []
    try {
        for (let cmd of cmds) {
            let segs = cmd.trim().split(/\s+/)
            let file = segs.length > 1 && Number(segs[1]) ? fileTab[Number(segs[1]) - 1] : null
            switch (segs[0]) {
                case 'close': {
                    if (file!.openedTab) {
                        await Vsc.window.tabGroups.close(file!.openedTab)
                        file!.openedTab = undefined
                    }
                    break
                }
                case 'mark': {
                    DecoratorFactory.mark(file!, segs[2], Number(segs[3]))
                    break
                }
                case 'open': {
                    file!.doc = await Vsc.workspace.openTextDocument(file!.uri)
                    file!.ted = await Vsc.window.showTextDocument(file!.doc, OPEN_OPTS)
                    file!.openedTab = Vsc.window.tabGroups.activeTabGroup.activeTab
                    if (!(curTour!.$dev)) await Vsc.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession')
                    break
                }
                case 'view': {
                    await Vsc.commands.executeCommand('vscode.open', file!.uri, OPEN_OPTS)
                    file!.openedTab = Vsc.window.tabGroups.activeTabGroup.activeTab
                    break
                }
            }
        }
    } catch (err) { console.log(err) }
}

async function closeAllExceptWelcome() {
    for (const group of Vsc.window.tabGroups.all) {
        const toClose = group.tabs.filter(t => {
            const input = (t as any).input
            return input?.viewType !== 'embuilder.welcome'
        })
        if (toClose.length)
            await Vsc.window.tabGroups.close(toClose, true)
    }
}
function mkRange(line: number) {
    let pos = new Vsc.Position(line - 1, 0)
    return new Vsc.Range(pos, pos)
}

function monitor() {
    tedMonitor = Vsc.window.onDidChangeActiveTextEditor((ted) => {
        if (!ted) return
        for (let file of fileTab) {
            if (file.doc && file.doc.uri.toString() == ted.document.uri.toString()) {
                if (file.decorMap) file.decorMap.forEach((v, k) => ted.setDecorations(v.type, [v.range]))
                return
            }
        }
    })
}

export class ViewProvider implements Vsc.WebviewViewProvider {

    static readonly ID: string = 'em.tourGuide'

    private static curCtx: Vsc.ExtensionContext
    private static curView: Vsc.Webview
    private static cssText: string = ''

    static clear() {
        ViewProvider.curView.html = ''
    }

    static async render(uri: Vsc.Uri) {
        await ViewProvider.renderText(await Utils.readText(uri), [])
    }

    static async renderText(text: string, acts: ActionId[]) {

        const nonce = Utils.mkNonce()

        let ctx = ViewProvider.curCtx
        let cv = ViewProvider.curView

        if (!ViewProvider.cssText) {
            let cssName = Vsc.env.uiKind === Vsc.UIKind.Web ? 'style-win32.css' : 'style-win32.css' /// TODO: fix
            let cssUri = Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', cssName)
            ViewProvider.cssText = await Utils.readText(cssUri)
        }

        const codiconCss = cv.asWebviewUri(Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', 'codicon.css'))
        const materialCss = cv.asWebviewUri(Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', 'material-symbols-outlined.css'))

        const sansReg = cv.asWebviewUri(Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', 'carlito-v4-latin-regular.woff2'))
        const sansBold = cv.asWebviewUri(Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', 'carlito-v4-latin-700.woff2'))
        const sansItalic = cv.asWebviewUri(Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', 'carlito-v4-latin-italic.woff2'))

        const monoReg = cv.asWebviewUri(Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', 'JetBrainsMono-Regular.woff2'))
        const monoBold = cv.asWebviewUri(Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', 'JetBrainsMono-Bold.woff2'))
        const monoItalic = cv.asWebviewUri(Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', 'JetBrainsMono-Italic.woff2'))

        const fontCss = `
        @font-face {
            font-family: 'EMSans';
            src: url('${sansReg}') format('woff2');
            font-weight: 400;
            font-style: normal;
        }

        @font-face {
            font-family: 'EMSans';
            src: url('${sansBold}') format('woff2');
            font-weight: 600;
            font-style: normal;
        }

        @font-face {
            font-family: 'EMSans';
            src: url('${sansItalic}') format('woff2');
            font-weight: 400;
            font-style: italic;
        }

        @font-face {
            font-family: 'EMMono';
            src: url('${monoReg}') format('woff2');
            font-weight: 400;
            font-style: normal;
        }

        @font-face {
            font-family: 'EMMono';
            src: url('${monoBold}') format('woff2');
            font-weight: 700;
            font-style: normal;
        }

        @font-face {
            font-family: 'EMMono';
            src: url('${monoItalic}') format('woff2');
            font-weight: 400;
            font-style: italic;
        }
    `

        let body = Md.render(expandCmds(text, acts))
        const title = `${curTour!.bname}&ensp;&rarr;&ensp;Tour&thinsp;${curTour!.tnum}&thinsp;&middot;&thinsp;${curTour!.title}`
        let html = `
        <html lang="en" style="width:400px;">
        <head>
        <meta http-equiv="Content-Security-Policy"
            content="default-src 'none';
                        img-src ${cv.cspSource} https: data:;
                        style-src ${cv.cspSource} https: 'unsafe-inline';
                        font-src ${cv.cspSource} data:;
                        script-src 'nonce-${nonce}';">
        <link rel="stylesheet" href="${materialCss}" />
        <link rel="stylesheet" href="${codiconCss}" />
        <style>
            ${fontCss}
            ${ViewProvider.cssText}
        </style>
        </head>
        <body>
            <div class="em-frame">
                ${body}
                <div class="em-title">${title}</div>
                <div class="em-seqn">${stepIdx + 1} of ${stepEnd + 1}</div>
            </div>

            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi()
                document.addEventListener('click', (e) => {
                    const a = e.target.closest('a.cmd-bu')
                    if (!a) return
                    e.preventDefault()
                    vscode.postMessage({ kind: 'cmd', id: a.dataset.cmd })
                })
            </script>
        </body>
        </html>
    `
        cv.html = html
    }

    private view?: Vsc.Webview

    constructor(ctx: Vsc.ExtensionContext) {
        ViewProvider.curCtx = ctx
    }

    resolveWebviewView(webviewView: Vsc.WebviewView, context: Vsc.WebviewViewResolveContext<unknown>, token: Vsc.CancellationToken): void | Thenable<void> {
        webviewView.show()
        this.view = webviewView.webview
        this.view.options = {
            enableScripts: true,
            enableCommandUris: true
        }
        ViewProvider.curView = this.view
        ViewProvider.curView.onDidReceiveMessage(async (msg) => {
            if (msg?.kind === 'cmd')
                await Vsc.commands.executeCommand(msg.id)
        })
    }
}

function expandCmds(body: string, acts: ActionId[]): string {
    const dict = new Map<string, string>([
        ['$start', 'home'],
        ['$build', 'build'],
        ['$details', 'description'],
        ['$done', 'assignment_turned_in'],
        ['$extra', 'credit_score'],
        ['$look', 'search'],
        ['$peek', 'visibility'],
        ['$steps', 'footprint'],
        ['$todo', 'event_list'],
    ])
    const buttons = mkButtons(acts)
    const replFxn = ((s: string, g1: string, g2: string) => {
        let args = g1.split(',')
        // ⟪ ⟫
        let txt = g2.replace(/%\[(.+?)\](.*?)%/g, replFxn)
        switch (args[0]) {
            case 'bi':
                return `<span class="cmd-bi"><span class="material-symbols-outlined">${args[1]}</span></span>`
            case 'bm':
                return `<span class="cmd-bm">${BM_SVG.replace('$label', args[1])}&nbsp;</span>`
            case 'bu':
                return `<a class="cmd-bu" href="#" data-cmd="${args[2]}" title="${txt}"><span class="codicon codicon-${args[1]}"></span><span class="cmd-bu-label">${txt}</span></a>`
            case 'cb':
                return `<span class="cb codicon codicon-${args[1]}"></span>`
            case 'ci':
                return `<span class="codicon codicon-${args[1]}"></span>`
            case 'cd':
            case 'ce':
            case 'cf':
            case 'ck':
            case 'cn':
            case 'cs':
            case 'ct':
            case 'cu':
            case 'cx':
                return `<code class="cmd-${args[0]}">${txt}</code>`
            case 'dc':
                return `<span class="cmd-dc">${DC_SVG.replace('$label', args[1])}&nbsp;</span>`
            case 'em':
                return `<span class="em">${txt}</span>`
            case 'hc':
                return '<div class="em-happy">🙂&nbsp;Happy coding&ensp;💻</div>'
            case 'ht': {
                let sym = args[1].startsWith('$') ? dict.get(args[1]) : args[1]
                return `<h1><span class="material-symbols-outlined">${sym}</span>&nbsp;${txt}${buttons}</h1>`
            }
            case 'in': {
                return `<div class="em-info">${txt}</div>`
            }
            case 'le':
                return `<a class="cmd-le" href="${args[1]}"><span class="cmd-le">${txt}</a>`
            case 'uc':
                return '<div class="em-happy">🚧 Reopening Soon 🛠️</div>'
            default:
                return `<span style="color:red">${s}</span>`
        }
    })
    return body.replace(/{\[(.+?)\](.*?)}/g, replFxn)
}

function mkButtons(acts: ActionId[]): string {
    const std_actions = new Map<string, string>([
        ['$build', 'embuilder.build|build|build + load this file using EM•Script'],
        ['$reveal', 'embuilder.revealActiveUnit|target|reveal this file in EM•Builder'],
    ])
    let res = '<span class="em-actions">'
    for (const aid of acts) {
        const a = typeof aid === 'string' ? std_actions.get(aid)! : curTour!!.actions[aid - 1]
        const segs = a.split('|')
        res += `<a class="cmd-bu" data-cmd="${segs[0]}" data-tip="${segs[2]}"><span class="codicon codicon-${segs[1]}"></a>&ensp;`
    }
    return `${res}</span>`
}
