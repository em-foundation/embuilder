import * as vscode from "vscode"

export function activate(context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage("EM•Script Browser activated")
}

export function deactivate() {
}
