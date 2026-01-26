import * as MdMod from 'markdown-it'
import * as Vsc from 'vscode'
import * as Yaml from 'js-yaml'

const Md = new MdMod.default({ html: true })
const UTF8 = new TextDecoder('utf-8')

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
    srcLine?: number
}

interface Tour {
    readonly title: string
    readonly $dev?: boolean
    readonly files: string[]
    readonly steps: Step[]
    uri?: Vsc.Uri
}

const DEC_REND_OPTS: Vsc.DecorationRenderOptions = {
    overviewRulerLane: Vsc.OverviewRulerLane.Full
}

const DOC_OPTS: Vsc.TextDocumentShowOptions = { viewColumn: 1, preview: false }

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

async function readText(uri: Vsc.Uri): Promise<string> {
    return UTF8.decode(await Vsc.workspace.fs.readFile(uri))
}

export async function init(ctx: Vsc.ExtensionContext) {
    curCtx = ctx
    await Vsc.commands.executeCommand(`${ViewProvider.ID}.removeView`)
}

export async function end() {
    let ted0: Vsc.TextEditor | null = null
    for (let file of fileTab) {
        if (!file.doc) continue
        let ted = await Vsc.window.showTextDocument(file.doc, DOC_OPTS)
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
    await Vsc.commands.executeCommand(`${ViewProvider.ID}.removeView`)
    Vsc.commands.executeCommand('setContext', 'em-builder.activeTour', false)
    if (ted0) await Vsc.window.showTextDocument(ted0.document, DOC_OPTS)
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
    let uri = curTour.uri!
    await end()
    await start(uri)
}

async function sync() {
    let step = curTour!.steps[stepIdx]
    if (curTour!.$dev) {
        let ted = await Vsc.window.showTextDocument(curTour!.uri!, { viewColumn: 2 })
        let ln = step.srcLine && stepIdx != 0 ? step.srcLine : 1
        ted.revealRange(mkRange(Number(ln)), Vsc.TextEditorRevealType.AtTop)
    }
    await ViewProvider.renderText(step.text)
    if (!step.focus) return
    let file = fileTab[step.focus[0] - 1]
    let ted = await Vsc.window.showTextDocument(file.doc!, DOC_OPTS)
    ted.revealRange(mkRange(Number(step.focus[1])), Vsc.TextEditorRevealType.AtTop)
    if (!file.decorMap) return
    file.decorMap.forEach((v, k) => ted.setDecorations(v.type, [v.range]))
}

export async function start(uri: Vsc.Uri) {
    console.log(`start ${initFlag}`)
    if (!initFlag) {
        initFlag = true
        curCtx.subscriptions.push(Vsc.window.registerWebviewViewProvider(ViewProvider.ID, new ViewProvider(curCtx)))
    }
    Vsc.commands.executeCommand('setContext', 'em-builder.activeTour', true)
    await Vsc.commands.executeCommand(`${ViewProvider.ID}.focus`)

    let src = await readText(uri)
    curTour = Yaml.load(src) as Tour
    curTour!.uri = uri

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

    const ws = Vsc.workspace.workspaceFolders?.[0]?.uri
    if (!ws) return

    for (let fn of curTour!.files) {
        fileTab.push({ uri: Vsc.Uri.joinPath(ws, 'workspace', fn.replace(':', '/')) })
    }

    Vsc.window.tabGroups.all.forEach(tg => Vsc.window.tabGroups.close(tg))

    if (curTour!.$dev) {
        await Vsc.window.showTextDocument(uri, { viewColumn: 2 })
        if (!watcher) watcher = Vsc.workspace.createFileSystemWatcher('**/*.emtour')
        watcher.onDidChange(uri => { reload = true; start(uri) })
    }

    monitor()
    next()
}

async function execCmds() {
    try {
        for (let cmd of curTour!.steps[stepIdx].cmds) {
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
                    await Vsc.window.showTextDocument(file!.doc, DOC_OPTS)
                    if (!(curTour!.$dev)) await Vsc.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession')
                    break
                }
            }
        }
    } catch (err) { console.log(err) }
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

    static readonly ID: string = 'em.toursView'

    private static curCtx: Vsc.ExtensionContext
    private static curView: Vsc.Webview
    private static cssText: string = ''

    static clear() {
        ViewProvider.curView.html = ''
    }

    static async render(uri: Vsc.Uri) {
        await ViewProvider.renderText(await readText(uri))
    }

    static async renderText(text: string) {
        let ctx = ViewProvider.curCtx
        let cv = ViewProvider.curView

        if (!ViewProvider.cssText) {
            let cssName = Vsc.env.uiKind === Vsc.UIKind.Web ? 'style-win32.css' : 'style-win32.css' /// TODO: fix
            let cssUri = Vsc.Uri.joinPath(ctx.extensionUri, 'tour-resources', cssName)
            ViewProvider.cssText = await readText(cssUri)
        }

        let body = Md.render(expandCmds(text))
        let html = `
            <html lang="en" style="width:400px;">
            <head>
            <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />
            <link rel="stylesheet" href="https://unpkg.com/@vscode/codicons/dist/codicon.css" />
            <style>
                ${ViewProvider.cssText}
            </style>
            </head>
            <body>
                <div class="em-frame">
                    ${body}
                    <div class="em-title">${curTour!.title}</div>
                    <div class="em-seqn">${stepIdx + 1} of ${stepEnd + 1}</div>
                </div>
            </body>
            </html>
        `
        cv.html = html
    }

    private view?: Vsc.Webview

    constructor(ctx: Vsc.ExtensionContext) {
        console.log(`ctx = ${ctx}`)
        ViewProvider.curCtx = ctx
    }

    resolveWebviewView(webviewView: Vsc.WebviewView, context: Vsc.WebviewViewResolveContext<unknown>, token: Vsc.CancellationToken): void | Thenable<void> {
        webviewView.show()
        this.view = webviewView.webview
        this.view.options = {
            enableCommandUris: true
        }
        ViewProvider.curView = this.view
    }
}

function expandCmds(body: string): string {
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
    const replFxn = ((s: string, g1: string, g2: string) => {
        let args = g1.split(',')
        let txt = g2
        switch (args[0]) {
            case 'bi':
                return `<span class="cmd-bi"><span class="material-symbols-outlined">${args[1]}</span></span>`
            case 'bm':
                return `${BM_SVG.replace('$label', args[1])}&nbsp;`
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
            case 'ht': {
                let sym = args[1].startsWith('$') ? dict.get(args[1]) : args[1]
                return `<h1><span class="material-symbols-outlined">${sym}</span>&nbsp;${txt}</h1>`
            }
            case 'le':
                return `<a class="cmd-le" href="${args[1]}"><span class="cmd-le">${txt}</a>`
            default:
                return `<span style="color:red">${s}</span>`
        }
    })
    return body.replace(/{\[(.+?)\](.*?)}/g, replFxn)
}
