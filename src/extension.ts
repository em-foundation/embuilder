import * as Vsc from 'vscode'

import * as Cmd from './Cmd'
import * as ContentView from './ContentView'
import * as SemTok from './SemTok'
import * as StatusItems from './StatusItems'
import * as TourMgr from './TourMgr'
import * as Utils from './Utils'

const ASSOCS = {
    '*.em.ts': 'typescript',
    '*.emtour': 'markdown',
    'em-boards': 'yaml',
}

export async function activate(ctx: Vsc.ExtensionContext) {
    console.log('*** activate: begin')
    try {
        const ws = Vsc.workspace.workspaceFolders?.[0]
        if (!ws) return

        for (const cmd of ['em.build', 'em.buildLoad', 'em.buildMeta']) {
            ctx.subscriptions.push(Vsc.commands.registerCommand(cmd, (node: ContentView.Node) => Cmd.build(node.uri, cmd)))
        }
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.clean', Cmd.clean))

        await TourMgr.init(ctx)
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.renderDoc', TourMgr.ViewProvider.render))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.start', TourMgr.start))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.end', TourMgr.end))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.next', TourMgr.next))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.prev', TourMgr.prev))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.refresh', TourMgr.refresh))

        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.restart', TourMgr.restart))
        ContentView.init(ctx)
        await Vsc.commands.executeCommand('embrowser.content.focus')
        await Vsc.commands.executeCommand('workbench.view.extension.embrowser')

        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.revealActiveUnit', Cmd.revealUnit))
        ctx.subscriptions.push(
            Vsc.commands.registerCommand('embrowser.revealInExplorer', async (node: ContentView.Node) => {
                await Cmd.revealExplorer(node)
            })
        )
        ctx.subscriptions.push(
            Vsc.commands.registerCommand('embrowser.remove', async (node: ContentView.Node) => {
                await Cmd.remove(node)
            })
        )

        for (const cks of ['Bucket', 'Package']) {
            Vsc.commands.registerCommand(`em.new${cks}`, async (node: ContentView.Node) => {
                if (node?.uri) await Cmd.newContainer(node, cks)
            })
        }

        for (const uks of ['Composite', 'Interface', 'Module', 'Program', 'Template']) {
            Vsc.commands.registerCommand(`em.new${uks}`, async (node: ContentView.Node) => {
                if (node?.uri) await Cmd.newUnit(node, uks)
            })
        }

        const watcher = Vsc.workspace.createFileSystemWatcher(new Vsc.RelativePattern(Utils.rootUri(), 'workspace/**/*'))
        ctx.subscriptions.push(
            watcher,
            watcher.onDidCreate(() => ContentView.refresh()),
            watcher.onDidDelete(() => ContentView.refresh()),
        )

        ctx.subscriptions.push(
            Vsc.languages.registerDocumentSemanticTokensProvider(
                { pattern: '**/*.em.ts' },
                new SemTok.Provider(),
                SemTok.legend()
            )
        )

        ctx.subscriptions.push(
            Vsc.commands.registerCommand('embrowser.openReadonly', async (uri: Vsc.Uri) => {
                await Vsc.commands.executeCommand('vscode.open', uri, { preview: true })
                await Vsc.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession')
            })
        )

        const cfg = Vsc.workspace.getConfiguration()
        // await cfg.update('git.enabled', false, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('breadcrumbs.enabled', false, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('editor.fontSize', 14, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('editor.minimap.enabled', false, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('files.associations', ASSOCS, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('typescript.disableAutomaticTypeAcquisition', true, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('typescript.tsserver.web.typeAcquisition.enabled', false, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('workbench.colorTheme', 'EM•Script Dark', Vsc.ConfigurationTarget.Workspace)
        await cfg.update('workbench.tree.indent', 20, Vsc.ConfigurationTarget.Workspace)

        StatusItems.init(ctx)
        ctx.subscriptions.push(Vsc.commands.registerCommand("em.bindBoard", Cmd.bindBoard))
        ctx.subscriptions.push(Vsc.commands.registerCommand("em.bindSetup", Cmd.bindSetup))

        Vsc.window.showInformationMessage(`EM•Browser activated`)

        Utils.refreshProps()
        const defSetup = Utils.getDefaultSetup();
        if (defSetup) {
            await StatusItems.setupC.set(defSetup);
        } else {
            let opts: Vsc.MessageOptions = {
                detail: "Click below to select a tooling setup",
                modal: true,
            };
            await StatusItems.boardC.set('')
            if (
                await Vsc.window.showWarningMessage(`EM•Script Setups`, opts, "Select...")
            ) {
                await Cmd.bindSetup()
            }
        }

    } catch (e) {
        console.log('*** activate: fail')
        Vsc.window.showWarningMessage(`embrowser activate failed: ${String(e)}`)
    }

    console.log('*** activate: end')
}

export function deactivate() {
}
