import Cp from 'child_process'
import Vsc from 'vscode'

const wf = Vsc.workspace.workspaceFolders?.[0]
const cwd = wf?.uri.fsPath

const version = spawnSync(['emscript', '--version'])

export function getVersFull(): string {
    return version
}

function spawnSync(cli: string[]): string {
    const proc = Cp.spawnSync('npx', cli, {
        cwd,
        encoding: 'utf8',
        shell: process.platform === 'win32'
    })
    return proc.stdout ?? ''

}