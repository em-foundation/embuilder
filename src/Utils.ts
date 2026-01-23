import Cp from 'child_process'
import Vsc from 'vscode'

const ROOT = Vsc.workspace.workspaceFolders![0]
const VERS = spawnSync(['emscript', '--version'])

const curPropMap = new Map<string, string>()

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




