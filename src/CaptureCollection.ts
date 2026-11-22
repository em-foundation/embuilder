import * as Fs from 'fs/promises'
import * as Path from 'path'

export const FOLDER_NAME = 'emscope-captures'
export const LEGACY_FOLDER_NAME = 'em-captures'
export const CONFIG_NAME = 'emscope.json'

export interface Settings {
    version: 1
    workload_period_ms: number
}

export const DEFAULTS: Readonly<Settings> = Object.freeze({ version: 1, workload_period_ms: 1000 })

export function isFolderName(name: string): boolean {
    return name === FOLDER_NAME || name === LEGACY_FOLDER_NAME
}

export function defaultFolder(project: string): string {
    return Path.join(project, 'workspace', 'em.prog', 'em.benchmark.coremark', FOLDER_NAME)
}

export function identifier(project: string, folder: string): string | undefined {
    const relative = Path.relative(Path.join(project, 'workspace'), folder)
    if (Path.isAbsolute(relative)) return
    const parts = relative.split(Path.sep)
    if (parts.length !== 3 || parts.some(part => !part || part === '.' || part === '..') || !isFolderName(parts[2])) return
    return parts[0] + ':' + parts[1]
}

export async function readSettings(folder: string): Promise<Settings> {
    let text: string
    try { text = await Fs.readFile(Path.join(folder, CONFIG_NAME), 'utf8') }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS }
        throw err
    }
    const config: unknown = JSON.parse(text)
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('Collection settings must contain a JSON object.')
    }
    const saved = config as Partial<Settings>
    if (saved.version !== undefined && saved.version !== DEFAULTS.version) {
        throw new Error('Unsupported Capture Collection settings version.')
    }
    const period = saved.workload_period_ms ?? DEFAULTS.workload_period_ms
    if (period !== 1000) {
        throw new Error('EM•Scope currently supports only a 1000 ms workload period.')
    }
    return { version: 1, workload_period_ms: period }
}
