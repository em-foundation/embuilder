import * as Vsc from 'vscode'

type NodeKind = 'workspace' | 'package' | 'bucket' | 'dir' | 'file' | 'build'

export class Node extends Vsc.TreeItem {
    constructor(
        public readonly kind: NodeKind,
        public readonly uri: Vsc.Uri,
        label: string,
        collapsibleState: Vsc.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState)
    }
}

export class Provider implements Vsc.TreeDataProvider<Node> {
    private readonly _onDidChangeTreeData = new Vsc.EventEmitter<Node | undefined | null | void>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    constructor(private readonly extUri: Vsc.Uri) { }

    refresh(): void {
        this._onDidChangeTreeData.fire()
    }

    getTreeItem(element: Node): Vsc.TreeItem {
        return element
    }

    private icon(relPath: string): { light: Vsc.Uri, dark: Vsc.Uri } {
        const uri = Vsc.Uri.joinPath(this.extUri, relPath)
        return { light: uri, dark: uri }
    }

    private async readDirs(parent: Vsc.Uri): Promise<string[]> {
        try {
            const entries = await Vsc.workspace.fs.readDirectory(parent)
            return entries
                .filter(([, type]) => (type & Vsc.FileType.Directory) !== 0)
                .map(([name]) => name)
        } catch {
            return []
        }
    }

    private async readAll(parent: Vsc.Uri): Promise<Array<{ name: string, type: Vsc.FileType }>> {
        try {
            const entries = await Vsc.workspace.fs.readDirectory(parent)
            return entries.map(([name, type]) => ({ name, type }))
        } catch {
            return []
        }
    }

    private fileIcon(name: string): { light: Vsc.Uri, dark: Vsc.Uri } {
        if (name === 'em-boards' || name.endsWith('.ini')) {
            return this.icon('icons/gear.svg')
        }

        if (name.endsWith('.em.ts')) {
            return this.icon('icons/unit.svg')
        }

        if (name.endsWith('.emtour')) {
            return this.icon('icons/compass.png')
        }

        return this.icon('icons/file.svg')
    }


    async getChildren(element?: Node): Promise<Node[]> {
        const root = Vsc.workspace.workspaceFolders?.[0]?.uri
        if (!root) {
            return []
        }

        const wsUri = Vsc.Uri.joinPath(root, 'workspace')

        // top-level -> workspace node
        if (!element) {
            const item = new Node(
                'workspace',
                wsUri,
                'workspace',
                Vsc.TreeItemCollapsibleState.Expanded
            )
            item.iconPath = this.icon('icons/workspace.svg')
            item.contextValue = 'embrowser.nodeHasUri'
            return [item]
        }

        // workspace -> packages
        if (element.kind === 'workspace') {
            const dirNames = await this.readDirs(element.uri)
            return dirNames.map((name) => {
                const kind = (name == '.emscript') ? 'build' : 'package'
                const pkgUri = Vsc.Uri.joinPath(element.uri, name)
                const item = new Node(kind, pkgUri, name, Vsc.TreeItemCollapsibleState.Collapsed)
                item.iconPath = this.icon(`icons/${kind}.svg`)
                item.contextValue = 'embrowser.nodeHasUri'
                return item
            })
        }

        // package -> buckets
        if (element.kind === 'package') {
            const dirNames = await this.readDirs(element.uri)
            return dirNames.map((name) => {
                const bucketUri = Vsc.Uri.joinPath(element.uri, name)
                const item = new Node('bucket', bucketUri, name, Vsc.TreeItemCollapsibleState.Collapsed)
                item.iconPath = this.icon('icons/bucket.svg')
                item.contextValue = 'embrowser.nodeHasUri'
                return item
            })
        }

        // bucket/dir -> all children (dirs + files)
        if (element.kind === 'bucket' || element.kind === 'dir' || element.kind === 'build') {
            const entries = await this.readAll(element.uri)

            const nodes = entries.map(({ name, type }) => {
                const uri = Vsc.Uri.joinPath(element.uri, name)

                if ((type & Vsc.FileType.Directory) !== 0) {
                    const item = new Node('dir', uri, name, Vsc.TreeItemCollapsibleState.Collapsed)
                    item.iconPath = this.icon('icons/folder.svg')
                    item.contextValue = 'embrowser.nodeHasUri'
                    return item
                }

                const item = new Node('file', uri, name, Vsc.TreeItemCollapsibleState.None)
                item.iconPath = this.fileIcon(name)
                item.contextValue = 'embrowser.nodeHasUri'
                item.command = {
                    command: name.endsWith('.emtour') ? 'em.tour.start' : 'vscode.open',
                    title: '',
                    arguments: [uri]
                }
                return item
            })

            // folders first, then files
            nodes.sort((a, b) => {
                const ak = a.kind === 'dir' ? 0 : 1
                const bk = b.kind === 'dir' ? 0 : 1
                if (ak !== bk) return ak - bk
                return a.label!.toString().localeCompare(b.label!.toString())
            })

            return nodes
        }

        return []
    }
}
