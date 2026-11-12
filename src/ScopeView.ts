import * as Vsc from 'vscode'
import * as Fs from 'fs/promises'
import * as Path from 'path'
import { homedir } from 'os'
import { EM_COLOR } from './StatusItems'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import * as Yaml from 'js-yaml'

type Score = { type: string, sleepCurrent: number, eventEnergy: number, emeralds: number }
type Row = { name: string, dir: string, status: string, newCapture?: boolean, candidate?: string, overrides?: ScanValues, count?: number, options?: string[], one?: Score, ten?: Score }
const fields = [
    ['gap', 'Merge gaps (ms)', 'Combine nearby activity regions.'],
    ['min-duration', 'Minimum duration (ms)', 'Reject shorter activity regions.'],
    ['min-energy', 'Minimum energy (µJ)', 'Reject lower-energy activity regions.'],
    ['trim', 'Trim (1-second cycles)', 'Current CLI assumes one-second cycles; excludes boundary activity.'],
    ['event-window', 'Event window (ms)', 'Fixed scoring window from each event start.'],
    ['sleep-window', 'Sleep window (ms)', 'Quiet-baseline search window; default 500 ms.'],
] as const
const sortKeys = ['name', 'events', 'sleep', 'energy', 'score', 'projection'] as const
type SortKey = typeof sortKeys[number]
type ScanField = typeof fields[number][0]
type ScanValues = Partial<Record<ScanField, number | null>>

type ViewerSettings = { projectionSeconds?: number, sortKey?: SortKey, sortDescending?: boolean }

let scopeStatus: Vsc.StatusBarItem
let currentPanel: Vsc.WebviewPanel | undefined
let currentRoot: string | undefined
let rootListeners: Vsc.Disposable[] = []

export function init(ctx: Vsc.ExtensionContext) {
    scopeStatus = Vsc.window.createStatusBarItem(Vsc.StatusBarAlignment.Left, 9)
    scopeStatus.name = 'EM•Scope status'
    scopeStatus.color = EM_COLOR
    scopeStatus.command = 'embuilder.showScope'
    ctx.subscriptions.push(scopeStatus)
    const output = Vsc.window.createOutputChannel('EM•Scope')
    ctx.subscriptions.push(output, Vsc.commands.registerCommand('embuilder.showScope', async (uri?: Vsc.Uri, refresh = false) => {
        const workspace = Vsc.workspace.workspaceFolders?.[0]?.uri
        if (!workspace) { Vsc.window.showErrorMessage('Open an Emporium workspace first.'); return }
        const savedRoot = ctx.workspaceState.get<string>('embuilder.scope.lastRoot')
        const root = uri ?? (savedRoot ? Vsc.Uri.file(savedRoot) : Vsc.Uri.joinPath(workspace, 'captures'))
        if (root.scheme !== 'file') { Vsc.window.showErrorMessage('EM•Scope requires a local capture folder.'); return }
        const key = root.toString()
        await ctx.workspaceState.update('embuilder.scope.lastRoot', root.fsPath)
        if (!refresh && currentPanel && (!uri || currentRoot === key)) { currentPanel.reveal(); return }
        for (const listener of rootListeners) listener.dispose()
        rootListeners = []
        if (!currentPanel) {
            currentPanel = Vsc.window.createWebviewPanel('embuilder.scope', 'EM•Scope', Vsc.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true })
            ctx.subscriptions.push(currentPanel)
            currentPanel.onDidDispose(() => {
                currentPanel = undefined; currentRoot = undefined
                scopeStatus.hide()
                for (const listener of rootListeners) listener.dispose()
                rootListeners = []
            })
        }
        const panel = currentPanel
        currentRoot = key
        scopeStatus.text = '$(sync~spin) EM•Scope: Loading…'
        scopeStatus.tooltip = bashPath(root.fsPath)
        scopeStatus.show()
        panel.reveal()
        let disposed = false
        rootListeners.push(panel.onDidDispose(() => { disposed = true }))
        const rows: Row[] = []
        let editing: Row | undefined
        let busy = true
        const settingsKey = 'embuilder.scope.viewerSettings'
        const priorKey = savedRoot ? Vsc.Uri.file(savedRoot).toString() : key
        const settings = ctx.workspaceState.get<ViewerSettings>(settingsKey)
            ?? ctx.workspaceState.get<ViewerSettings>(`embuilder.scope.settings:${priorKey}`)
            ?? ctx.workspaceState.get<ViewerSettings>(`embuilder.scope.settings:${key}`, {})
        await ctx.workspaceState.update(settingsKey, settings)
        let sortKey: SortKey = sortKeys.includes(settings.sortKey as SortKey) ? settings.sortKey! : 'name'
        let sortDescending = settings.sortDescending === true
        const savedPeriod = settings.projectionSeconds
        let period = typeof savedPeriod === 'number' && Number.isSafeInteger(savedPeriod) && savedPeriod > 0 ? savedPeriod : 10
        const nonce = require('crypto').randomBytes(16).toString('hex') as string
        const scanDefaultsKey = `embuilder.scope.scanDefaults:${key}`
        const savedDefaults = ctx.workspaceState.get<ScanValues | number>(scanDefaultsKey, 20)
        let scanDefaults: ScanValues = typeof savedDefaults === 'number' ? { 'event-window': savedDefaults } : savedDefaults
        let editingDefaults = false
        const overridesKey = (dir: string) => `embuilder.scope.scanOverrides:${Vsc.Uri.file(dir).toString()}`
        const readOverrides = (row: Row, dir: string): ScanValues => {
            const saved = ctx.workspaceState.get<ScanValues>(overridesKey(dir))
            if (saved) return saved
            const values: ScanValues = {}
            for (const [field] of fields) {
                const option = row.options?.find(value => value.startsWith(`--${field} `))
                if (!option) continue
                const number = Number(option.split(/\s+/)[1])
                if (Number.isFinite(number)) values[field] = number
                else if (field === 'trim' && row.count) values[field] = row.count
            }
            const inherited = ctx.workspaceState.get<boolean>(`embuilder.scope.inheritWindow:${Vsc.Uri.file(dir).toString()}`)
            if (inherited) delete values['event-window']
            else if (inherited === false && values['event-window'] === undefined) values['event-window'] = null
            return values
        }
        const render = (message: string) => {
            if (disposed) return
            if (!busy) {
                const attention = rows.some(row => row.status !== 'Ready')
                scopeStatus.text = attention ? '$(info) EM•Scope: Needs attention' : '$(pulse) EM•Scope: Ready'
            } else if (/^Scanning|^Opening waveform/.test(message)) {
                scopeStatus.text = `$(sync~spin) EM•Scope: ${message}`
            }
            if (message && !busy) Vsc.window.setStatusBarMessage(`EM•Scope: ${message}`, 5000)
            panel.webview.html = html(root.fsPath, sortedRows(rows, sortKey, sortDescending), message, nonce, editing, busy, period, sortKey, sortDescending, scanDefaults, editingDefaults)
        }
        rootListeners.push(panel.webview.onDidReceiveMessage(async msg => {
            if (busy) return
            if (msg?.kind === 'refresh') {
                busy = true
                await Vsc.commands.executeCommand('embuilder.showScope', root, true)
                return
            }
            if (msg?.kind !== 'choose') return
            const chosen = await Vsc.window.showOpenDialog({
                title: 'Choose Captures', defaultUri: root,
                canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
                openLabel: 'Choose Captures',
            })
            if (chosen?.[0]) await Vsc.commands.executeCommand('embuilder.showScope', chosen[0])
        }))
        render('Discovering captures…')
        try {
            const paths = await discover(root.fsPath)
            const localRequire = createRequire(Path.join(workspace.fsPath, 'package.json'))
            const scopePackage = localRequire.resolve('@em-foundation/emscope/package.json')
            const cli = Path.join(Path.dirname(scopePackage), 'dist', 'emscope')
            const run = (args: string[]) => command(cli, args, workspace.fsPath, output)
            const readAnalysis = async (row: Row, dir = row.dir) => {
                const analysis = Yaml.load(await Fs.readFile(Path.join(dir, 'analysis.yaml'), 'utf8')) as { options?: string[], events?: unknown[], event_width?: number }
                row.options = analysis.options ?? []
                row.count = analysis.events?.length ?? 0
                return analysis
            }
            const preview = async (row: Row) => {
                const analysis = await readAnalysis(row, row.candidate)
                row.one = undefined; row.ten = undefined
                if (row.count && analysis.event_width !== undefined) {
                    try {
                        await update(row, row.candidate)
                        row.status = 'Provisional — review the preview scores, then click Keep.'
                        return
                    } catch (err) {
                        output.appendLine(`${row.name}: ${message(err)}`)
                        row.status = `Provisional — ${message(err)}`
                        return
                    }
                }
                row.status = row.count
                    ? 'Provisional — set Event window in Scan to preview scores.'
                    : 'Provisional — no events found. Adjust the scan.'
            }
            const update = async (row: Row, dir = row.dir) => {
                const analysis = await readAnalysis(row, dir)
                if (!row.count) throw new Error('No events found. Adjust the scan before keeping it.')
                if (analysis.event_width === undefined) throw new Error('Set Event window (ms) before keeping the scan.')
                const one = parseScore(await run(['view', '-c', dir, '-w', '1', '--json']))
                const ten = parseScore(await run(['view', '-c', dir, '-w', String(period), '--json']))
                row.one = one; row.ten = ten; row.status = 'Ready'
            }
            rootListeners.push(panel.webview.onDidReceiveMessage(async msg => {
                if (busy || disposed || !msg || typeof msg !== 'object') return
                if (msg.kind === 'capture-settings') { editingDefaults = true; render(''); return }
                if (msg.kind === 'save-defaults' && editingDefaults) {
                    try {
                        const values = readScanForm(msg.values, false)
                        await ctx.workspaceState.update(scanDefaultsKey, values)
                        scanDefaults = values
                    } catch (err) {
                        Vsc.window.showWarningMessage(message(err))
                        return
                    }
                    editingDefaults = false
                    render('')
                    return
                }
                if (msg.kind === 'grab') {
                    busy = true
                    let row: Row | undefined
                    try {
                        const name = await Vsc.window.showInputBox({
                            title: 'EM•Scope Grab',
                            prompt: 'Capture name · PPK2 source mode · 3.0 V · 6 s',
                            placeHolder: 'e.g. TI/CC27XX/baseline',
                            validateInput: name => validateCaptureName(root.fsPath, name),
                        })
                        if (name === undefined || disposed) return
                        const problem = await validateCaptureName(root.fsPath, name)
                        if (problem) throw new Error(problem)
                        const dir = await createCaptureFolder(root.fsPath, name)
                        const previous = rows.findIndex(item => item.name === name)
                        if (previous !== -1) rows.splice(previous, 1)
                        row = { name, dir, status: 'Grabbing…', newCapture: true }
                        rows.unshift(row)
                        render('')
                        scopeStatus.text = '$(sync~spin) EM•Scope: Grabbing…'
                        let progressTail = ''
                        let lastTenth = -1
                        await command(cli, ['grab', '-P', '-S', '-v', '3.0', '-d', '6'], dir, output, chunk => {
                            const text = progressTail + chunk
                            const samples = [...text.matchAll(/capturing: (\d+\.\d+) s/g)]
                            progressTail = text.slice(-40)
                            const latest = samples.at(-1)
                            if (!latest || disposed) return
                            const tenth = Math.min(60, Math.floor(Number(latest[1]) * 10))
                            if (tenth <= lastTenth) return
                            lastTenth = tenth
                            scopeStatus.text = `$(sync~spin) EM•Scope: Capturing [${(tenth / 10).toFixed(1)} of 6 s]`
                        })
                        if (!await exists(Path.join(dir, 'capture.yaml'))) throw new Error('Grab exited without saving a capture.')
                        await Fs.writeFile(Path.join(dir, '.emscope-pending'), '')
                        scopeStatus.text = '$(sync~spin) EM•Scope: Scanning…'
                        await ctx.workspaceState.update(overridesKey(dir), {})
                        try { await command(cli, ['scan', ...scanArguments(scanDefaults)], dir, output) }
                        catch (err) { output.appendLine(`${name}: Default scan failed: ${message(err)}`) }
                        await preview(row)
                        scopeStatus.text = '$(sync~spin) EM•Scope: Packing…' 
                        try { await command(cli, ['pack', '-z'], dir, output) }
                        catch (err) {
                            output.appendLine(`${name}: ${message(err)}`)
                            Vsc.window.showWarningMessage(`EM•Scope captured ${name}, but packing failed. See EM•Scope Output.`)
                            return
                        }
                        Vsc.window.showInformationMessage(`EM•Scope captured ${name}. Review the detected events.`)
                    } catch (err) {
                        const reason = grabError(message(err))
                        if (row) {
                            row.status = `Error: Grab failed — ${reason}`
                            // Remove only an empty failed destination, so the name can be retried.
                            await Fs.rmdir(row.dir).catch(() => {})
                        }
                        output.appendLine(reason)
                        Vsc.window.showErrorMessage(`EM•Scope Grab: ${reason}`)
                    } finally { busy = false; render('') }
                    return
                }
                if (msg.kind === 'whatif' || msg.kind === 'reset-view') {
                    const reset = msg.kind === 'reset-view'
                    busy = true
                    try {
                        const value = reset ? '10' : await Vsc.window.showInputBox({
                            title: 'EM•Scope What-if', value: formatPeriod(period),
                            prompt: 'Scoring interval (e.g. 20, 01:30, or 01:00:00)',
                            validateInput: text => projectionSeconds(text) === undefined ? 'Enter a positive period, such as 20, 01:30, or 01:00:00.' : undefined,
                        })
                        if (value === undefined) return
                        const nextPeriod = projectionSeconds(value)!
                        const nextSettings: ViewerSettings = reset
                            ? { projectionSeconds: 10, sortKey: 'name', sortDescending: false }
                            : { ...settings, projectionSeconds: nextPeriod }
                        await ctx.workspaceState.update(settingsKey, nextSettings)
                        Object.assign(settings, nextSettings)
                        if (reset) { sortKey = 'name'; sortDescending = false }
                        if (period === nextPeriod) return
                        period = nextPeriod
                        const targets = rows.filter(row => row.one && row.count)
                        for (const row of targets) { row.ten = undefined; row.status = 'Refreshing projection…' }
                        render('')
                        let failures = 0
                        await withStatusProgress(async report => {
                            report.report({ message: `Refreshing… [0 of ${targets.length}]` })
                            let done = 0
                            for (const row of targets) {
                                if (disposed) break
                                try {
                                    row.ten = parseScore(await run(['view', '-c', row.dir, '-w', String(period), '--json']))
                                    row.status = row.newCapture || row.candidate ? 'Provisional — review the preview scores, then click Keep.' : 'Ready'
                                } catch (err) {
                                    failures++
                                    row.status = `Error: ${message(err)}`
                                    output.appendLine(`${row.name}: ${message(err)}`)
                                }
                                done++
                                report.report({ increment: 100 / Math.max(1, targets.length), message: `Refreshing… [${done} of ${targets.length}]` })
                                render('')
                            }
                        })
                        if (!disposed) {
                            if (failures) Vsc.window.showWarningMessage(`EM•Scope refreshed — ${failures} projection(s) failed. See EM•Scope Output.`)
                            else Vsc.window.showInformationMessage(`EM•Scope ready — ${targets.length} captures refreshed.`)
                        }
                    } catch (err) {
                        output.appendLine(message(err))
                        Vsc.window.showErrorMessage('EM•Scope refresh failed. See EM•Scope Output.')
                    } finally { busy = false; render('') }
                    return
                }
                if (msg.kind === 'sort') {
                    if (!sortKeys.includes(msg.key)) return
                    const nextKey = msg.key as SortKey
                    sortDescending = nextKey === sortKey ? !sortDescending : nextKey === 'score' || nextKey === 'projection'
                    sortKey = nextKey
                    settings.sortKey = sortKey; settings.sortDescending = sortDescending
                    await ctx.workspaceState.update(settingsKey, settings)
                    render('')
                    return
                }
                if (msg.kind === 'cancel') { editing = undefined; editingDefaults = false; render(''); return }
                const row = rows.find(r => r.name === msg.name)
                if (!row) return
                if (msg.kind === 'keep' || msg.kind === 'discard') {
                    if (!row.newCapture && !row.candidate) return
                    busy = true
                    try {
                        if (msg.kind === 'discard') {
                            if (row.candidate) {
                                await Fs.rm(row.candidate, { recursive: true })
                                row.candidate = undefined
                                await update(row)
                            } else {
                                const answer = await Vsc.window.showWarningMessage(
                                    `Discard capture ${row.name} and its files?`, { modal: true }, 'Discard Capture',
                                )
                                if (answer !== 'Discard Capture') return
                                const relative = Path.relative(root.fsPath, row.dir)
                                if (!relative || relative.startsWith('..') || Path.isAbsolute(relative)) throw new Error('Cannot discard the capture root.')
                                const entry = await capturePathEntry(row.dir)
                                if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new Error('Capture is not an ordinary folder.')
                                if (entry) await Vsc.workspace.fs.delete(Vsc.Uri.file(row.dir), { recursive: true, useTrash: true })
                                rows.splice(rows.indexOf(row), 1)
                            }
                        } else {
                            scopeStatus.text = '$(sync~spin) EM•Scope: Scoring…'
                            await update(row, row.candidate)
                            if (row.candidate) {
                                await Fs.rename(Path.join(row.candidate, 'analysis.yaml'), Path.join(row.dir, 'analysis.yaml'))
                                const candidate = row.candidate
                                await ctx.workspaceState.update(overridesKey(row.dir), readOverrides(row, candidate))
                                row.candidate = undefined
                                await Fs.rm(candidate, { recursive: true }).catch(err => output.appendLine(message(err)))
                            }
                            if (row.newCapture) await Fs.rm(Path.join(row.dir, '.emscope-pending'), { force: true })
                            row.newCapture = false
                        }
                    } catch (err) {
                        row.one = undefined; row.ten = undefined
                        row.status = `Provisional — ${message(err)}`
                        output.appendLine(message(err))
                        Vsc.window.showWarningMessage(message(err))
                    } finally { busy = false; render('') }
                    return
                }
                if (msg.kind === 'waveform') {
                    if (!row.count) return
                    busy = true
                    render(`Opening waveform for ${row.name}…`)
                    let result = ''
                    try {
                        await run(['view', '-c', row.candidate ?? row.dir, '-j'])
                        result = `Opened ${row.name} in Joulescope Viewer.`
                    } catch (err) {
                        result = `Waveform: ${message(err)}`
                        output.appendLine(result)
                    } finally { busy = false; render(result) }
                    return
                }
                if (msg.kind === 'edit') {
                    try {
                        const a = Yaml.load(await Fs.readFile(Path.join(row.candidate ?? row.dir, 'analysis.yaml'), 'utf8')) as { options?: string[] }
                        row.options = a?.options ?? []
                    } catch { row.options = [] }
                    row.overrides = readOverrides(row, row.candidate ?? row.dir)
                    editing = row; render(''); return
                }
                if (msg.kind !== 'scan' || editing !== row) return
                try {
                    const overrides = readScanForm(msg.values, true)
                    const args = ['scan', ...scanArguments({ ...scanDefaults, ...overrides })]
                    busy = true; editing = undefined; row.status = 'Scanning…'
                    row.one = undefined; row.ten = undefined; row.count = undefined
                    render(`Scanning ${row.name}…`)
                    if (!row.newCapture && !row.candidate) {
                        const candidate = await Fs.mkdtemp(Path.join(row.dir, '.emscope-review-'))
                        try {
                            await Fs.copyFile(Path.join(row.dir, 'capture.yaml'), Path.join(candidate, 'capture.yaml'))
                            await Fs.copyFile(Path.join(row.dir, 'analysis.yaml'), Path.join(candidate, 'analysis.yaml'))
                            await Fs.cp(Path.join(row.dir, '.emscope'), Path.join(candidate, '.emscope'), { recursive: true })
                            await Fs.writeFile(Path.join(candidate, '.emscope-draft'), '')
                            row.candidate = candidate
                        } catch (err) {
                            await Fs.rm(candidate, { recursive: true, force: true })
                            throw err
                        }
                    }
                    const scanDir = row.candidate ?? row.dir
                    await run([...args, '-c', scanDir])
                    await ctx.workspaceState.update(overridesKey(scanDir), overrides)
                    row.overrides = overrides
                    await preview(row)
                    render(`${row.name}: retained ${row.count} event(s).`)
                } catch (err) {
                    const reason = message(err)
                    row.status = `Error: ${reason}`
                    output.appendLine(`${row.name}: ${row.status}`)
                    if (row.count && reason.includes('--event-window')) {
                        const hint = `Scan found ${row.count} events. Set Event window (ms) to calculate scores. View the waveform to check the markers first.`
                        row.status = `Error: ${hint}`
                        Vsc.window.showWarningMessage(hint)
                    }
                    render(reason)
                } finally { busy = false; render(row.count === undefined ? row.status : `${row.name}: retained ${row.count} event(s).`) }
            }))
            await withStatusProgress(async report => {
                report.report({ message: `Loading captures… [0 of ${paths.length}]` })
                let loaded = 0
            for (const dir of paths) {
                if (disposed) break
                const row: Row = { dir, name: Path.relative(root.fsPath, dir).split(Path.sep).join('/') || '.', status: 'Loading…' }
                rows.push(row)
                render('Loading capture results…')
                try {
                    if (!await exists(Path.join(dir, '.emscope'))) {
                        row.status = 'Unpacking…'; render('Loading capture results…')
                        // EM•Scope 26.2.4 pack -u requires LFS metadata. Reuse its ZIP dependency
                        // for ordinary archives, without Git operations or overwriting local raw data.
                        const Zip = createRequire(scopePackage)('adm-zip')
                        const archive = Path.join(dir, 'emscope-capture.zip')
                        output.appendLine(`Unpacking ordinary archive: ${bashPath(archive)}`)
                        const zip = new Zip(archive)
                        for (const entry of zip.getEntries()) {
                            const name = entry.entryName.replaceAll('\\', '/')
                            if (!name.startsWith('.emscope/') || name.split('/').includes('..')) throw new Error('Archive contains an unexpected path')
                        }
                        zip.extractAllTo(dir, false)
                    }
                    if (!await exists(Path.join(dir, 'analysis.yaml'))) row.status = 'Captured — scan required'
                    else {
                        const analysis = await readAnalysis(row)
                        row.newCapture = await exists(Path.join(dir, '.emscope-pending')) || !analysis.options?.length
                        const drafts = (await Fs.readdir(dir, { withFileTypes: true }))
                            .filter(entry => entry.isDirectory() && entry.name.startsWith('.emscope-review-'))
                        for (const draft of drafts) {
                            const candidate = Path.join(dir, draft.name)
                            if (await exists(Path.join(candidate, '.emscope-draft')) && await exists(Path.join(candidate, 'analysis.yaml'))) {
                                row.candidate = candidate
                                break
                            }
                        }
                        if (refresh) {
                            const scanDir = row.candidate ?? dir
                            await readAnalysis(row, scanDir)
                            const overrides = readOverrides(row, scanDir)
                            await run(['scan', '-c', scanDir, ...scanArguments({ ...scanDefaults, ...overrides })])
                            await ctx.workspaceState.update(overridesKey(scanDir), overrides)
                        }
                        if (row.newCapture || row.candidate) await preview(row)
                        else await update(row)
                    }
                } catch (err) { row.status = `Error: ${message(err)}`; output.appendLine(`${row.name}: ${row.status}`) }
                render('')
                loaded++
                report.report({ increment: 100 / paths.length, message: `Loading captures… [${loaded} of ${paths.length}]` })
            }
            })
            if (!disposed) {
                const failures = rows.filter(row => row.status.startsWith('Error:')).length
                if (failures) Vsc.window.showWarningMessage(`EM•Scope loaded — ${failures} captures failed. See EM•Scope Output.`)
                else Vsc.window.showInformationMessage(`EM•Scope ready — ${rows.length} captures loaded.`)
            }
            busy = false; render('')
        } catch (err) { busy = false; output.appendLine(message(err)); render(`Unable to load captures: ${message(err)}. See EM•Scope Output.`) }
    }))
}

async function exists(path: string) { try { await Fs.access(path); return true } catch { return false } }
async function discover(root: string): Promise<string[]> {
    if (await exists(Path.join(root, 'capture.yaml'))) return [root]
    const found: string[] = []
    for (const entry of (await Fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) found.push(...await discover(Path.join(root, entry.name)))
    }
    return found
}
function command(cli: string, args: string[], cwd: string, output: Vsc.OutputChannel, onStdout?: (chunk: string) => void): Promise<string> {
    output.appendLine(`\nWorking directory: ${bashPath(cwd)}`)
    output.appendLine(`emscope ${args.map(a => JSON.stringify(Path.isAbsolute(a) ? bashPath(a) : a)).join(' ')}`)
    output.appendLine(`Executable: ${bashPath(process.execPath)} ${bashPath(cli)}`)
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
        let stdout = ''
        let stderr = ''
        proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8')
        proc.stdout.on('data', data => { stdout += data; output.append(data); onStdout?.(data) })
        proc.stderr.on('data', data => { stderr += data; output.append(data) })
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
            output.appendLine(`Exit: ${code}; signal: ${signal ?? 'none'}`)
            const reason = /\*\*\* ([^\r\n]+?) \*\*\*/.exec(stdout + '\n' + stderr)?.[1]
            code === 0 ? resolve(stdout) : reject(new Error(reason ?? `EM•Scope exited with ${code}. See EM•Scope Output.`))
        })
    })
}
function parseScore(text: string): Score {
    const result = JSON.parse(text.trim()) as Score
    if (result.type !== 'score' || ![result.sleepCurrent, result.eventEnergy, result.emeralds].every(Number.isFinite)) throw new Error('Unexpected EM•Scope JSON result')
    return result
}
function message(err: unknown) { return err instanceof Error ? err.message : String(err) }
function escape(text: string) { return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)) }
function html(root: string, rows: Row[], status: string, nonce: string, editing?: Row, busy = false, period = 10, sortKey: SortKey = 'name', sortDescending = false, scanDefaults: ScanValues = { 'event-window': 20 }, editingDefaults = false) {
    const periodLabel = formatPeriod(period)
    const heading = (key: SortKey, label: string, id = '') => `<th ${id ? `id="${id}"` : ''} aria-sort="${sortKey === key ? sortDescending ? 'descending' : 'ascending' : 'none'}"><button class="sort-button ${sortKey === key ? 'active' : ''}" data-sort="${key}" ${busy ? 'disabled' : ''}>${label}<span class="sort-arrow">${sortKey === key ? sortDescending ? '▼' : '▲' : ''}</span></button></th>`
    const number = (n?: number, scale = 1) => n === undefined ? '—' : (n * scale).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 20px; }
    h1 { font-size: 22px; } .root, .note { color: var(--vscode-descriptionForeground); } .table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; margin-top: 24px; } th, td { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border); text-align: right; font-variant-numeric: tabular-nums; } th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; } th { white-space: nowrap; } th:first-child { width: 34px; } td { overflow-wrap: anywhere; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 12px; cursor: pointer; } td:last-child { white-space: nowrap; } button:disabled { opacity: .5; cursor: default; } dialog { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); width: 440px; max-width: 85vw; max-height: 85vh; overflow-y: auto; } dialog::backdrop { background: #0008; } label { display: block; margin: 14px 0; } input { display: block; box-sizing: border-box; width: 100%; margin-top: 5px; padding: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); } small { color: var(--vscode-descriptionForeground); } .actions { display: flex; gap: 8px; justify-content: flex-end; }

    :root { --scope-accent: hsl(165, 80%, 45%); --scope-blue: #94b9dd; --scope-blue-fill: #4275a5; }
    body { margin: 0; padding: 32px; line-height: 1.5; }
    .masthead { display: flex; gap: 14px; align-items: center; margin-bottom: 6px; }
    .scope-mark { color: var(--scope-accent); flex: 0 0 auto; }
    h1 { font-size: 28px; font-weight: 600; letter-spacing: -.6px; margin: 0; }
    .dot { color: var(--scope-accent); }
    .subtitle { margin: 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .root { font-family: var(--vscode-editor-font-family); font-size: 12px; margin: 18px 0 24px; overflow-wrap: anywhere; }
    .table { border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
    table { margin-top: 0; }
    thead { background: var(--vscode-editor-inactiveSelectionBackground); }
    th { padding: 13px 14px; font-size: 11px; letter-spacing: .3px; font-weight: 600; }
    td { padding: 17px 14px; font-size: 13px; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    th:nth-child(2), td:nth-child(2) { width: 155px; min-width: 155px; max-width: 155px; box-sizing: border-box; }
    td:nth-child(2) { font-weight: 600; }
    .capture-name { display: block; width: 127px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    td:nth-child(6), td:nth-child(7) { color: var(--scope-accent); font-weight: 600; }
    .review-action { width: 28px; padding: 3px 0; color: var(--scope-blue); background: transparent; }
    .scan-field { margin-bottom: 12px; }
    .scan-field label { margin: 4px 0; }
    .inherit-window input { display: inline; width: auto; margin-right: 5px; }
    .root-picker { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 18px 0 24px; }
    .root-picker .root { margin: 0; }
    .capture-controls { display: inline-flex; align-items: center; gap: 5px; }
    .root-action { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; color: var(--scope-blue); background: transparent; border-color: rgba(148,185,221,.28); }
    .root-action[aria-disabled=true] { cursor: default; }
    #grab-capture { margin-left: 7px; background: var(--scope-blue-fill); color: #f3f7fb; }
    progress { display: block; width: 260px; max-width: 100%; height: 6px; accent-color: var(--scope-blue); margin: 10px 0; }
    .toolbar { position: relative; height: 34px; margin: -8px 0 12px; }
    .toolbar button { position: absolute; top: 0; right: 0; }
    #whatif { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; background: var(--scope-blue-fill); color: #f3f7fb; }
    .sort-button { background: transparent; color: inherit; padding: 0; border: 0; font: inherit; white-space: nowrap; }
    .sort-button.active { color: var(--scope-blue); }
    .sort-arrow { display: inline-block; width: 12px; margin-left: 4px; font-size: 9px; color: var(--scope-blue); }
    .score-heading { color: var(--scope-accent); }
    th:nth-child(6), td:nth-child(6) { padding-left: 14px; }
    th:nth-child(6), td:nth-child(6), th:nth-child(7), td:nth-child(7) { padding-right: 32px; }


    th:first-child, td.status-cell { width: 34px; min-width: 34px; max-width: 34px; padding-left: 10px; padding-right: 0; text-align: center; }
    .status-icon { display: inline-block; font-size: 17px; line-height: 1; white-space: nowrap; color: var(--scope-blue); }
    .status-icon.error { color: var(--vscode-errorForeground); }
    .status-icon.waiting { color: var(--vscode-descriptionForeground); }
    .badge { display: inline-block; padding: 3px 9px; border-radius: 12px; font-size: 11px; font-weight: 500; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .badge.ready { color: var(--scope-blue); background: rgba(148, 185, 221, .10); border: 1px solid rgba(148, 185, 221, .28); }
    button { font: inherit; font-size: 12px; border-radius: 5px; padding: 6px 11px; border: 1px solid transparent; }
    button[data-edit], button[type=submit] { background: var(--scope-blue-fill); color: #f3f7fb; font-weight: 600; }
    button[data-waveform], #cancel { color: var(--scope-blue); background: rgba(148, 185, 221, .05); border-color: rgba(148, 185, 221, .28); }
    button[data-edit], button[data-waveform] { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; background: transparent; color: var(--scope-blue); border: 1px solid transparent; vertical-align: middle; }
    button[data-edit]:hover:not(:disabled), button[data-waveform]:hover:not(:disabled) { background: rgba(148,185,221,.10); border-color: rgba(148,185,221,.28); }
    button:hover:not(:disabled) { filter: brightness(1.12); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
    .note { font-size: 11px; max-width: 760px; margin-top: 18px; }
    p[role=status]:empty { display: none; }
    p[role=status] { font-size: 12px; padding-left: 10px; border-left: 2px solid var(--scope-blue); }
    dialog { border-radius: 10px; padding: 24px; box-shadow: 0 16px 60px #0005; border-top: 3px solid var(--scope-blue); }
    dialog h2 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
    dialog p { color: var(--vscode-descriptionForeground); font-size: 12px; }
    label { font-size: 12px; font-weight: 600; }
    input { border-radius: 4px; padding: 8px 10px; font: inherit; font-variant-numeric: tabular-nums; }
    small { display: block; margin-top: 4px; font-size: 11px; font-weight: normal; }
    .actions { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
    @media (max-width: 700px) { body { padding: 18px; } th, td { padding: 10px; } }
    </style></head><body><header class="masthead"><svg class="scope-mark" aria-hidden="true" viewBox="0 0 32 28" width="38" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="28" height="20" rx="3"/><path d="M5 13h5l3-7 5 13 3-6h6M12 26h8M16 22v4"/></svg><div><h1>EM<span class="dot">•</span>Scope</h1><p class="subtitle">Capture · Analyze · Compare</p></div></header><div class="root-picker"><p class="root">${escape(bashPath(root))}</p><div class="capture-controls"><button id="choose-captures" class="root-action" title="Choose capture folder" aria-label="Choose capture folder" ${busy ? 'disabled' : ''}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 19V5h6l2 3h10v11z"/></svg></button><button id="refresh-captures" class="root-action" title="Rediscover and rescan captures with current settings" aria-label="Rediscover and rescan captures with current settings" ${busy ? 'disabled' : ''}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5M5 10a7 7 0 0 1 12-4l3 6M4 12l3 6a7 7 0 0 0 12-4"/></svg></button><button id="reset-view" class="root-action" title="Reset table sort and What-if period" aria-label="Reset table sort and What-if period" ${busy ? 'disabled' : ''}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11a8 8 0 1 1 2.3 6M4 5v6h6"/></svg></button><button id="capture-settings" class="root-action" title="Capture folder scan defaults" aria-label="Capture folder scan defaults" ${busy ? 'disabled' : ''}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M10 2h4l.6 3 2 .9 2.6-1.6 2.8 2.8-1.6 2.6.9 2 3 .6v4l-3 .6-.9 2 1.6 2.6-2.8 2.8-2.6-1.6-2 .9-.6 3h-4l-.6-3-2-.9-2.6 1.6L2 21.5l1.6-2.6-.9-2-3-.6v-4l3-.6.9-2L2 7.1l2.8-2.8 2.6 1.6 2-.9z" transform="translate(1 -1) scale(.92 .88)"/><circle cx="12" cy="11.6" r="3"/></svg></button><button id="grab-capture" class="root-action" title="Grab a new capture" aria-label="Grab a new capture" ${busy ? 'disabled' : ''}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg></button></div></div><p class="note">Workload period: 1 s · Event window: ${scanDefaults['event-window'] == null ? 'Not set' : number(scanDefaults['event-window']) + ' ms'}</p><div class="toolbar"><button id="whatif" ${busy ? 'disabled' : ''} title="What if… Change the projected scoring interval" aria-label="What if… Change the projected scoring interval"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="14" r="7"/><path d="M10 3h4m-2 0v4m5 1 2-2m-7 4v4"/></svg></button></div><div class="table"><table><thead><tr><th aria-label="Status"></th>${heading('name', 'Capture')}${heading('events', 'Events')}${heading('sleep', 'Sleep µA')}${heading('energy', 'Event µJ')}${heading('score', '<span class="score-heading">EM•eralds</span> [1s]')}${heading('projection', `<span class="score-heading">EM•eralds</span> [${periodLabel}]`, 'projection-heading')}<th></th></tr></thead><tbody>${rows.map(row => `<tr><td class="status-cell">${statusIcon(row.status)}</td><td><span class="capture-name" title="${escape(row.name)}">${escape(row.name)}</span></td><td>${row.count === undefined ? '—' : row.count.toLocaleString()}</td><td>${number(row.one?.sleepCurrent, 1e6)}</td><td>${number(row.one?.eventEnergy, 1e6)}</td><td>${number(row.one?.emeralds)}</td><td>${number(row.ten?.emeralds)}</td><td><button data-edit="${escape(row.name)}" ${busy || row.status.startsWith('Error: Grab failed') ? 'disabled' : ''} title="Adjust scan parameters and detect events" aria-label="Adjust scan parameters and detect events"><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 3v6M16 9v6M10 15v6"/></svg></button> <button data-waveform="${escape(row.name)}" ${busy || !row.count ? 'disabled' : ''} title="Explore the marked waveform in Joulescope Viewer" aria-label="Explore the marked waveform in Joulescope Viewer"><svg aria-hidden="true" viewBox="0 0 32 28" width="20" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="28" height="20" rx="3"/><path d="M5 13h5l3-7 5 13 3-6h6M12 26h8M16 22v4"/></svg></button>${row.newCapture || row.candidate ? ` <button class="review-action" data-keep="${escape(row.name)}" title="Accept this scan and its scores" aria-label="Accept this scan and its scores" ${busy || !row.count ? 'disabled' : ''}>✓</button> <button class="review-action" data-discard="${escape(row.name)}" title="Discard ${row.candidate ? 'candidate scan' : 'capture'}" aria-label="Discard ${row.candidate ? 'candidate scan' : 'capture'}" ${busy ? 'disabled' : ''}>✕</button>` : ''}</td></tr>`).join('')}</tbody></table></div>${rows.some(row => (row.newCapture || row.candidate) && row.count) ? '<p class="note">Provisional scores update after Scan. Inspect the waveform, refine the scan, or click ✓ Keep.</p>' : ''}<p class="note">Scores project the measured event and sleep energy at the indicated repetition period. Commands and diagnostics are available in Output → EM•Scope.</p>${editing ? `<dialog open><form id="scan-form"><h2>Scan ${escape(editing.name)}</h2><p>Uncheck a field to override it. A blank override omits that option.</p>${scanInputs(scanDefaults, editing.overrides ?? {})}<div class="actions"><button type="button" id="cancel">Cancel</button><button type="submit">Scan</button></div></form></dialog>` : ''}
    ${editingDefaults ? `<dialog open><form id="defaults-form"><h2>Capture folder settings</h2><p>Workload period: 1 s</p><h3>Scan defaults</h3>${scanInputs(scanDefaults)}<p>Blank fields use EM•Scope defaults. Refresh applies these settings to inheriting captures.</p><div class="actions"><button type="button" id="cancel-defaults">Cancel</button><button type="submit">Save</button></div></form></dialog>` : ''}
    <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => vscode.postMessage({kind:'sort',key:button.dataset.sort})));
    const savedScroll = vscode.getState();
    if (savedScroll) requestAnimationFrame(() => {
        window.scrollTo(savedScroll.x || 0, savedScroll.y || 0);
        document.querySelector('.table').scrollLeft = savedScroll.tableX || 0;
    });
    const rememberScroll = () => vscode.setState({x: window.scrollX, y: window.scrollY, tableX: document.querySelector('.table').scrollLeft});
    window.addEventListener('scroll', rememberScroll, {passive:true});
    document.querySelector('.table').addEventListener('scroll', rememberScroll, {passive:true});
    document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => vscode.postMessage({kind:'edit',name:button.dataset.edit})));
    document.querySelectorAll('[data-waveform]').forEach(button => button.addEventListener('click', () => vscode.postMessage({kind:'waveform',name:button.dataset.waveform})));
    document.getElementById('choose-captures').addEventListener('click', () => vscode.postMessage({kind:'choose'}));
    document.getElementById('refresh-captures').addEventListener('click', () => vscode.postMessage({kind:'refresh'}));
    document.getElementById('reset-view').addEventListener('click', () => vscode.postMessage({kind:'reset-view'}));
    document.getElementById('grab-capture').addEventListener('click', () => vscode.postMessage({kind:'grab'}));
    document.getElementById('capture-settings').addEventListener('click', () => vscode.postMessage({kind:'capture-settings'}));
    const alignWhatIf = () => {
        const button = document.getElementById('whatif');
        const heading = document.getElementById('projection-heading');
        const toolbar = document.querySelector('.toolbar');
        const padding = parseFloat(getComputedStyle(heading).paddingRight) || 0;
        const left = heading.getBoundingClientRect().right - padding - toolbar.getBoundingClientRect().left - button.offsetWidth;
        button.style.left = Math.max(0, Math.min(left, toolbar.clientWidth - button.offsetWidth)) + 'px';
        button.style.right = 'auto';
    };
    new ResizeObserver(alignWhatIf).observe(document.querySelector('table'));
    document.querySelector('.table').addEventListener('scroll', alignWhatIf);
    alignWhatIf();
    document.getElementById('whatif').addEventListener('click', () => vscode.postMessage({kind:'whatif'}));
    document.querySelectorAll('[data-keep]').forEach(button => button.addEventListener('click', () => vscode.postMessage({kind:'keep',name:button.dataset.keep})));
    document.querySelectorAll('[data-discard]').forEach(button => button.addEventListener('click', () => vscode.postMessage({kind:'discard',name:button.dataset.discard})));
    const form = document.getElementById('scan-form');
    const defaultsForm = document.getElementById('defaults-form');
    if (defaultsForm) {
        const dialog = defaultsForm.closest('dialog'); dialog.close(); dialog.showModal();
        const cancel = () => vscode.postMessage({kind:'cancel'});
        document.getElementById('cancel-defaults').addEventListener('click', cancel);
        dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
        defaultsForm.addEventListener('submit', event => {
            event.preventDefault();
            vscode.postMessage({kind:'save-defaults',values: Object.fromEntries(new FormData(defaultsForm))});
        });
    }
    if (form) {
        for (const inherit of form.querySelectorAll('[data-inherit]')) {
            const input = form.elements.namedItem(inherit.dataset.inherit);
            let override = input.value;
            const sync = () => {
                input.readOnly = inherit.checked;
                input.value = inherit.checked ? input.dataset.folderValue : override;
            };
            inherit.addEventListener('change', () => {
                if (inherit.checked) override = input.value;
                sync();
            });
            sync();
        }
        const dialog = document.querySelector('dialog'); dialog.close(); dialog.showModal();
        const cancel = () => vscode.postMessage({kind:'cancel'});
        document.getElementById('cancel').addEventListener('click', cancel);
        dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
        form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; const values = Object.fromEntries(new FormData(form)); form.querySelectorAll('button').forEach(b => b.disabled = true); vscode.postMessage({kind:'scan',name:${JSON.stringify(editing?.name ?? '').replaceAll('<', '\\u003c')},values}); });
    }
    </script></body></html>`
}

function projectionSeconds(text: string): number | undefined {
    const value = text.trim()
    if (!/^\d+$/.test(value) && !/^[0-5]?\d:[0-5]\d$/.test(value) && !/^\d+:[0-5]\d:[0-5]\d$/.test(value)) return undefined
    const seconds = value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined
}

function bashPath(path: string): string {
    const normalized = path.replaceAll('\\', '/')
    const home = homedir().replaceAll('\\', '/').replace(/\/$/, '')
    const compare = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    if (compare(normalized) === compare(home)) return '~'
    if (compare(normalized).startsWith(compare(home) + '/')) return '~' + normalized.slice(home.length)
    return normalized.replace(/^([a-zA-Z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`)
}

function statusIcon(status: string): string {
    const ready = status === 'Ready'
    const error = status.startsWith('Error:') || status.startsWith('No events')
    const pending = /Loading|Unpacking|Scanning|Refreshing|Grabbing/.test(status)
    const icon = ready ? '✓' : error ? '✕' : pending ? '⌛' : '○'
    const kind = error ? 'error' : ready || pending ? '' : 'waiting'
    return `<span class="status-icon ${kind}" role="img" title="${escape(status)}" aria-label="${escape(status)}">${icon}</span>`
}

async function withStatusProgress(task: (progress: Vsc.Progress<{ message?: string, increment?: number }>) => Promise<void>): Promise<void> {
    try {
        await task({ report: update => {
            if (currentPanel) scopeStatus.text = `$(sync~spin) EM•Scope: ${update.message ?? ''}`
        } })
    } finally {
        if (currentPanel) scopeStatus.text = '$(pulse) EM•Scope: Ready'
    }
}

function sortedRows(rows: Row[], key: SortKey, descending: boolean): Row[] {
    const value = (row: Row): number | undefined => {
        switch (key) {
            case 'events': return row.count
            case 'sleep': return row.one?.sleepCurrent
            case 'energy': return row.one?.eventEnergy
            case 'score': return row.one?.emeralds
            case 'projection': return row.ten?.emeralds
            default: return undefined
        }
    }
    const byName = (a: Row, b: Row) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
    return [...rows].sort((a, b) => {
        const ap = Boolean(a.newCapture || a.candidate), bp = Boolean(b.newCapture || b.candidate)
        if (ap !== bp) return ap ? -1 : 1
        if (ap && bp) return 0
        if (key === 'name') return byName(a, b) * (descending ? -1 : 1)
        const av = value(a), bv = value(b)
        if (av === undefined || bv === undefined) return av === bv ? byName(a, b) : av === undefined ? 1 : -1
        return (av - bv) * (descending ? -1 : 1) || byName(a, b)
    })
}

function formatPeriod(period: number): string {
    return [Math.floor(period / 3600), Math.floor(period / 60) % 60, period % 60].map(part => String(part).padStart(2, '0')).join(':')
}


async function validateCaptureName(root: string, name: string): Promise<string | undefined> {
    const parts = name.split('/')
    if (!parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return 'Use letters, digits, dashes, and underscores. Separate folders with /.'
    if (parts.some(part => /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(part))) return 'Choose a name that is valid on Windows.'
    let dir = root
    for (const [index, part] of parts.entries()) {
        dir = Path.join(dir, part)
        const entry = await capturePathEntry(dir)
        if (!entry) return
        if (index === parts.length - 1) return 'That capture path already exists.'
        if (!entry.isDirectory() || entry.isSymbolicLink()) return 'Parent paths must be ordinary folders.'
    }
}

async function capturePathEntry(dir: string) {
    try { return await Fs.lstat(dir) }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        return undefined
    }
}

async function createCaptureFolder(root: string, name: string): Promise<string> {
    let dir = root
    const parts = name.split('/')
    for (const [index, part] of parts.entries()) {
        dir = Path.join(dir, part)
        if (index === parts.length - 1) await Fs.mkdir(dir)
        else {
            try { await Fs.mkdir(dir) }
            catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
                const entry = await Fs.lstat(dir)
                if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Parent paths must be ordinary folders.')
            }
        }
    }
    return dir
}

function grabError(reason: string): string {
    if (reason.includes('no PPK2 analyzer found')) return `${reason}. Check the USB connection and look for the green light.`
    if (reason.includes('no PPK2 data port found')) return `${reason}. If Nordic Power Profiler has the PPK2 selected, close it and wait for the green light before retrying.`
    return reason
}


function readScanForm(values: Record<string, unknown> | undefined, row: boolean): ScanValues {
    const result: ScanValues = {}
    for (const [field, label] of fields) {
        if (row && values?.[`inherit-${field}`] === 'on') continue
        const text = values?.[field]
        if (typeof text !== 'string') throw new Error(`Invalid ${label}`)
        if (!text.trim()) {
            if (row) result[field] = null
            continue
        }
        const number = Number(text)
        const positive = field === 'event-window' || field === 'sleep-window' || field === 'trim'
        if (!Number.isFinite(number) || number < 0 || (positive && number === 0) || (field === 'trim' && !Number.isInteger(number))) {
            throw new Error(`Invalid ${label}`)
        }
        result[field] = number
    }
    return result
}

function scanArguments(values: ScanValues): string[] {
    const args: string[] = []
    for (const [field] of fields) {
        const value = values[field]
        if (value != null) args.push(`--${field}`, String(value))
    }
    return args
}

function scanInputs(defaults: ScanValues, overrides?: ScanValues): string {
    return fields.map(([field, label, help]) => {
        const inherited = overrides !== undefined && !Object.prototype.hasOwnProperty.call(overrides, field)
        const folderValue = String(defaults[field] ?? '')
        const value = overrides === undefined || inherited ? folderValue : String(overrides[field] ?? '')
        const placeholder = field === 'sleep-window' ? '500 (CLI default)' : 'Not set'
        return `<div class="scan-field"><label>${label}<input name="${field}" type="number" min="0" step="${field === 'trim' ? '1' : 'any'}" value="${escape(value)}" data-folder-value="${escape(folderValue)}" placeholder="${placeholder}"></label><small>${help}</small>${overrides === undefined ? '' : `<label class="inherit-window"><input name="inherit-${field}" data-inherit="${field}" type="checkbox" ${inherited ? 'checked' : ''}> Use folder default</label>`}</div>`
    }).join('')
}
