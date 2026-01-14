import * as Vsc from 'vscode'

type SemTokFile = {
    version: 1
    srcRel: string
    srcMtimeMs: number
    srcSize: number
    tokTypes: string[]
    tokens: number[]
}

export function legend(): Vsc.SemanticTokensLegend {
    return new Vsc.SemanticTokensLegend(
        ['em-debug', 'em-deref', 'em-domain', 'em-ident', 'em-special', 'em-unit', 'em-wrong'],
        []
    )
}

function defaultSemTokOutName(srcRel: string): string {
    return srcRel
        .replace(/\\/g, '/')
        .replace(/\.em\.ts$/, '')
        .split('/')
        .join('-') + '.json'
}

async function readSemTok(uri: Vsc.Uri): Promise<SemTokFile | undefined> {
    try {
        const data = await Vsc.workspace.fs.readFile(uri)
        const txt = new TextDecoder('utf-8').decode(data)
        const obj = JSON.parse(txt) as SemTokFile
        return obj?.version === 1 ? obj : undefined
    } catch {
        return
    }
}

export class Provider implements Vsc.DocumentSemanticTokensProvider {
    async provideDocumentSemanticTokens(
        doc: Vsc.TextDocument
    ): Promise<Vsc.SemanticTokens> {
        const wf = Vsc.workspace.getWorkspaceFolder(doc.uri)
        const builder = new Vsc.SemanticTokensBuilder(legend())
        if (!wf) return builder.build()

        const srcRel = Vsc.workspace.asRelativePath(doc.uri, false).slice('workspace/'.length)
        const semtokUri = Vsc.Uri.joinPath(
            wf.uri,
            '.semtok',
            defaultSemTokOutName(srcRel)
        )

        const meta = await readSemTok(semtokUri)

        if (!meta) return builder.build()

        for (let i = 0; i + 2 < meta.tokens.length; i += 3) {
            const start = meta.tokens[i]
            const length = meta.tokens[i + 1]
            const typeIndex = meta.tokens[i + 2]
            const tokType = meta.tokTypes[typeIndex]
            if (!tokType) continue

            const range = new Vsc.Range(
                doc.positionAt(start),
                doc.positionAt(start + length)
            )
            builder.push(range, tokType)
        }

        return builder.build()
    }
}
