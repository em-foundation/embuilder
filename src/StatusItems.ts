import Fs from 'fs'
import Path from 'path'
import Vsc from 'vscode'

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
    init() {
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
        // refreshProps()  /// TODO
        this.setAux(name)
    }
    protected setAux(name: string) { }
    trim(name: string): string {
        return name.substring(this.pre.length).trim()
    }
}

export const setupC = new class Setup extends StatusItem {
    private static PRE = '$(gear)  '
    constructor() {
        super('setup', 'em.lang.SetupExtends', 'em.bindSetup', 'Setup – click to edit', '$(gear) Setup', Setup.PRE)
    }
    pickList(): string[] {
        return mkSetupNames().map(sn => `${Setup.PRE}${sn}`)
    }
}

export function init(ctx: Vsc.ExtensionContext) {
    let sbi = Vsc.window.createStatusBarItem(Vsc.StatusBarAlignment.Left);
    sbi.text = `$(terminal) EM•Script v${Utils.getVers()}`
    sbi.color = EM_COLOR
    sbi.show();
    ctx.subscriptions.push(sbi);
    setupC.init()
}

function mkSetupNames(): string[] {
    let res = new Array<string>();
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


