import * as Vsc from 'vscode'

export async function activate(ctx: Vsc.ExtensionContext) {
    Vsc.window.showInformationMessage("EM•Script Browser activated")
    const ws = Vsc.workspace.workspaceFolders?.[0]
    if (!ws) return
    const repoRoot = ws.uri
    const logicalRoot = Vsc.Uri.joinPath(repoRoot, 'workspace')
    await ctx.workspaceState.update('ems.logicalRoot', logicalRoot.toString())
    await Vsc.workspace.getConfiguration('files').update(
        'exclude',
        { 'tsconfig.json': true, 'tsconfig.base.json': true },
        Vsc.ConfigurationTarget.Workspace
    )
}

export function deactivate() {
}
