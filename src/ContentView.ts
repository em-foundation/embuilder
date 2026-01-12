import * as Vsc from 'vscode'

export class Provider implements Vsc.TreeDataProvider<Vsc.TreeItem> {
    private readonly _onDidChangeTreeData = new Vsc.EventEmitter<Vsc.TreeItem | undefined | null | void>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    constructor(private readonly extUri: Vsc.Uri) { }

    refresh(): void {
        this._onDidChangeTreeData.fire()
    }

    getTreeItem(element: Vsc.TreeItem): Vsc.TreeItem {
        return element
    }

    async getChildren(element?: Vsc.TreeItem): Promise<Vsc.TreeItem[]> {
        if (element) {
            return []
        }

        const root = Vsc.workspace.workspaceFolders?.[0]?.uri
        if (!root) {
            return []
        }

        const ws = Vsc.Uri.joinPath(root, "workspace")

        let entries: [string, Vsc.FileType][]
        try {
            entries = await Vsc.workspace.fs.readDirectory(ws)
        } catch {
            return []
        }

        return entries
            .filter(([, type]) => (type & Vsc.FileType.Directory) !== 0)
            .map(([name]) => {
                const item = new Vsc.TreeItem(name, Vsc.TreeItemCollapsibleState.None)

                item.iconPath = {
                    light: Vsc.Uri.joinPath(this.extUri, "icons/package.svg"),
                    dark: Vsc.Uri.joinPath(this.extUri, "icons/package.svg")
                }

                item.contextValue = "package"
                return item
            })
    }

}
