import * as Vsc from 'vscode'

const VscFs = Vsc.workspace.fs

let curView: Provider
let curTree: Vsc.TreeView<TourNode>

export function init(ctx: Vsc.ExtensionContext) {
    curView = new Provider(ctx.extensionUri)
    curTree = Vsc.window.createTreeView('embrowser.tours', {
        treeDataProvider: curView
    })
    ctx.subscriptions.push(curTree)
}

type TourNode = Vsc.TreeItem

export class Provider implements Vsc.TreeDataProvider<TourNode> {

    private readonly onDidChangeTreeDataEmitter = new Vsc.EventEmitter<TourNode | undefined>()
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event

    constructor(private readonly extUri: Vsc.Uri) { }

    getTreeItem(element: TourNode): Vsc.TreeItem {
        return element
    }

    async getChildren(_element?: TourNode): Promise<TourNode[]> {
        const uris = (await Vsc.workspace.findFiles('**/*.emtour', '**/{node_modules,.git}/**')).sort()
        return uris.map(uri => {
            const item = new Vsc.TreeItem(uri, Vsc.TreeItemCollapsibleState.None)
            item.resourceUri = uri
            item.command = {
                command: 'em.tour.start',
                title: 'Start Tour',
                arguments: [uri],
            }
            item.iconPath = this.icon('icons/compass.png')
            return item
        })
    }

    private icon(relPath: string): { light: Vsc.Uri, dark: Vsc.Uri } {
        const uri = Vsc.Uri.joinPath(this.extUri, relPath)
        return { light: uri, dark: uri }
    }
}
