import Fs from 'fs'
import Path from 'path'
import Vsc from 'vscode'
import Yaml from 'js-yaml'

import * as Utils from './Utils'

export const EM_COLOR = '#00f0b5'

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
        const distro = Utils.getDistro()
        if (!distro) return []
        const file = Path.join(Utils.workPath(), distro.package, distro.bucket, 'em-boards')
        if (!Fs.existsSync(file)) return []
        let yobj = Yaml.load(String(Fs.readFileSync(file))) as Object
        let bset = new Set<string>()
        Object.keys(yobj).filter(k => !(k.startsWith('$'))).forEach(k => bset.add(`${Board.PRE}${k}`))
        const res = Array.from(bset.keys()).sort()
        res.push(`${Board.PRE}<bare-metal>`)
        return res
        // return mkBoardNames().map(sn => `${Board.PRE}${sn}`)
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
    async setAux(name: string) {
        let brd = ''
        const cur_brd = boardC.get()
        if (name) {
            brd = Utils.getBoard()
            for (const b of boardC.pickList()) {
                const bn = b.split('  ')[1]
                if (cur_brd == bn) {
                    brd = cur_brd
                    break
                }
            }
        }
        await boardC.set(brd)
    }
}

export const vcdC = new class Download {
    private timeout: NodeJS.Timeout | undefined
    private readonly status = Vsc.window.createStatusBarItem(Vsc.StatusBarAlignment.Right)
    private watcher = Vsc.workspace.createFileSystemWatcher('**/wokwi.vcd')
    constructor() {
        if (Utils.isCodespace()) {
            this.status.text = '$(desktop-download) Save wokwi.vcd $(arrow-right) Reload in PulseView $(pulse)'
            this.status.command = 'embrowser.downloadVcd'
        } else {
            this.status.text = 'Reload in PulseView $(pulse)'
            this.status.command = undefined
        }
        this.status.color = EM_COLOR
        this.watcher.onDidCreate(() => this.start())
        this.watcher.onDidChange(() => this.start())
    }
    init(ctx: Vsc.ExtensionContext) {
        ctx.subscriptions.push(this.status)
        ctx.subscriptions.push(this.watcher)
        this.status.hide()
    }
    start() {
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = setTimeout(() => this.stop(), 10_000)
        this.status.show()
    }
    stop() {
        if (this.timeout) clearTimeout(this.timeout)
        this.status.hide()
    }
}

export function init(ctx: Vsc.ExtensionContext) {
    const vers = Vsc.window.createStatusBarItem(Vsc.StatusBarAlignment.Left)
    vers.text = `$(terminal) EM•Script v${Utils.getVers()}`
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
                res.push(`${bn}://${k}`)
            }
        }
    }
    res.sort()
    res.push('<bare-metal>')
    return res
}

function mkSetupNames(): string[] {
    let res = new Array<string>()
    const wpath = Utils.workPath()
    for (const pn of Fs.readdirSync(wpath)) {
        const ppath = Path.join(wpath, pn)
        if (!Fs.statSync(ppath).isDirectory() || pn.startsWith('.')) continue
        for (const fn of Fs.readdirSync(ppath)) {
            const m = fn.match(/^setup-(.+)\.ini$/)
            if (m == undefined) continue
            res.push(`${pn}://${m[1]}`)
        }
    }
    return res
}


