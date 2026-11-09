import * as Vsc from 'vscode'
import * as Fs from 'fs/promises'
import * as Path from 'path'
import { homedir } from 'os'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import * as Yaml from 'js-yaml'

type Score = { type: string, sleepCurrent: number, eventEnergy: number, emeralds: number }
type Row = { name: string, dir: string, status: string, count?: number, options?: string[], one?: Score, ten?: Score }
const fields = [
    ['gap', 'Merge gaps (ms)', 'Combine nearby activity regions.'],
    ['min-duration', 'Minimum duration (ms)', 'Reject shorter activity regions.'],
    ['min-energy', 'Minimum energy (µJ)', 'Reject lower-energy activity regions.'],
    ['trim', 'Trim (1-second cycles)', 'Current CLI assumes one-second cycles; excludes boundary activity.'],
    ['event-window', 'Event window (ms)', 'Fixed scoring window from each event start.'],
    ['sleep-window', 'Sleep window (ms)', 'Quiet-baseline search window; default 500 ms.'],
] as const
type ViewerSettings = { projectionSeconds?: number }

let currentPanel: Vsc.WebviewPanel | undefined
let currentRoot: string | undefined
let rootListeners: Vsc.Disposable[] = []

export function init(ctx: Vsc.ExtensionContext) {
    const output = Vsc.window.createOutputChannel('EM•Scope')
    ctx.subscriptions.push(output, Vsc.commands.registerCommand('embuilder.showScope', async (uri?: Vsc.Uri) => {
        const workspace = Vsc.workspace.workspaceFolders?.[0]?.uri
        if (!workspace) { Vsc.window.showErrorMessage('Open an Emporium workspace first.'); return }
        const savedRoot = ctx.workspaceState.get<string>('embuilder.scope.lastRoot')
        const root = uri ?? (savedRoot ? Vsc.Uri.file(savedRoot) : Vsc.Uri.joinPath(workspace, 'captures'))
        if (root.scheme !== 'file') { Vsc.window.showErrorMessage('EM•Scope requires a local capture folder.'); return }
        const key = root.toString()
        await ctx.workspaceState.update('embuilder.scope.lastRoot', root.fsPath)
        if (currentPanel && (!uri || currentRoot === key)) { currentPanel.reveal(); return }
        for (const listener of rootListeners) listener.dispose()
        rootListeners = []
        if (!currentPanel) {
            currentPanel = Vsc.window.createWebviewPanel('embuilder.scope', 'EM•Scope', Vsc.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true })
            ctx.subscriptions.push(currentPanel)
            currentPanel.onDidDispose(() => {
                currentPanel = undefined; currentRoot = undefined
                for (const listener of rootListeners) listener.dispose()
                rootListeners = []
            })
        }
        const panel = currentPanel
        currentRoot = key
        panel.reveal()
        let disposed = false
        rootListeners.push(panel.onDidDispose(() => { disposed = true }))
        const rows: Row[] = []
        let editing: Row | undefined
        let busy = true
        const settingsKey = `embuilder.scope.settings:${key}`
        const settings = ctx.workspaceState.get<ViewerSettings>(settingsKey, {})
        const savedPeriod = settings.projectionSeconds
        let period = typeof savedPeriod === 'number' && Number.isSafeInteger(savedPeriod) && savedPeriod > 0 ? savedPeriod : 10
        const nonce = require('crypto').randomBytes(16).toString('hex') as string
        const render = (message: string) => {
            if (disposed) return
            if (message && !busy) Vsc.window.setStatusBarMessage(`EM•Scope: ${message}`, 5000)
            panel.webview.html = html(root.fsPath, rows, message, nonce, editing, busy, period)
        }
        rootListeners.push(panel.webview.onDidReceiveMessage(async msg => {
            if (msg?.kind !== 'choose' || busy) return
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
            if (!paths.length) { busy = false; render('No captures found.'); return }
            const localRequire = createRequire(Path.join(workspace.fsPath, 'package.json'))
            const scopePackage = localRequire.resolve('@em-foundation/emscope/package.json')
            const cli = Path.join(Path.dirname(scopePackage), 'dist', 'emscope')
            const run = (args: string[]) => command(cli, args, workspace.fsPath, output)
            const update = async (row: Row, explicit = false) => {
                row.one = undefined; row.ten = undefined
                const analysis = Yaml.load(await Fs.readFile(Path.join(row.dir, 'analysis.yaml'), 'utf8')) as { options?: string[], events?: unknown[] }
                row.options = analysis.options ?? []
                row.count = analysis.events?.length ?? 0
                if (!explicit && !row.options.length) { row.status = 'Captured — scan required'; row.count = undefined; return }
                if (!row.count) { row.status = 'No events — adjust scan'; return }
                const one = parseScore(await run(['view', '-c', row.dir, '-w', '00:00:01', '--json']))
                const ten = parseScore(await run(['view', '-c', row.dir, '-w', String(period), '--json']))
                row.one = one; row.ten = ten; row.status = 'Ready'
            }
            rootListeners.push(panel.webview.onDidReceiveMessage(async msg => {
                if (busy || disposed || !msg || typeof msg !== 'object') return
                if (msg.kind === 'whatif') {
                    busy = true
                    try {
                        const value = await Vsc.window.showInputBox({
                            title: 'EM•Scope What-if', value: String(period),
                            prompt: 'Projection period for all captures: seconds, MM:SS, or HH:MM:SS',
                            validateInput: text => projectionSeconds(text) === undefined ? 'Enter a positive period, such as 10, 60, or 01:00:00.' : undefined,
                        })
                        if (value === undefined) return
                        const nextPeriod = projectionSeconds(value)!
                        await ctx.workspaceState.update(settingsKey, { ...settings, projectionSeconds: nextPeriod })
                        settings.projectionSeconds = nextPeriod
                        period = nextPeriod
                        const targets = rows.filter(row => row.one && row.count)
                        for (const row of targets) { row.ten = undefined; row.status = 'Refreshing projection…' }
                        render('')
                        let failures = 0
                        await Vsc.window.withProgress({ location: Vsc.ProgressLocation.Notification, title: 'EM•Scope' }, async report => {
                            report.report({ message: `Refreshing… [0 of ${targets.length}]` })
                            let done = 0
                            for (const row of targets) {
                                if (disposed) break
                                try {
                                    row.ten = parseScore(await run(['view', '-c', row.dir, '-w', String(period), '--json']))
                                    row.status = 'Ready'
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
                        if (!disposed) Vsc.window.setStatusBarMessage(failures ? `EM•Scope refreshed — ${failures} projection(s) failed; see Output.` : 'EM•Scope refreshed.', 5000)
                    } catch (err) {
                        output.appendLine(message(err))
                        Vsc.window.setStatusBarMessage('EM•Scope refresh failed; see Output.', 5000)
                    } finally { busy = false; render('') }
                    return
                }
                if (msg.kind === 'cancel') { editing = undefined; render(''); return }
                const row = rows.find(r => r.name === msg.name)
                if (!row) return
                if (msg.kind === 'waveform') {
                    if (!row.one || !row.count) return
                    busy = true
                    render(`Opening waveform for ${row.name}…`)
                    let result = ''
                    try {
                        await run(['view', '-c', row.dir, '-j'])
                        result = `Opened ${row.name} in Joulescope Viewer.`
                    } catch (err) {
                        result = `Waveform: ${message(err)}`
                        output.appendLine(result)
                    } finally { busy = false; render(result) }
                    return
                }
                if (msg.kind === 'edit') {
                    try {
                        const a = Yaml.load(await Fs.readFile(Path.join(row.dir, 'analysis.yaml'), 'utf8')) as { options?: string[] }
                        row.options = a?.options ?? []
                    } catch { row.options = [] }
                    editing = row; render(''); return
                }
                if (msg.kind !== 'scan' || editing !== row) return
                try {
                    const args = ['scan', '-c', row.dir]
                    for (const [key] of fields) {
                        const text = msg.values?.[key]
                        if (typeof text !== 'string') throw new Error('Invalid scan settings')
                        if (!text.trim()) continue
                        const value = Number(text)
                        if (!Number.isFinite(value) || value < 0 || (['event-window', 'sleep-window', 'trim'].includes(key) && value <= 0) || (key === 'trim' && !Number.isInteger(value))) throw new Error(`Invalid ${key} value`)
                        args.push(`--${key}`, String(value))
                    }
                    busy = true; editing = undefined; row.status = 'Scanning…'
                    row.one = undefined; row.ten = undefined; row.count = undefined
                    render(`Scanning ${row.name}…`)
                    await run(args)
                    await update(row, true)
                    render(`${row.name}: retained ${row.count} event(s).`)
                } catch (err) {
                    row.status = `Error: ${message(err)}`
                    output.appendLine(`${row.name}: ${row.status}`)
                    render(message(err))
                } finally { busy = false; render(row.count === undefined ? row.status : `${row.name}: retained ${row.count} event(s).`) }
            }))
            await Vsc.window.withProgress({ location: Vsc.ProgressLocation.Notification, title: 'EM•Scope' }, async report => {
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
                    else await update(row)
                } catch (err) { row.status = `Error: ${message(err)}`; output.appendLine(`${row.name}: ${row.status}`) }
                render('')
                loaded++
                report.report({ increment: 100 / paths.length, message: `Loading captures… [${loaded} of ${paths.length}]` })
            }
            })
            if (!disposed) Vsc.window.setStatusBarMessage('EM•Scope loaded.', 5000)
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
function command(cli: string, args: string[], cwd: string, output: Vsc.OutputChannel): Promise<string> {
    output.appendLine(`\nWorking directory: ${bashPath(cwd)}`)
    output.appendLine(`emscope ${args.map(a => JSON.stringify(Path.isAbsolute(a) ? bashPath(a) : a)).join(' ')}`)
    output.appendLine(`Executable: ${bashPath(process.execPath)} ${bashPath(cli)}`)
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
        let stdout = ''
        proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8')
        proc.stdout.on('data', data => { stdout += data; output.append(data) })
        proc.stderr.on('data', data => output.append(data))
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
            output.appendLine(`Exit: ${code}; signal: ${signal ?? 'none'}`)
            code === 0 ? resolve(stdout) : reject(new Error(`EM•Scope exited with ${code}. See EM•Scope Output.`))
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
function html(root: string, rows: Row[], status: string, nonce: string, editing?: Row, busy = false, period = 10) {
    const periodLabel = [Math.floor(period / 3600), Math.floor(period / 60) % 60, period % 60].map(part => String(part).padStart(2, '0')).join(':')
    const number = (n?: number, scale = 1) => n === undefined ? '—' : (n * scale).toLocaleString(undefined, { maximumFractionDigits: 2 })
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
    th:nth-child(2), td:nth-child(2) { width: 180px; min-width: 180px; max-width: 180px; box-sizing: border-box; }
    td:nth-child(2) { font-weight: 600; }
    .capture-name { display: block; width: 152px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    td:nth-child(6), td:nth-child(7) { color: var(--scope-accent); font-weight: 600; }
    .root-picker { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin: 18px 0 24px; }
    .root-picker .root { margin: 0; }
    #choose-captures { color: var(--scope-blue); background: transparent; border-color: rgba(148,185,221,.28); }
    progress { display: block; width: 260px; max-width: 100%; height: 6px; accent-color: var(--scope-blue); margin: 10px 0; }
    .toolbar { position: relative; height: 34px; margin: -8px 0 12px; }
    .toolbar button { position: absolute; top: 0; right: 0; }
    #whatif { background: var(--scope-blue-fill); color: #f3f7fb; }
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
    </style></head><body><header class="masthead"><svg class="scope-mark" aria-hidden="true" viewBox="0 0 32 28" width="38" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="28" height="20" rx="3"/><path d="M5 13h5l3-7 5 13 3-6h6M12 26h8M16 22v4"/></svg><div><h1>EM<span class="dot">•</span>Scope</h1><p class="subtitle">Capture · Analyze · Compare</p></div></header><div class="root-picker"><p class="root">${escape(bashPath(root))}</p><button id="choose-captures" ${busy ? 'disabled' : ''}>Choose Captures...</button></div><div class="toolbar"><button id="whatif" ${busy ? 'disabled' : ''}>What if...</button></div><div class="table"><table><thead><tr><th aria-label="Status"></th><th>Capture</th><th>Events</th><th>Sleep µA</th><th>Event µJ</th><th><span class="score-heading">EM•eralds</span> [1s]</th><th id="projection-heading"><span class="score-heading">EM•eralds</span> [${periodLabel}]</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td class="status-cell">${statusIcon(row.status)}</td><td><span class="capture-name" title="${escape(row.name)}">${escape(row.name)}</span></td><td>${number(row.count)}</td><td>${number(row.one?.sleepCurrent, 1e6)}</td><td>${number(row.one?.eventEnergy, 1e6)}</td><td>${number(row.one?.emeralds)}</td><td>${number(row.ten?.emeralds)}</td><td><button data-edit="${escape(row.name)}" ${busy ? 'disabled' : ''}>Scan…</button> <button data-waveform="${escape(row.name)}" ${busy || !row.one || !row.count ? 'disabled' : ''} title="Open waveform in Joulescope Viewer">View</button></td></tr>`).join('')}</tbody></table></div><p class="note">Scores project the measured event and sleep energy at the indicated repetition period. Commands and diagnostics are available in Output → EM•Scope.</p>${editing ? `<dialog open><form id="scan-form"><h2>Scan ${escape(editing.name)}</h2><p>Blank fields omit that option. Raw recording is unchanged.</p>${fields.map(([key, label, help]) => {
        const saved = editing.options?.find(opt => opt.startsWith(`--${key} `))?.split(/\s+/)[1] ?? ''
        return `<label>${label}<input name="${key}" type="number" step="${key === 'trim' ? '1' : 'any'}" min="0" value="${escape(saved)}" placeholder="${key === 'sleep-window' ? '500 (default)' : 'Not set'}"><small>${help}</small></label>`
    }).join('')}<div class="actions"><button type="button" id="cancel">Cancel</button><button type="submit">Scan</button></div></form></dialog>` : ''}
    <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
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
    const form = document.getElementById('scan-form');
    if (form) {
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
    const pending = /Loading|Unpacking|Scanning|Refreshing/.test(status)
    const icon = ready ? '✓' : error ? '✕' : pending ? '⌛' : '○'
    const kind = error ? 'error' : ready || pending ? '' : 'waiting'
    return `<span class="status-icon ${kind}" role="img" title="${escape(status)}" aria-label="${escape(status)}">${icon}</span>`
}
