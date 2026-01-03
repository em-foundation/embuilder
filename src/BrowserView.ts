import * as Vsc from "vscode"

export class BrowserView implements Vsc.Disposable, Vsc.TreeDataProvider<BrowserNode> {

    private readonly onDidChangeTreeDataEmitter = new Vsc.EventEmitter<BrowserNode | undefined>()
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event

    private readonly tree: Vsc.TreeView<BrowserNode>

    constructor(private readonly context: Vsc.ExtensionContext) {
        this.tree = Vsc.window.createTreeView("emscriptBrowserView", {
            treeDataProvider: this,
            showCollapseAll: false
        })
    }

    dispose() {
        this.tree.dispose()
        this.onDidChangeTreeDataEmitter.dispose()
    }

    getTreeItem(element: BrowserNode): Vsc.TreeItem {
        return element
    }

    async getChildren(element?: BrowserNode): Promise<BrowserNode[]> {
        if (element) return []
        return [new BrowserNode("Coming soon", Vsc.TreeItemCollapsibleState.None)]
    }
}

class BrowserNode extends Vsc.TreeItem {
    constructor(label: string, collapsibleState: Vsc.TreeItemCollapsibleState) {
        super(label, collapsibleState)
    }
}
