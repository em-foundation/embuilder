import * as Vsc from 'vscode'

export class Provider implements Vsc.TreeDataProvider<Vsc.TreeItem> {
    private readonly _onDidChangeTreeData = new Vsc.EventEmitter<Vsc.TreeItem | undefined | null | void>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    refresh(): void {
        this._onDidChangeTreeData.fire()
    }

    getTreeItem(element: Vsc.TreeItem): Vsc.TreeItem {
        return element
    }

    getChildren(element?: Vsc.TreeItem): Vsc.ProviderResult<Vsc.TreeItem[]> {
        return []
    }
}
