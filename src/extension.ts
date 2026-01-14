import * as Vsc from 'vscode'

import * as ContentView from './ContentView'
import * as SemTok from './SemTok'

export async function activate(ctx: Vsc.ExtensionContext) {
    console.log('*** EM•Script Browser activate: begin')
    try {
        Vsc.window.showInformationMessage('EM•Script Browser activated')
        const ws = Vsc.workspace.workspaceFolders?.[0]
        if (!ws) return

        const view = new ContentView.Provider(ctx.extensionUri)
        ctx.subscriptions.push(
            Vsc.window.registerTreeDataProvider('embrowser.content', view)
        )

        ctx.subscriptions.push(
            Vsc.languages.registerDocumentSemanticTokensProvider(
                { pattern: '**/*.em.ts' },
                new SemTok.Provider(),
                SemTok.legend()
            )
        )

        ctx.subscriptions.push(
            Vsc.commands.registerCommand('embrowser.openReadonly', async (uri: Vsc.Uri) => {
                await Vsc.commands.executeCommand('vscode.open', uri, { preview: true })
                await Vsc.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession')
            })
        )

        const cfg = Vsc.workspace.getConfiguration()
        await cfg.update('workbench.colorTheme', 'EM•Script Dark', Vsc.ConfigurationTarget.Workspace)
        // await cfg.update('git.enabled', false, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('breadcrumbs.enabled', false, Vsc.ConfigurationTarget.Workspace)

        const cfg_ed = Vsc.workspace.getConfiguration('editor')
        await cfg_ed.update('fontSize', 13, Vsc.ConfigurationTarget.Workspace)
        await cfg_ed.update('minimap.enabled', false, Vsc.ConfigurationTarget.Workspace)

        const cfg_ts = Vsc.workspace.getConfiguration('typescript')
        cfg_ts.update('disableAutomaticTypeAcquisition', true, Vsc.ConfigurationTarget.Workspace)
        cfg_ts.update('tsserver.web.typeAcquisition.enabled', false, Vsc.ConfigurationTarget.Workspace)

        const cfg_ws = Vsc.workspace.getConfiguration('workbench')
        await cfg_ws.update('tree.indent', 20, Vsc.ConfigurationTarget.Workspace)

    } catch (e) {
        console.log('*** EM•Script Browser activate: fail')
        Vsc.window.showWarningMessage(`embrowser activate failed: ${String(e)}`)
    }

    console.log('*** EM•Script Browser activate: begin')
}

export function deactivate() {
}
