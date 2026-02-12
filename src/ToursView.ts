import * as Utils from './Utils'
import * as Vsc from 'vscode'
import * as Yaml from 'js-yaml'

const VscFs = Vsc.workspace.fs

type TourNode = Vsc.TreeItem

let curFirstTour: TourNode | null = null
let curFirstBundle: TourNode | null = null

let curView: Provider
let curTree: Vsc.TreeView<TourNode>

export function firstTour(): TourNode {
    return curFirstTour!
}

export function init(ctx: Vsc.ExtensionContext) {
    curView = new Provider(ctx.extensionUri)
    curTree = Vsc.window.createTreeView('embrowser.tours', {
        treeDataProvider: curView
    })
    ctx.subscriptions.push(curTree)
}

export function refresh(node?: TourNode) {
    curView.refresh(node)
}

export class Provider implements Vsc.TreeDataProvider<TourNode> {

    private items: TourNode[] = []

    private readonly _onDidChangeTreeDataEmitter = new Vsc.EventEmitter<TourNode | undefined>()
    readonly onDidChangeTreeData = this._onDidChangeTreeDataEmitter.event

    constructor(private readonly extUri: Vsc.Uri) { }

    getTreeItem(element: TourNode): Vsc.TreeItem {
        return element
    }

    async getChildren(elem?: TourNode): Promise<TourNode[]> {
        const bflg = elem && elem.contextValue == 'em.tour.bundle'
        if (elem && !bflg) return []
        let glob = 'tours/**/emtour-bundle'
        if (bflg) {
            const segs = elem.resourceUri!.path.split('/')
            const bname = segs[segs.length - 2]
            glob = `tours/${bname}/*.emtour`
        }
        const uris = (await Vsc.workspace.findFiles(glob)).sort()
        let items: TourNode[] = []
        for (const uri of uris) {
            const meta = Yaml.load(await Utils.readText(uri)) as any
            const state = bflg ? Vsc.TreeItemCollapsibleState.None : curFirstBundle ? Vsc.TreeItemCollapsibleState.Collapsed : Vsc.TreeItemCollapsibleState.Expanded
            const item = new Vsc.TreeItem(uri, state)
            curFirstBundle ??= item
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
                curFirstTour ??= item
            }
            items.push(item)
        }
        return items
    }

    refresh(node?: TourNode): void {
        this._onDidChangeTreeDataEmitter.fire(node)
    }

    private icon(relPath: string): { light: Vsc.Uri, dark: Vsc.Uri } {
        const uri = Vsc.Uri.joinPath(this.extUri, relPath)
        return { light: uri, dark: uri }
    }
}
