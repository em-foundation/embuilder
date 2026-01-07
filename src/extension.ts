import * as Vsc from 'vscode'
import * as SemTok from "./SemTok";

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
    ctx.subscriptions.push(
        Vsc.languages.registerDocumentSemanticTokensProvider(
            { scheme: "file", pattern: "**/*.em.ts" },
            new SemTok.Provider(),
            SemTok.legend()
        )
    )
    await Vsc.workspace.getConfiguration('files').update('exclude', EXCLUDES, Vsc.ConfigurationTarget.Workspace)
    await Vsc.workspace.getConfiguration().update('workbench.colorTheme', 'EM•Script Dark', Vsc.ConfigurationTarget.Workspace)
    await Vsc.workspace.getConfiguration().update('git.enabled', false, Vsc.ConfigurationTarget.Workspace)
}

export function deactivate() {
}
