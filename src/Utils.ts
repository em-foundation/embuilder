import Cp from 'child_process'
import Vsc from 'vscode'

const rootFolder = Vsc.workspace.workspaceFolders![0]
const version = spawnSync(['emscript', '--version'])

export function getVers(): string {
    return version.slice(0, version.lastIndexOf('.'))
}

export function getVersFull(): string {
    return version
}

export function rootPath(): string {
    return rootUri().fsPath
}

export function rootUri(): Vsc.Uri {
    return rootFolder.uri
}

function spawnSync(cli: string[]): string {
    const cwd = rootUri().fsPath
    const proc = Cp.spawnSync('npx', cli, {
        cwd,
        encoding: 'utf8',
        shell: process.platform === 'win32'
    })
    return proc.stdout ?? ''

}

export async function updateSettings(sect: string, key: string, val: any) {
    const conf = Vsc.workspace.getConfiguration(sect)
    await conf.update(key, val, Vsc.ConfigurationTarget.Workspace)
}

export function workPath(): string {
    return workUri().fsPath
}

export function workUri(): Vsc.Uri {
    return Vsc.Uri.joinPath(rootFolder.uri, 'workspace')
}




