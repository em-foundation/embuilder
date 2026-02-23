import * as Utils from './Utils'
import * as Vsc from 'vscode'

let curPanel: Vsc.WebviewPanel | undefined

let history: string[] = ['#em-top']
let histIdx = 0

export function top() {
    push('#em-top')
    goto('#em-top')
}

export function next() {
    if (histIdx == history.length - 1) return
    histIdx += 1
    goto(history[histIdx])
}

export function prev() {
    if (histIdx == 0) return
    histIdx -= 1
    goto(history[histIdx])
}

export async function show() {
    const panel = Vsc.window.createWebviewPanel(
        'embuilder.grammar',
        'EM•Script',
        Vsc.ViewColumn.Active,
        { enableScripts: true }
    )
    curPanel = panel
    let html = await Utils.readText(Vsc.Uri.joinPath(Utils.rootUri(), 'grammar.html'))
    html = html.replace(
        /<script\b[^>]*>[\s\S]*?<\/script>/i,
        `
<script>
    const vscode = acquireVsCodeApi()
    document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button[data-em]')
        if (btn) {
            vscode.postMessage({ kind: 'cmd', id: btn.getAttribute('data-em') })
            e.preventDefault()
            e.stopPropagation()
            return
        }

        const a = e.target?.closest?.('a')
        if (!a) return

        const href =
            a.getAttribute('href') ??
            a.getAttribute('xlink:href') ??
            a.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href')
        if (!href || !href.startsWith('#')) return

        e.preventDefault()
        e.stopPropagation()

        const id = href.slice(1)
        const el = document.getElementById(id)
        if (!el) return

        el.scrollIntoView({ block: 'start', inline: 'nearest' })
        vscode.postMessage({ kind: 'nav', hash: href })
        try { history.replaceState(null, '', href) } catch {}
    }, true)
</script>`
    )
    html = html.replace(
        /<\/script>/i,
        `\n/* goto handler */\nwindow.addEventListener('message', (e) => {\n    const msg = e.data\n    if (msg?.kind !== 'goto') return\n    if (msg.hash === '#em-top') {\n        window.scrollTo({ top: 0, left: 0, behavior: 'instant' })\n        return\n    }\n    const hash = msg.hash\n    if (!hash || hash[0] !== '#') return\n    const el = document.getElementById(hash.slice(1))\n    if (el) el.scrollIntoView({ block: 'start', inline: 'nearest' })\n})\n\n</script>`
    )
    const extUri = Vsc.extensions.getExtension(Utils.EXT_ID)!.extensionUri
    const backSVG = await Utils.readText(Vsc.Uri.joinPath(extUri, 'icons', 'back.svg'))
    const nextSVG = await Utils.readText(Vsc.Uri.joinPath(extUri, 'icons', 'next.svg'))
    const topSVG = await Utils.readText(Vsc.Uri.joinPath(extUri, 'icons', 'top.svg'))
    html = html.replace(
        /<body(\s[^>]*)?>/i,
        (m) => `${m}
<style>
    body {
        margin: 0;
        padding: 0;
        background: var(--vscode-editor-background);
    }

    /* create space ABOVE headers (not below) */
    .diagramHeader {
        scroll-margin-top: 24px;
    }
    #em-top { scroll-margin-top: 36px; }

    /* remove extra gap that railroad-diagram CSS often adds below headers */
    .diagramHeader + svg.railroad-diagram {
        margin-top: 6px;
    }

    .em-nav {
        position: fixed;
        top: 2px;
        left: 2px;
        z-index: 9999;
        display: flex;
        gap: 6px;
        user-select: none;
    }
    .em-nav button {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4px;
        border-radius: 6px;
        background: transparent;
        border: 1px solid var(--vscode-button-border, transparent);
        cursor: pointer;
    }
    .em-nav button:hover {
        background: var(--vscode-toolbar-hoverBackground);
    }
    .em-nav svg {
        width: 16px;
        height: 16px;
        display: block;
    }
    .em-nav button { width: 28px; height: 28px; }
    .em-nav svg { width: 18px; height: 18px; }

    svg.railroad-diagram rect[fill='white'],
    svg.railroad-diagram rect[fill='#fff'],
    svg.railroad-diagram rect[fill='#ffffff'] {
        fill: var(--vscode-editor-background);
    }
</style>
<div class='em-nav'>
    <button data-em='prev' title='Back'>
        ${backSVG}
    </button>
    <button data-em='top' title='Top'>
        ${topSVG}
    </button>
    <button data-em='next' title='Next'>
        ${nextSVG}
    </button>
</div>
<div id='em-top'></div>
`
    )
    panel.webview.html = html
    panel.reveal(Vsc.ViewColumn.One, true)
    await Vsc.commands.executeCommand('workbench.action.pinEditor')

    panel.webview.onDidReceiveMessage((msg) => {
        if (msg!.kind == 'cmd') {
            if (msg.id == 'top') top()
            else if (msg.id == 'next') next()
            else if (msg.id == 'prev') prev()
            return
        }
        if (msg?.kind !== 'nav') return
        const hash = String(msg.hash ?? '')
        if (!hash.startsWith('#')) return
        push(hash)
    })
}

function push(anchor: string) {
    if (history[histIdx] === anchor) return
    if (histIdx < history.length - 1) {
        history = history.slice(0, histIdx + 1)
    }
    history.push(anchor)
    histIdx += 1
}

function goto(anchor: string) {
    curPanel!.webview.postMessage({ kind: 'goto', hash: anchor })
}
