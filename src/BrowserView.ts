import * as Vsc from "vscode"

export class BrowserView implements Vsc.Disposable, Vsc.TreeDataProvider<BrowserNode> {

    private readonly onDidChangeTreeDataEmitter = new Vsc.EventEmitter<BrowserNode | undefined>()
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event

    private readonly tree: Vsc.TreeView<BrowserNode>
    private readonly expandedKeys = new Set<string>()

    constructor(private readonly context: Vsc.ExtensionContext) {
        this.tree = Vsc.window.createTreeView("emscriptBrowserView", {
            treeDataProvider: this,
            showCollapseAll: false
        })

        this.tree.onDidExpandElement(e => {
            this.expandedKeys.add(e.element.key)
            this.refresh(e.element)
        })

        this.tree.onDidCollapseElement(e => {
            this.expandedKeys.delete(e.element.key)
            this.refresh(e.element)
        })
    }

    dispose() {
        this.tree.dispose()
        this.onDidChangeTreeDataEmitter.dispose()
    }

    refresh(element?: BrowserNode) {
        this.onDidChangeTreeDataEmitter.fire(element)
    }

    getTreeItem(element: BrowserNode): Vsc.TreeItem {
        element.applyIcon(this.getIconForNode(element))
        return element
    }

    async getChildren(element?: BrowserNode): Promise<BrowserNode[]> {
        const root = this.getWorkspaceRoot()
        if (!root) return [new BrowserNode("Open a folder/workspace", NodeKind.RootMessage, undefined, false, Vsc.TreeItemCollapsibleState.None, "root-message")]

        if (!element) {
            const packagesUri = await this.tryResolvePackagesRoot(root)
            const nodes = await this.readDirAsNodes(packagesUri, {
                depth: 0,
                packagesRoot: packagesUri
            })

            if (nodes.length === 0) {
                return [new BrowserNode("No packages found", NodeKind.RootMessage, undefined, false, Vsc.TreeItemCollapsibleState.None, "no-packages")]
            }

            return nodes
        }

        if (!element.isDir || !element.uri) return []
        return this.readDirAsNodes(element.uri, element.ctx)
    }

    private getWorkspaceRoot(): Vsc.Uri | undefined {
        const wf = Vsc.workspace.workspaceFolders?.[0]
        return wf?.uri
    }

    private async tryResolvePackagesRoot(workspaceRoot: Vsc.Uri): Promise<Vsc.Uri> {
        const packages = Vsc.Uri.joinPath(workspaceRoot, "packages")
        try {
            const stat = await Vsc.workspace.fs.stat(packages)
            if ((stat.type & Vsc.FileType.Directory) !== 0) return packages
        } catch {
        }
        return workspaceRoot
    }

    private async readDirAsNodes(parent: Vsc.Uri, ctx: NodeCtx): Promise<BrowserNode[]> {
        let entries: [string, Vsc.FileType][]
        try {
            entries = await Vsc.workspace.fs.readDirectory(parent)
        } catch {
            return []
        }

        entries.sort((a, b) => {
            const ad = (a[1] & Vsc.FileType.Directory) !== 0
            const bd = (b[1] & Vsc.FileType.Directory) !== 0
            if (ad !== bd) return ad ? -1 : 1
            return a[0].localeCompare(b[0])
        })

        const nextDepth = ctx.depth + 1

        return entries
            .filter(([name]) => name !== ".git" && name !== ".vscode" && name !== "node_modules")
            .map(([name, type]) => {
                const isDir = (type & Vsc.FileType.Directory) !== 0
                const uri = Vsc.Uri.joinPath(parent, name)

                const kind = this.inferKind(ctx, name, isDir)
                const collapsibleState = isDir ? Vsc.TreeItemCollapsibleState.Collapsed : Vsc.TreeItemCollapsibleState.None

                const key = `${uri.toString()}`
                const node = new BrowserNode(
                    name,
                    kind,
                    uri,
                    isDir,
                    collapsibleState,
                    key,
                    {
                        depth: nextDepth,
                        packagesRoot: ctx.packagesRoot
                    }
                )

                if (!isDir) {
                    node.command = {
                        command: "vscode.open",
                        title: "Open",
                        arguments: [uri]
                    }
                }

                return node
            })
    }

    private inferKind(ctx: NodeCtx, name: string, isDir: boolean): NodeKind {
        if (!isDir) return NodeKind.File

        // If we're rooted at ".../packages", depth 1 => package, depth 2 => bucket, depth 3 => unit
        // If we're rooted at workspace root (no "packages" dir), this still gives a reasonable tree.
        if (ctx.depth === 0) return NodeKind.Package
        if (ctx.depth === 1) return NodeKind.Bucket
        if (ctx.depth === 2) return NodeKind.Unit

        return NodeKind.Folder
    }

    private getIconForNode(node: BrowserNode): IconSpec | undefined {
        if (node.kind === NodeKind.RootMessage) return undefined

        if (node.isDir) {
            const opened = this.expandedKeys.has(node.key)

            if (node.kind === NodeKind.Package) return opened ? this.icon("package-open.svg") : this.icon("package-closed.svg")
            if (node.kind === NodeKind.Bucket) return opened ? this.icon("bucket-open.svg") : this.icon("bucket-closed.svg")
            if (node.kind === NodeKind.Unit) return opened ? this.icon("unit-open.svg") : this.icon("unit-closed.svg")

            return opened ? this.icon("folder-open.svg") : this.icon("folder-closed.svg")
        }

        if (node.kind === NodeKind.File) return this.icon("file.svg")
        return undefined
    }

    private icon(fileName: string): IconSpec {
        const p = Vsc.Uri.file(this.context.asAbsolutePath(`icons/${fileName}`))
        return { light: p, dark: p }
    }
}

type IconSpec = { light: Vsc.Uri, dark: Vsc.Uri }

type NodeCtx = {
    depth: number
    packagesRoot: Vsc.Uri
}

enum NodeKind {
    RootMessage = "RootMessage",
    Package = "Package",
    Bucket = "Bucket",
    Unit = "Unit",
    Folder = "Folder",
    File = "File"
}

class BrowserNode extends Vsc.TreeItem {

    constructor(
        label: string,
        public readonly kind: NodeKind,
        public readonly uri: Vsc.Uri | undefined,
        public readonly isDir: boolean,
        collapsibleState: Vsc.TreeItemCollapsibleState,
        public readonly key: string,
        public readonly ctx: NodeCtx = { depth: 0, packagesRoot: Vsc.Uri.parse("") }
    ) {
        super(label, collapsibleState)

        if (uri) {
            this.resourceUri = uri
            this.tooltip = uri.fsPath
        }

        this.contextValue = kind
    }

    applyIcon(icon: IconSpec | undefined) {
        if (!icon) return
        this.iconPath = icon
    }
}
