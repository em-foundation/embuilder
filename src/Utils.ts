import Cp from 'child_process'
import Vsc from 'vscode'

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

export function getProps(): ReadonlyMap<string, string> {
    return curPropMap
}

export function getVers(): string {
    return VERS.slice(0, VERS.lastIndexOf('.'))
}

export function getVersFull(): string {
    return VERS
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

export function unitPath(uri: Vsc.Uri): string {
    const segs = uri.path.split('/')
    return segs.slice(segs.length - 3).join('/')
}

export async function updateSettings(sect: string, key: string, val: any) {
    const conf = Vsc.workspace.getConfiguration(sect)
    await conf.update(key, val, Vsc.ConfigurationTarget.Workspace)
}

export function workPath(): string {
    return workUri().fsPath
}

export function workUri(): Vsc.Uri {
    return Vsc.Uri.joinPath(ROOT.uri, 'workspace')
}




