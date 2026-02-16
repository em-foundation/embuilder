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
    doc?: Vsc.TextDocument
    decorMap?: Map<string, Decor>
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
    mark(file: File, label: string, line: number) {
        let decor: Decor = {
            type: this.create(label),
            range: mkRange(line),
        }
        if (!file.decorMap) {
            file.decorMap = new Map<string, Decor>()
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
    if (!file.decorMap) return
    file.decorMap.forEach((v, k) => ted.setDecorations(v.type, [v.range]))
}

export async function start(uri: Vsc.Uri, devmode?: boolean) {
    uri = Vsc.Uri.parse(`file://${uri.path}`)
    if (!initFlag) {
        initFlag = true
        curCtx.subscriptions.push(Vsc.window.registerWebviewViewProvider(ViewProvider.ID, new ViewProvider(curCtx)))
    }
    Vsc.commands.executeCommand('setContext', 'em-builder.activeTour', true)
    await Vsc.commands.executeCommand('workbench.view.extension.embrowser')
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
        fileTab.push({ uri: Vsc.Uri.joinPath(baseUri, fn.replace(':', '/')) })
    }

    await closeAllExceptWelcome()
    await Vsc.commands.executeCommand('embrowser.showWelcome')

    if (curTour!.$dev) {
        await Vsc.window.showTextDocument(uri, { viewColumn: 2 })
        if (!watcher) watcher = Vsc.workspace.createFileSystemWatcher('**/*.emtour')
        watcher.onDidChange(uri => { reload = true; start(uri, curTour!.$dev) })
    }

    monitor()
    next()
}

async function execCmds() {
    const cmds = curTour!.steps[stepIdx].cmds ?? []
    try {
        for (let cmd of cmds) {
            let segs = cmd.trim().split(/\s+/)
            let file = segs.length > 1 && Number(segs[1]) ? fileTab[Number(segs[1]) - 1] : null
            switch (segs[0]) {
                case 'build': {
                    // TODO: if (!(curTour!.$dev)) Cmd.build(file!.uri, segs.slice(2))
                    break
                }
                case 'close': {
                    break
                }
                case 'mark': {
                    DecoratorFactory.mark(file!, segs[2], Number(segs[3]))
                    break
                }
                case 'open': {
                    file!.doc = await Vsc.workspace.openTextDocument(file!.uri)
                    await Vsc.window.showTextDocument(file!.doc, OPEN_OPTS)
                    if (!(curTour!.$dev)) await Vsc.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession')
                    break
                }
                case 'view': {
                    await Vsc.commands.executeCommand('vscode.open', file!.uri, OPEN_OPTS)
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
            return input?.viewType !== 'embrowser.welcome'
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

        let body = Md.render(expandCmds(text, acts))
        const title = `${curTour!.bname}&ensp;&rarr;&ensp;Tour&thinsp;${curTour!.tnum}&thinsp;&middot;&thinsp;${curTour!.title}`
        let html = `
            <html lang="en" style="width:400px;">
            <head>
            <meta http-equiv="Content-Security-Policy"
                content="default-src 'none';
                            img-src ${cv.cspSource} https: data:;
                            style-src ${cv.cspSource} https: 'unsafe-inline';
                            font-src https: data:;
                            script-src 'nonce-${nonce}';">
            <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />
            <link rel="stylesheet" href="https://unpkg.com/@vscode/codicons/dist/codicon.css" />
            <style>
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
        let txt = g2.replace(/⟪\[(.+?)\](.*?)⟫/g, replFxn)
        switch (args[0]) {
            case 'bi':
                return `<span class="cmd-bi"><span class="material-symbols-outlined">${args[1]}</span></span>`
            case 'bm':
                return `${BM_SVG.replace('$label', args[1])}&nbsp;`
            case 'bu':
                return `<a class="cmd-bu" href="#" data-cmd="${args[2]}" title="${txt}"><span class="codicon codicon-${args[1]}"></span><span class="cmd-bu-label">${txt}</span></a>`
            case 'ci':
                return `<span class="codicon codicon-${args[1]}"></span>`
            case 'cd':
            case 'ce':
            case 'cf':
            case 'ck':
            case 'cn':
            case 'ct':
            case 'cu':
            case 'cx':
                return `<code class="cmd-${args[0]}">${txt}</code>`
            case 'em':
                return `<span class="em">${txt}</span>`
            case 'hc':
                return '<div class="em-happy">🙂&nbsp;Happy coding&ensp;💻</div>'
            case 'ht': {
                let sym = args[1].startsWith('$') ? dict.get(args[1]) : args[1]
                return `<h1><span class="material-symbols-outlined">${sym}</span>&nbsp;${txt}${buttons}</h1>`
            }
            case 'le':
                return `<a class="cmd-le" href="${args[1]}"><span class="cmd-le">${txt}</a>`
            default:
                return `<span style="color:red">${s}</span>`
        }
    })
    return body.replace(/{\[(.+?)\](.*?)}/g, replFxn)
}

function mkButtons(acts: ActionId[]): string {
    const std_actions = new Map<string, string>([
        ['$build', 'embrowser.build|build|build/load this file using EM•Script'],
        ['$reveal', 'embrowser.revealActiveUnit|target|reveal this file in EM•Browser'],
    ])
    let res = '<span class="em-actions">'
    for (const aid of acts) {
        const a = typeof aid === 'string' ? std_actions.get(aid)! : curTour!!.actions[aid - 1]
        const segs = a.split('|')
        res += `<a class="cmd-bu" data-cmd="${segs[0]}" data-tip="${segs[2]}"><span class="codicon codicon-${segs[1]}"></a>&ensp;`
    }
    return `${res}</span>`
}
