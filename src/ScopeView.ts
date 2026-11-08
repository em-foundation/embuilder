import * as Vsc from 'vscode'
import * as Fs from 'fs/promises'
import * as Path from 'path'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import * as Yaml from 'js-yaml'

type Score = { type: string, sleepCurrent: number, eventEnergy: number, emeralds: number }
type Row = { name: string, status: string, one?: Score, ten?: Score }
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
        const panel = Vsc.window.createWebviewPanel('embuilder.scope', 'EM•Scope', Vsc.ViewColumn.Active, {})
        panels.set(key, panel)
        ctx.subscriptions.push(panel)
        let disposed = false
        panel.onDidDispose(() => { disposed = true; panels.delete(key) })
        const rows: Row[] = []
        const render = (message: string) => { if (!disposed) panel.webview.html = html(root.fsPath, rows, message) }
        render('Discovering captures…')
        try {
            const paths = await discover(root.fsPath)
            if (!paths.length) { render('No captures found.'); return }
            const localRequire = createRequire(Path.join(workspace.fsPath, 'package.json'))
            const scopePackage = localRequire.resolve('@em-foundation/emscope/package.json')
            const cli = Path.join(Path.dirname(scopePackage), 'dist', 'emscope')
            const run = (args: string[]) => command(cli, args, workspace.fsPath, output)
            for (const dir of paths) {
                if (disposed) break
                const row: Row = { name: Path.relative(root.fsPath, dir).split(Path.sep).join('/') || '.', status: 'Loading…' }
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
                    else {
                        const analysis = Yaml.load(await Fs.readFile(Path.join(dir, 'analysis.yaml'), 'utf8')) as { options?: unknown[] }
                        if (!analysis?.options?.length) row.status = 'Captured — scan required'
                        else {
                            row.one = parseScore(await run(['view', '-c', dir, '-w', '00:00:01', '--json']))
                            row.ten = parseScore(await run(['view', '-c', dir, '-w', '00:00:10', '--json']))
                            row.status = 'Ready'
                        }
                    }
                } catch (err) { row.status = `Error: ${message(err)}`; output.appendLine(`${row.name}: ${row.status}`) }
                render('')
            }
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
function html(root: string, rows: Row[], status: string) {
    const number = (n?: number, scale = 1) => n === undefined ? '—' : (n * scale).toLocaleString(undefined, { maximumFractionDigits: 2 })
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); padding: 20px; }
    h1 { font-size: 22px; } .root, .note { color: var(--vscode-descriptionForeground); } .table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; margin-top: 24px; } th, td { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border); text-align: right; font-variant-numeric: tabular-nums; } th:first-child, td:first-child, th:nth-child(2), td:nth-child(2) { text-align: left; } th { white-space: nowrap; } td { overflow-wrap: anywhere; }
    </style></head><body><h1>EM•Scope</h1><p class="root">${escape(root)}</p><div class="table"><table><thead><tr><th>Capture</th><th>Status</th><th>Sleep current (µA)</th><th>Event energy (µJ)</th><th>EM•eralds · 1 s</th><th>EM•eralds · 10 s</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.name)}</td><td>${escape(row.status)}</td><td>${number(row.one?.sleepCurrent, 1e6)}</td><td>${number(row.one?.eventEnergy, 1e6)}</td><td>${number(row.one?.emeralds)}</td><td>${number(row.ten?.emeralds)}</td></tr>`).join('')}</tbody></table></div><p role="status">${escape(status)}</p><p class="note">Scores project the measured event and sleep energy at the indicated repetition period. Commands and diagnostics are available in Output → EM•Scope.</p></body></html>`
}
