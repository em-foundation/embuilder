import * as Vsc from "vscode"
import { BrowserView } from "./BrowserView"

export function activate(context: Vsc.ExtensionContext) {
    const view = new BrowserView(context)
    context.subscriptions.push(view)
    Vsc.window.showInformationMessage("EM•Script Browser activated")
}

export function deactivate() {
}
