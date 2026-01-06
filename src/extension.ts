import * as Vsc from 'vscode'

const EXCLUDES = {
    ".clang-format": true,
    ".gitignore": true,
    ".prettierrc": true,
    "LICENSE": true,
    "package.json": true,
    "package-lock.json": true,
    "README.md": true,
    "tsconfig.json": true,
    "tsconfig.base.json": true,
    "node_modules": true,
    ".vscode": true,
}

export async function activate(ctx: Vsc.ExtensionContext) {
    Vsc.window.showInformationMessage("EM•Script Browser activated")
    const ws = Vsc.workspace.workspaceFolders?.[0]
    if (!ws) return
    await Vsc.workspace.getConfiguration('files').update('exclude', EXCLUDES, Vsc.ConfigurationTarget.Workspace)
    await Vsc.workspace.getConfiguration().update('git.enabled', false, Vsc.ConfigurationTarget.Workspace)
}

export function deactivate() {
}
