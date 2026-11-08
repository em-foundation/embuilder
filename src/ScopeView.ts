import * as Vsc from 'vscode'
import * as Fs from 'fs/promises'
import * as Path from 'path'
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
const panels = new Map<string, Vsc.WebviewPanel>()

export function init(ctx: Vsc.ExtensionContext) {
    const output = Vsc.window.createOutputChannel('EM•Scope')
    ctx.subscriptions.push(output, Vsc.commands.registerCommand('embuilder.showScope', async (uri?: Vsc.Uri) => {
        const workspace = Vsc.workspace.workspaceFolders?.[0]?.uri
        if (!workspace) { Vsc.window.showErrorMessage('Open an Emporium workspace first.'); return }
        const root = uri ?? Vsc.Uri.joinPath(workspace, 'captures')
        if (root.scheme !== 'file') { Vsc.window.showErrorMessage('EM•Scope requires a local capture folder.'); return }
        const key = root.toString()
        const existing = panels.get(key)
        if (existing) { existing.reveal(); return }
        const panel = Vsc.window.createWebviewPanel('embuilder.scope', 'EM•Scope', Vsc.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true })
        panels.set(key, panel)
        ctx.subscriptions.push(panel)
        let disposed = false
        panel.onDidDispose(() => { disposed = true; panels.delete(key) })
        const rows: Row[] = []
        let editing: Row | undefined
        let busy = true
        const nonce = require('crypto').randomBytes(16).toString('hex') as string
        const render = (message: string) => { if (!disposed) panel.webview.html = html(root.fsPath, rows, message, nonce, editing, busy) }
        render('Discovering captures…')
        try {
            const paths = await discover(root.fsPath)
            if (!paths.length) { render('No captures found.'); return }
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
                const ten = parseScore(await run(['view', '-c', row.dir, '-w', '00:00:10', '--json']))
                row.one = one; row.ten = ten; row.status = 'Ready'
            }
            ctx.subscriptions.push(panel.webview.onDidReceiveMessage(async msg => {
                if (busy || disposed || !msg || typeof msg !== 'object') return
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
                        output.appendLine(`Unpacking ordinary archive: ${archive}`)
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
            }
            busy = false; render('')
        } catch (err) { output.appendLine(message(err)); render(`Unable to load captures: ${message(err)}. See EM•Scope Output.`) }
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
    output.appendLine(`\nWorking directory: ${cwd}`)
    output.appendLine(`emscope ${args.map(a => JSON.stringify(a)).join(' ')}`)
    output.appendLine(`Executable: ${process.execPath} ${cli}`)
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
function html(root: string, rows: Row[], status: string, nonce: string, editing?: Row, busy = false) {
    const number = (n?: number, scale = 1) => n === undefined ? '—' : (n * scale).toLocaleString(undefined, { maximumFractionDigits: 2 })
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 20px; }
    h1 { font-size: 22px; } .root, .note { color: var(--vscode-descriptionForeground); } .table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; margin-top: 24px; } th, td { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border); text-align: right; font-variant-numeric: tabular-nums; } th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; } th { white-space: normal; } th:first-child { width: 30%; } td { overflow-wrap: anywhere; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 12px; cursor: pointer; } td:last-child { white-space: nowrap; } button:disabled { opacity: .5; cursor: default; } dialog { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); width: 440px; max-width: 85vw; max-height: 85vh; overflow-y: auto; } dialog::backdrop { background: #0008; } label { display: block; margin: 14px 0; } input { display: block; box-sizing: border-box; width: 100%; margin-top: 5px; padding: 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); } small { color: var(--vscode-descriptionForeground); } .actions { display: flex; gap: 8px; justify-content: flex-end; }
    </style></head><body><h1>EM•Scope</h1><p class="root">${escape(root)}</p><div class="table"><table><thead><tr><th>Capture</th><th>Status</th><th>Events</th><th>Sleep<br>µA</th><th>Event<br>µJ</th><th>EM•eralds<br>1 s</th><th>EM•eralds<br>10 s</th><th></th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.name)}</td><td>${escape(row.status)}</td><td>${number(row.count)}</td><td>${number(row.one?.sleepCurrent, 1e6)}</td><td>${number(row.one?.eventEnergy, 1e6)}</td><td>${number(row.one?.emeralds)}</td><td>${number(row.ten?.emeralds)}</td><td><button data-edit="${escape(row.name)}" ${busy ? 'disabled' : ''}>Scan…</button> <button data-waveform="${escape(row.name)}" ${busy || !row.one || !row.count ? 'disabled' : ''}>View Waveform</button></td></tr>`).join('')}</tbody></table></div><p role="status">${escape(status)}</p><p class="note">Scores project the measured event and sleep energy at the indicated repetition period. Commands and diagnostics are available in Output → EM•Scope.</p>${editing ? `<dialog open><form id="scan-form"><h2>Scan ${escape(editing.name)}</h2><p>Blank fields omit that option. Raw recording is unchanged.</p>${fields.map(([key, label, help]) => {
        const saved = editing.options?.find(opt => opt.startsWith(`--${key} `))?.split(/\s+/)[1] ?? ''
        return `<label>${label}<input name="${key}" type="number" step="${key === 'trim' ? '1' : 'any'}" min="0" value="${escape(saved)}" placeholder="${key === 'sleep-window' ? '500 (default)' : 'Not set'}"><small>${help}</small></label>`
    }).join('')}<div class="actions"><button type="button" id="cancel">Cancel</button><button type="submit">Scan</button></div></form></dialog>` : ''}
    <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-edit]').forEach(button => button.addEventListener('click', () => vscode.postMessage({kind:'edit',name:button.dataset.edit})));
    document.querySelectorAll('[data-waveform]').forEach(button => button.addEventListener('click', () => vscode.postMessage({kind:'waveform',name:button.dataset.waveform})));
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
