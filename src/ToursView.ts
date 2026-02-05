import * as Utils from './Utils'
import * as Vsc from 'vscode'
import * as Yaml from 'js-yaml'

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

    async getChildren(elem?: TourNode): Promise<TourNode[]> {
        const bflg = elem && elem.contextValue == 'em.tour.bundle'
        if (elem && !bflg) return []
        let glob = 'tours/**/em-tour-bundle'
        if (bflg) {
            const segs = elem.resourceUri!.path.split('/')
            const bname = segs[segs.length - 2]
            glob = `tours/${bname}/*.emtour`
        }
        const uris = (await Vsc.workspace.findFiles(glob)).sort()
        let items: TourNode[] = []
        for (const uri of uris) {
            const meta = Yaml.load(await Utils.readText(uri)) as any
            const item = new Vsc.TreeItem(uri, !bflg ? Vsc.TreeItemCollapsibleState.Collapsed : Vsc.TreeItemCollapsibleState.None)
            item.resourceUri = Vsc.Uri.parse(`embrowser-tour:${uri.path}`)  // synthetic
            item.contextValue = !bflg ? 'em.tour.bundle' : 'em.tour'
            item.label = meta.title
            item.tooltip = meta.description ?? '<TBD>'
            item.iconPath = this.icon(!bflg ? 'icons/tour-bundle.svg' : 'icons/compass.png')
            if (bflg) {
                item.command = {
                    command: 'em.tour.start',
                    title: 'Start Tour',
                    arguments: [uri],
                }
            }
            items.push(item)
        }
        return items
    }

    private icon(relPath: string): { light: Vsc.Uri, dark: Vsc.Uri } {
        const uri = Vsc.Uri.joinPath(this.extUri, relPath)
        return { light: uri, dark: uri }
    }
}
