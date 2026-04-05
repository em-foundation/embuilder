import Fs from 'fs'
import Path from 'path'
import Vsc from 'vscode'
import Yaml from 'js-yaml'

import * as Utils from './Utils'

export const EM_COLOR = '#00f0b5'
export const VCD_COLOR = '#f0b000'

abstract class StatusItem {
    private static UNK = '<empty>'
    private static COMMENT = '## **** DO NOT EDIT THIS LINE ****'
    private readonly key: string
    private readonly pre: string
    private readonly prop: string
    private readonly status = Vsc.window.createStatusBarItem(Vsc.StatusBarAlignment.Left)
    private readonly title: string
    constructor(key: string, prop: string, cmd: string, tip: string, title: string, pre: string) {
        this.key = key
        this.pre = pre
        this.prop = prop
        this.status.command = cmd
        this.status.tooltip = tip
        this.status.color = EM_COLOR
        this.title = title
    }
    private display(name: string) {
        const text = name ? name : StatusItem.UNK
        this.status.text = `${this.title} – ${text}`
        this.status.show()
    }
    get(): string {
        const conf = Vsc.workspace.getConfiguration('emscript', Utils.rootUri())
        const res = conf.get(this.key) as string
        return res
    }
    init(ctx: Vsc.ExtensionContext) {
        ctx.subscriptions.push(this.status)
        this.display('')
    }
    abstract pickList(): string[]
    async set(name: string) {
        name = (name == '<empty>') ? '' : name
        this.display(name)
        Utils.updateSettings('emscript', this.key, name ? name : undefined)
        const ipath = Path.join(Utils.workPath(), 'emscript.ini')
        if (!Fs.existsSync(ipath)) return  // should always exist ???
        let lines = Fs.readFileSync(ipath, 'utf-8').split('\n')
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i].trim()
            if (!ln.endsWith(StatusItem.COMMENT)) break
            if (!ln.startsWith(this.prop)) continue
            lines.splice(i, 1)
        }
        if (name != '') {
            lines.unshift(`${this.prop} = ${name}   ${StatusItem.COMMENT}`)
        }
        Fs.writeFileSync(ipath, Buffer.from(lines.join('\n'), 'utf-8'))
        Utils.refreshProps()
        this.setAux(name)
    }
    protected setAux(name: string) { }
    trim(name: string): string {
        return name.substring(this.pre.length).trim()
    }
}

export const boardC = new class Board extends StatusItem {
    private static PRE = '$(circuit-board)  '
    constructor() {
        super('board', Utils.PROP_BOARD, 'em.bindBoard', 'Board – click to edit', '$(circuit-board) Board', Board.PRE)
    }
    pickList(): string[] {
        return mkBoardNames().map(sn => `${Board.PRE}${sn}`)
    }
    async setAux(name: string) {
        if (!name || name == '<empty' || name == '<bare-metal>') {
            await setupC.set('')
            return
        }
        const [pn, bn] = mkNames(name)
        await setupC.set(`${pn}://default`)
        const bp = Path.join(Utils.workPath(), pn, `Board-${bn}.png`)
        if (!Fs.existsSync(bp)) return
        await Vsc.commands.executeCommand('vscode.open', Vsc.Uri.file(bp), { viewColumn: 1, preview: false })
    }
}

export const setupC = new class Setup extends StatusItem {
    private static PRE = '$(gear)  '
    constructor() {
        super('setup', Utils.PROP_EXTENDS, 'em.bindSetup', 'Setup – click to edit', '$(gear) Setup', Setup.PRE)
    }
    pickList(): string[] {
        return mkSetupNames().map(sn => `${Setup.PRE}${sn}`)
    }
}

export const vcdC = new class Download {
    private static VCD_FILE = 'wokwi.vcd'
    private timeout: NodeJS.Timeout | undefined
    private readonly status = Vsc.window.createStatusBarItem(Vsc.StatusBarAlignment.Right)
    constructor() {
        this.status.text = `Reload '${Download.VCD_FILE}' in PulseView  $(pulse)`
        this.status.color = VCD_COLOR
    }
    file() {
        return Download.VCD_FILE
    }
    init(ctx: Vsc.ExtensionContext) {
        ctx.subscriptions.push(this.status)
        this.status.hide()
    }
    start() {
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = setTimeout(() => this.stop(), 10_000)
        this.status.show()
    }
    async stop() {
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = undefined
        this.status.hide()
        await Utils.focusBuilder()
    }
    uri() {
        return Vsc.Uri.joinPath(Utils.rootUri(), Download.VCD_FILE)
    }
}

export function init(ctx: Vsc.ExtensionContext) {
    const vers = Vsc.window.createStatusBarItem(Vsc.StatusBarAlignment.Left)
    vers.text = `$(terminal) EM•Script v${Utils.getVersCli()}`
    vers.color = EM_COLOR
    vers.show()
    ctx.subscriptions.push(vers)
    boardC.init(ctx)
    setupC.init(ctx)
    vcdC.init(ctx)
}

function mkBoardNames(): string[] {
    let res = new Array<string>()
    const wpath = Utils.workPath()
    for (const pn of Fs.readdirSync(wpath)) {
        const ppath = Path.join(wpath, pn)
        if (!Fs.statSync(ppath).isDirectory() || pn.startsWith('.')) continue
        for (const bn of Fs.readdirSync(ppath)) {
            const bpath = Path.join(ppath, bn, 'em-boards')
            if (!Fs.existsSync(bpath)) continue
            const yobj = Yaml.load(String(Fs.readFileSync(bpath))) as Object
            for (const k of Object.keys(yobj)) {
                if (k.startsWith('$')) continue
                res.push(`${mkNames(bn)[0]}://${k}`)
            }
        }
    }
    res.sort()
    res.push('<bare-metal>')
    res.push('<empty>')
    return res
}

function mkNames(brd: string): [string, string] {
    const segs = brd.split('://')
    return [segs[0].replace('.distro', ''), segs[1]]
}

function mkSetupNames(): string[] {
    let res = new Array<string>()
    const brd = boardC.get()
    if (!brd) return []
    const distro = (brd == '<bare-metal>') ? '' : mkNames(brd)[0]
    const wpath = Utils.workPath()
    for (const pn of Fs.readdirSync(wpath)) {
        const ppath = Path.join(wpath, pn)
        if (!Fs.statSync(ppath).isDirectory() || pn.startsWith('.')) continue
        if (distro && distro != pn) continue
        for (const fn of Fs.readdirSync(ppath)) {
            const m = fn.match(/^setup-(.+)\.ini$/)
            if (m == undefined) continue
            res.push(`${pn}://${m[1]}`)
        }
    }
    return res
}


