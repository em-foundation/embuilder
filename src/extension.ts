import * as Vsc from 'vscode'

import * as ContentView from './ContentView'
// import * as SemTok from './SemTok'

export async function activate(ctx: Vsc.ExtensionContext) {
    console.log("EM•Script Browser activated")
    Vsc.window.showInformationMessage("EM•Script Browser activated")
    const ws = Vsc.workspace.workspaceFolders?.[0]
    if (!ws) return

    const view = new ContentView.Provider(ctx.extensionUri)
    ctx.subscriptions.push(
        Vsc.window.registerTreeDataProvider("embrowser.content", view)
    )

    // ctx.subscriptions.push(
    //     Vsc.languages.registerDocumentSemanticTokensProvider(
    //         { pattern: "**/*.em.ts" },
    //         new SemTok.Provider(),
    //         SemTok.legend()
    //     )
    // )

    const onEditor = async (ted?: Vsc.TextEditor) => {
        if (!ted) return
        if (ted.document.uri.scheme !== 'file' && ted.document.uri.scheme !== 'vscode-vfs') return
        await setReadonlyIfPossible()
    }

    ctx.subscriptions.push(Vsc.window.onDidChangeActiveTextEditor(onEditor))
    ctx.subscriptions.push(Vsc.workspace.onDidOpenTextDocument(async () => setReadonlyIfPossible()))

    ctx.subscriptions.push(
        Vsc.commands.registerCommand("embrowser.openReadonly", async (uri: Vsc.Uri) => {
            await Vsc.commands.executeCommand("vscode.open", uri, { preview: true })
            await Vsc.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession")
        })
    )

    void onEditor(Vsc.window.activeTextEditor)

    await Vsc.workspace.getConfiguration().update('workbench.colorTheme', 'EM•Script Dark', Vsc.ConfigurationTarget.Workspace)
    await Vsc.workspace.getConfiguration().update('git.enabled', false, Vsc.ConfigurationTarget.Workspace)
}

export function deactivate() {
}

async function setReadonlyIfPossible(): Promise<void> {
    try {
        await Vsc.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession')
    } catch {
        // ignore
    }
}
