import * as Vsc from 'vscode'

export function activate(context: Vsc.ExtensionContext) {
    Vsc.window.showInformationMessage("EM•Script Browser activated")
}

export function deactivate() {
}
