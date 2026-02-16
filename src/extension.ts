import * as Vsc from 'vscode'

import * as Cmd from './Cmd'
import * as ContentView from './ContentView'
import * as GrammarView from './GrammarView'
import * as SemTok from './SemTok'
import * as StatusItems from './StatusItems'
import * as TourGuide from './TourGuide'
import * as ToursView from './ToursView'
import * as Utils from './Utils'

const ASSOCS = {
    '*.em.ts': 'typescript',
    '*.emtour': 'yaml',
    'em-boards': 'yaml',
    'emtour-bundle': 'yaml',
}

export async function activate(ctx: Vsc.ExtensionContext) {
    console.log('*** activate: begin')
    try {
        const ws = Vsc.workspace.workspaceFolders?.[0]
        if (!ws) return

        await Utils.provision(ctx)

        for (const cmd of ['em.build', 'em.buildLoad', 'em.buildMeta']) {
            ctx.subscriptions.push(Vsc.commands.registerCommand(cmd, (node: ContentView.Node) => Cmd.build(node.uri, cmd)))
        }
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.clean', Cmd.clean))

        await TourGuide.init(ctx)
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.renderDoc', TourGuide.ViewProvider.render))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.start', TourGuide.start))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.end', TourGuide.end))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.next', TourGuide.next))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.prev', TourGuide.prev))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.refresh', TourGuide.refresh))
        ctx.subscriptions.push(Vsc.commands.registerCommand('em.tour.restart', TourGuide.restart))

        ContentView.init(ctx)
        await Utils.focusBrowser()

        ToursView.init(ctx)
        ctx.subscriptions.push(
            Vsc.commands.registerCommand('em.tour.startdev', async (node: Vsc.TreeItem) => {
                await TourGuide.start(node.resourceUri!, true)
            })
        )
        ctx.subscriptions.push(
            Vsc.commands.registerCommand('em.tour.open', async (node: Vsc.TreeItem) => {
                await TourGuide.open(Vsc.Uri.parse(`file://${node.resourceUri!.path}`))
            })
        )
        ctx.subscriptions.push(
            Vsc.commands.registerCommand('emtours.revealInExplorer', async (node: Vsc.TreeItem) => {
                await Cmd.revealExplorer(Vsc.Uri.parse(`file://${node.resourceUri!.path}`))
            })
        )

        ctx.subscriptions.push(Vsc.commands.registerCommand('emgrammar.next', GrammarView.next))
        ctx.subscriptions.push(Vsc.commands.registerCommand('emgrammar.prev', GrammarView.prev))
        ctx.subscriptions.push(Vsc.commands.registerCommand('emgrammar.show', GrammarView.show))
        ctx.subscriptions.push(Vsc.commands.registerCommand('emgrammar.top', GrammarView.top))

        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.build', Cmd.build))
        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.downloadVcd', Cmd.downloadVcd))
        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.gotoPulseView', Cmd.gotoPulseView))
        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.refresh', Cmd.refresh))
        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.revealActiveUnit', Cmd.revealUnit))
        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.showWelcome', Cmd.showWelcome))
        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.shutdown', Cmd.shutdown))
        ctx.subscriptions.push(Vsc.commands.registerCommand('embrowser.startFirstTour', Cmd.startFirstTour))
        ctx.subscriptions.push(
            Vsc.commands.registerCommand('embrowser.revealInExplorer', async (node: ContentView.Node) => {
                await Cmd.revealExplorer(node.uri)
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

        const emsWatcher = Vsc.workspace.createFileSystemWatcher(new Vsc.RelativePattern(Utils.rootUri(), 'workspace/**/*'))
        ctx.subscriptions.push(
            emsWatcher,
            emsWatcher.onDidCreate(() => ContentView.refresh()),
            emsWatcher.onDidDelete(() => ContentView.refresh()),
        )

        const vcdWatcher = Vsc.workspace.createFileSystemWatcher(new Vsc.RelativePattern(Utils.rootUri(), '**/wokwi.vcd'))
        ctx.subscriptions.push(
            vcdWatcher,
            vcdWatcher.onDidCreate(Cmd.downloadVcd),
            vcdWatcher.onDidChange(Cmd.downloadVcd),
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

        await cfg.update('breadcrumbs.enabled', false, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('editor.fontSize', 14, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('editor.formatOnSave', true, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('editor.minimap.enabled', false, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('files.associations', ASSOCS, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('typescript.disableAutomaticTypeAcquisition', true, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('typescript.tsserver.web.typeAcquisition.enabled', false, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('window.zoomLevel', -1, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('workbench.colorTheme', 'EM•Script Dark', Vsc.ConfigurationTarget.Workspace)
        await cfg.update('workbench.iconTheme', 'vs-minimal', Vsc.ConfigurationTarget.Workspace)
        await cfg.update('workbench.tree.indent', 20, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('[typescript]', {
            'editor.defaultFormatter': 'vscode.typescript-language-features'
        }, Vsc.ConfigurationTarget.Workspace)
        await cfg.update('[typescriptreact]', {
            'editor.defaultFormatter': 'vscode.typescript-language-features'
        }, Vsc.ConfigurationTarget.Workspace)

        StatusItems.init(ctx)
        ctx.subscriptions.push(Vsc.commands.registerCommand("em.bindBoard", Cmd.bindBoard))
        ctx.subscriptions.push(Vsc.commands.registerCommand("em.bindSetup", Cmd.bindSetup))

        Utils.refreshProps()
        await Cmd.initSetup()

        Cmd.showWelcome()
        Vsc.window.showInformationMessage(`EM•Browser activated (v${Utils.getVersExt()})`)

        // avoid dropdown
        setTimeout(async () => {
            await Vsc.workspace.getConfiguration().update(
                'workbench.colorTheme',
                'EM•Script Dark',
                Vsc.ConfigurationTarget.Workspace
            )
        }, 0)

    } catch (e) {
        console.log('*** activate: fail')
        Vsc.window.showWarningMessage(`embrowser activate failed: ${String(e)}`)
    }

    console.log('*** activate: end')
}

export function deactivate() {
}
