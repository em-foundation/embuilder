import * as Vsc from 'vscode'

const VscFs = Vsc.workspace.fs

type NodeKind = 'workspace' | 'package' | 'bucket' | 'dir' | 'file' | 'build'

let curNodeMap = new Map<string, Node>()
let curRoot: Node | null = null
let curView: Provider
let curTree: Vsc.TreeView<Node>

export function getNode(uri: Vsc.Uri): Node | undefined {
    return curNodeMap.get(uri.path)
}

export function init(ctx: Vsc.ExtensionContext) {
    curView = new Provider(ctx.extensionUri)
    curTree = Vsc.window.createTreeView('embuilder.content', {
        treeDataProvider: curView
    })
    ctx.subscriptions.push(curTree)
}

export function refresh(node?: Node) {
    curView.refresh(node)
}

export async function reveal(node?: Node) {
    const n = node ?? curRoot!
    await curTree.reveal(n, { select: true, focus: true, expand: true })
}

export class Node extends Vsc.TreeItem {
    constructor(
        public readonly parent: Node | null,
        public readonly kind: NodeKind,
        public readonly uri: Vsc.Uri,
        label: string,
        collapsibleState: Vsc.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState)
        this.tooltip = new Vsc.MarkdownString('')
        if (kind == 'workspace') {
            curNodeMap.clear()
            if (!curRoot) curRoot = this
        }
        curNodeMap.set(uri.path, this)
    }
}

export class Provider implements Vsc.TreeDataProvider<Node> {

    private readonly _onDidChangeTreeData = new Vsc.EventEmitter<Node | undefined | null | void>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    constructor(private readonly extUri: Vsc.Uri) { }

    refresh(node?: Node): void {
        this._onDidChangeTreeData.fire(node)
    }

    getParent(element: Node): Node | undefined {
        return element.parent ?? undefined
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
            const entries = await VscFs.readDirectory(parent)
            return entries
                .filter(([, type]) => (type & Vsc.FileType.Directory) !== 0)
                .map(([name]) => name)
        } catch {
            return []
        }
    }

    private async readAll(parent: Vsc.Uri): Promise<Array<{ name: string, type: Vsc.FileType }>> {
        try {
            const entries = await VscFs.readDirectory(parent)
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
            const item = new Node(null, 'workspace', wsUri, 'EM•Script Source', Vsc.TreeItemCollapsibleState.Expanded)
            item.iconPath = this.icon('icons/source.png')
            item.contextValue = 'embuilder.workspace'
            const outUri = Vsc.Uri.joinPath(wsUri, '.emscript')
            if (!await uriExists(outUri)) return [item]
            const item2 = new Node(null, 'build', outUri, 'EM•Script Output', Vsc.TreeItemCollapsibleState.Collapsed)
            item2.iconPath = this.icon('icons/output.png')
            item2.contextValue = 'embuilder.build'
            return [item, item2]
        }

        // workspace -> packages
        if (element.kind === 'workspace') {
            const dirNames = await this.readDirs(element.uri)
            return dirNames.filter(name => !name.startsWith('.')).map((name) => {
                const pkgUri = Vsc.Uri.joinPath(element.uri, name)
                const item = new Node(element, 'package', pkgUri, name, Vsc.TreeItemCollapsibleState.Collapsed)
                item.iconPath = this.icon('icons/package.svg')
                item.contextValue = 'embuilder.package'
                return item
            })
        }

        // package -> buckets
        if (element.kind === 'package') {
            const dirNames = await this.readDirs(element.uri)
            return dirNames.map((name) => {
                const bucketUri = Vsc.Uri.joinPath(element.uri, name)
                const item = new Node(element, 'bucket', bucketUri, name, Vsc.TreeItemCollapsibleState.Collapsed)
                item.iconPath = this.icon('icons/bucket.svg')
                item.contextValue = 'embuilder.bucket'
                return item
            })
        }

        // bucket/dir -> all children (dirs + files)
        if (element.kind === 'bucket' || element.kind === 'dir' || element.kind === 'build') {
            const entries = await this.readAll(element.uri)

            const nodes = entries.map(({ name, type }) => {
                const uri = Vsc.Uri.joinPath(element.uri, name)

                if ((type & Vsc.FileType.Directory) !== 0) {
                    const item = new Node(element, 'dir', uri, name, Vsc.TreeItemCollapsibleState.Collapsed)
                    item.iconPath = this.icon('icons/folder.svg')
                    item.contextValue = 'embuilder.dir'
                    return item
                }

                const item = new Node(element, 'file', uri, name, Vsc.TreeItemCollapsibleState.None)
                item.iconPath = this.fileIcon(name)
                item.contextValue = (name.endsWith('.em.ts')) ? 'embuilder.unit' : 'embuilder.file'
                item.command = {
                    command: 'vscode.open',
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

async function uriExists(uri: Vsc.Uri) {
    try {
        await VscFs.stat(uri)
        return true
    } catch {
        return false
    }
}
