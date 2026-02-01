import Cp from 'child_process'
import Fs from 'fs'
import Path from 'path'
import Vsc from 'vscode'

export const PROP_BOARD = 'em.lang.BoardKind'
export const PROP_DISTRO = 'em.lang.Distro'
export const PROP_EXTENDS = 'em.lang.SetupExtends'
export const PROP_PROG = 'em.lang.Prog'
export const PROP_REQUIRES = 'em.lang.PackageRequires'

const ROOT = Vsc.workspace.workspaceFolders![0]
const VERS = spawnSync(['emscript', '--version'])

const curPropMap = new Map<string, string>()

const loggerC = new class Logger {
    readonly output = Vsc.window.createOutputChannel('EM•Script', 'em-log')
    addBreak = (flag: boolean) => {
        if (!flag) return
        this.output.appendLine('----')
        this.output.show(true)
    }
    addErr = async (msg: string) => { this.writeEntry('E', msg) }
    addInfo = async (msg: string) => { this.writeEntry('I', msg) }
    private writeEntry = (kind: string, msg: string) => {
        msg.split('\n').forEach(ln => {
            if (ln.length) this.output.appendLine(`${(new Date).toISOString()} ${kind}: ${ln.trimEnd()}`)
        })
        this.output.show(true)
    }
}

export async function focusBrowser() {
    await Vsc.commands.executeCommand('workbench.view.extension.embrowser')
    await Vsc.commands.executeCommand('embrowser.content.focus')
}

export function getBoard(): string {
    return curPropMap.get(PROP_BOARD) ?? ''
}

export function getDefaultSetup(): string {
    return curPropMap.get(PROP_EXTENDS) ?? ''
}

export function getDistro(): { package: string, bucket: string } | null {
    const ds = curPropMap.get(PROP_DISTRO)
    if (ds == undefined) return null
    const sa = ds.split('://')
    return { package: sa[0], bucket: sa[1] }
}

export function getProps(): ReadonlyMap<string, string> {
    return curPropMap
}

export function getVers(): string {
    return VERS.slice(0, VERS.lastIndexOf('.'))
}

export function getVersFull(): string {
    return VERS
}

export function isCodespace(): boolean {
    const e = process.env
    return !!(e.CODESPACES || e.CODESPACE_NAME || e.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN)
}

export async function newContainer(uri: Vsc.Uri, cks: string): Promise<Vsc.Uri | null> {
    const cname = await Vsc.window.showInputBox({ placeHolder: `${cks} name` })
    if (!cname) return null
    if (!(cname.match(/^\w(\w|\d|\.)*$/))) {
        Vsc.window.showErrorMessage(`'${cname}' is not a valid identifier`)
        return null
    }
    const ppath = uri.fsPath
    const cpath = Path.join(ppath, cname)
    if (Fs.existsSync(cpath)) {
        Vsc.window.showErrorMessage(`${cks} '${cname}' already exists`)
        return null
    }
    Fs.mkdirSync(cpath)
    return Vsc.Uri.joinPath(uri, cname)
}

export async function newUnit(uri: Vsc.Uri, uks: string, content: string): Promise<Vsc.Uri | null> {
    let uname = await Vsc.window.showInputBox({ placeHolder: `${uks} name` })
    if (!uname) return null
    if (!(uname.match(/^\w(\w|\d)*$/))) {
        Vsc.window.showErrorMessage(`'${uname}' is not a valid identifier`)
        return null
    }
    let ppath = uri.fsPath
    let upath = Path.join(ppath, `${uname}.em.ts`)
    let pname = Path.basename(ppath)
    if (Fs.existsSync(upath)) {
        Vsc.window.showErrorMessage(`unit '${pname}/${uname}' already exists`)
        return null
    }
    Fs.writeFileSync(upath, content)
    Vsc.commands.executeCommand('vscode.open', Vsc.Uri.file(upath), { preview: true })
    return Vsc.Uri.joinPath(uri, `${uname}.em.ts`)
}

export async function provision(ctx: Vsc.ExtensionContext) {
    if (Fs.existsSync(toolsPath())) return
    await Vsc.window.withProgress(
        { location: Vsc.ProgressLocation.Notification, title: 'EM•Script: provisioning…', cancellable: false },
        async () => {
            console.log('*** provision: npm ci')
            const r = Cp.spawnSync('npm', ['ci'], {
                cwd: rootPath(),
                shell: true,
                encoding: 'utf8'
            })

            if (r.status) {
                const msg = (r.stderr || r.stdout || '').trim()
                throw new Error(msg || `npm ci failed: status = ${r.status}, msg = ${msg}`)
            }
        }
    )
}

export function refreshProps() {
    const lines = spawnSync(['emscript', 'properties']).split('\n')
    curPropMap.clear()
    for (const ln of lines) {
        const m = ln.match(/^([\w.]+)\s+=\s+(.*)$/)
        if (!m) continue
        curPropMap.set(m[1], m[2])
    }
}

export function rootPath(): string {
    return rootUri().fsPath
}

export function rootUri(): Vsc.Uri {
    return ROOT.uri
}

export function spawnLog(cli: string[]) {
    const cwd = workPath()

    return new Promise<number>((resolve, reject) => {
        const proc = Cp.spawn('npx', cli, {
            cwd,
            shell: process.platform === 'win32'
        })

        proc.stdout.setEncoding('utf8')
        proc.stdout.on('data', (data) => loggerC.addInfo(data))

        proc.stderr.setEncoding('utf8')
        proc.stderr.on('data', (data) => loggerC.addErr(data))

        proc.on('error', (err) => {
            loggerC.addErr(err.message)
            reject(err)
        })

        proc.on('close', (code, signal) => {
            loggerC.addBreak(true)
            if (code === 0) resolve(0)
            else reject(new Error(`emscript failed: code=${code} signal=${signal ?? ''}`.trim()))
        })
    })
}

export function spawnSync(cli: string[]): string {
    const cwd = workPath()
    const proc = Cp.spawnSync('npx', cli, {
        cwd,
        encoding: 'utf8',
        shell: process.platform === 'win32'
    })
    const err = proc.error
    if (err) console.log(`*** spawnSync: ${err}`)
    return proc.stdout ?? ''

}

export function toolsPath(): string {
    return toolsUri().fsPath
}

export function toolsUri(): Vsc.Uri {
    return Vsc.Uri.joinPath(ROOT.uri, 'tools')
}

export function unitPath(uri: Vsc.Uri): string {
    const segs = uri.path.split('/')
    return segs.slice(segs.length - 3).join('/')
}

export async function updateSettings(sect: string, key: string, val: any) {
    const conf = Vsc.workspace.getConfiguration(sect)
    await conf.update(key, val, Vsc.ConfigurationTarget.Workspace)
}

export async function updateVcd(uri: Vsc.Uri) {
    const updates: Array<[string, string]> = [
        ['D0 $end', 'D0--AppOut-- $end'],
        ['D1 $end', 'D1---DbgA--- $end'],
        ['D2 $end', 'D2---DbgB--- $end'],
        ['D3 $end', 'D3---DbgC--- $end'],
        ['D4 $end', 'D4---DbgD--- $end'],
        ['D5 $end', 'D5--AppBut-- $end'],
        ['D6 $end', 'D6--AppLed-- $end'],
        ['D7 $end', 'D7--SysLed-- $end'],
    ]
    const buf = await Vsc.workspace.fs.readFile(uri)
    let txt = Buffer.from(buf).toString('utf8')
    for (const [from, to] of updates) {
        txt = txt.replace(from, to)
    }
    await Vsc.workspace.fs.writeFile(uri, Buffer.from(txt, 'utf8'))
}

export function workPath(): string {
    return workUri().fsPath
}

export function workUri(): Vsc.Uri {
    return Vsc.Uri.joinPath(ROOT.uri, 'workspace')
}
